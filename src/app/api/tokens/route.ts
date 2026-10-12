import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { bondingCurvePda } from "@pump-fun/pump-sdk";
import { createPublicClient, http, isAddress, getAddress } from "viem";
import { getServerRpcUrl } from "@/config/solana";
import { CONTRACT_ADDRESSES, robinhoodChain } from "@/config/chain";
import { PONS_FACTORY_ABI } from "@/config/abis";

export interface PlatformTokenRecord {
  chain: "solana" | "robinhood";
  token: string; // Solana mint or EVM token address
  curve: string; // bonding curve PDA / Pons curve contract
  deployer: string;
  name: string;
  symbol: string;
  logo?: string;
  description?: string;
  metadataUri?: string;
  txHash?: string;
  createdAt: string;
}

const DATA_FILE_PATH = path.join(process.cwd(), "src", "data", "platform-tokens.json");

async function readTokens(): Promise<PlatformTokenRecord[]> {
  try {
    const data = await fs.readFile(DATA_FILE_PATH, "utf-8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("Could not read platform-tokens.json, returning empty list:", err);
    return [];
  }
}

async function saveTokens(tokens: PlatformTokenRecord[]): Promise<void> {
  const dir = path.dirname(DATA_FILE_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(DATA_FILE_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

function parsePublicKey(value: unknown): PublicKey | null {
  if (typeof value !== "string") return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

// Only accept mints that really have a pump.fun bonding curve (retries cover RPC nodes lagging behind)
async function curveExists(mint: PublicKey): Promise<boolean> {
  const connection = new Connection(getServerRpcUrl(), "confirmed");
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await connection.getAccountInfo(bondingCurvePda(mint));
    if (info) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// Robinhood: only accept tokens the Pons v2 factory actually launched
async function ponsLaunchRecord(token: `0x${string}`): Promise<{ exists: boolean; curve: string }> {
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: http(process.env.ROBINHOOD_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || undefined),
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const record = (await client.readContract({
      address: CONTRACT_ADDRESSES.factory,
      abi: PONS_FACTORY_ABI,
      functionName: "getLaunchedToken",
      args: [token],
    })) as { exists: boolean; curve: string };
    if (record.exists) return record;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { exists: false, curve: "" };
}

export async function GET() {
  try {
    const tokens = await readTokens();
    return NextResponse.json({ success: true, tokens });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch platform tokens";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let chain: PlatformTokenRecord["chain"];
    let tokenId: string;
    let curve: string;
    let deployerStr = "";

    if (typeof body.token === "string" && body.token.startsWith("0x")) {
      if (!isAddress(body.token)) {
        return NextResponse.json({ success: false, error: "Invalid token address" }, { status: 400 });
      }
      const record = await ponsLaunchRecord(getAddress(body.token));
      if (!record.exists) {
        return NextResponse.json({ success: false, error: "Token was not launched by the Pons v2 factory" }, { status: 400 });
      }
      chain = "robinhood";
      tokenId = body.token.toLowerCase();
      curve = record.curve.toLowerCase();
      if (typeof body.deployer === "string" && isAddress(body.deployer)) deployerStr = body.deployer.toLowerCase();
    } else {
      const mint = parsePublicKey(body.token);
      if (!mint) {
        return NextResponse.json({ success: false, error: "Invalid mint address" }, { status: 400 });
      }
      if (!(await curveExists(mint))) {
        return NextResponse.json({ success: false, error: "No pump.fun bonding curve found for this mint" }, { status: 400 });
      }
      chain = "solana";
      tokenId = mint.toBase58();
      curve = bondingCurvePda(mint).toBase58();
      deployerStr = parsePublicKey(body.deployer)?.toBase58() ?? "";
    }

    const tokens = await readTokens();
    const existingIndex = tokens.findIndex((t) => t.token === tokenId);

    const newRecord: PlatformTokenRecord = {
      chain,
      token: tokenId,
      curve,
      deployer: deployerStr,
      name: str(body.name, 32),
      symbol: str(body.symbol, 10),
      logo: str(body.logo, 500),
      description: str(body.description, 1000),
      metadataUri: str(body.metadataUri, 500),
      txHash: str(body.txHash, 100),
      createdAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      tokens[existingIndex] = {
        ...tokens[existingIndex],
        ...newRecord,
        createdAt: tokens[existingIndex].createdAt || newRecord.createdAt,
      };
    } else {
      tokens.unshift(newRecord);
    }

    await saveTokens(tokens);
    return NextResponse.json({ success: true, record: newRecord });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to save platform token";
    console.error("Error saving platform token:", err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

// Removing tokens requires the x-admin-secret header to match ADMIN_SECRET (disabled when unset)
export async function DELETE(req: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret || req.headers.get("x-admin-secret") !== adminSecret) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const token = req.nextUrl.searchParams.get("token");
    if (!token) {
      return NextResponse.json({ success: false, error: "Missing ?token= parameter" }, { status: 400 });
    }
    const tokens = await readTokens();
    const filtered = tokens.filter((t) => t.token !== token && t.token !== token.toLowerCase());
    await saveTokens(filtered);
    return NextResponse.json({ success: true, removed: tokens.length - filtered.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to delete token";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
