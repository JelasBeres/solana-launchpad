import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { PUMP_SDK, bondingCurvePda } from "@pump-fun/pump-sdk";
import { getServerRpcUrl, PUMP_TOTAL_SUPPLY, SOL_DECIMALS, TOKEN_DECIMALS } from "@/config/solana";

export const dynamic = "force-dynamic";

export interface TradeRecord {
  id: string;
  type: "BUY" | "SELL";
  timestamp: number; // ms
  txHash: string;
  trader: string;
  quoteAmount: number; // SOL
  tokenAmount: number;
  price: number; // SOL per token, after the trade
  marketCap: number; // SOL
}

// Anchor event discriminator: sha256("event:TradeEvent")[0..8]
const TRADE_EVENT_DISCRIMINATOR = createHash("sha256").update("event:TradeEvent").digest().subarray(0, 8);

const CACHE_TTL_MS = 8000;
const MAX_TRADES_KEPT = 300;
// Raw JSON-RPC so any transaction version decodes: only meta.logMessages is needed
const MAX_TX_VERSION = 1;
// Per-mint cache; refreshes only fetch signatures newer than the newest one already seen
const cache = new Map<string, { at: number; trades: TradeRecord[]; newestSig?: string }>();

function parseTrades(signature: string, logs: string[], mint: PublicKey): TradeRecord[] {
  const out: TradeRecord[] = [];
  logs.forEach((line, i) => {
    if (!line.startsWith("Program data: ")) return;
    const data = Buffer.from(line.slice("Program data: ".length), "base64");
    if (data.length < 8 || !data.subarray(0, 8).equals(TRADE_EVENT_DISCRIMINATOR)) return;
    try {
      const ev = PUMP_SDK.decodeTradeEventBc(data.subarray(8));
      if (!ev.mint.equals(mint)) return;
      const vSol = Number(ev.virtualSolReserves.toString()) / 10 ** SOL_DECIMALS;
      const vTok = Number(ev.virtualTokenReserves.toString()) / 10 ** TOKEN_DECIMALS;
      const price = vTok > 0 ? vSol / vTok : 0;
      out.push({
        id: `${signature}-${i}`,
        type: ev.isBuy ? "BUY" : "SELL",
        timestamp: Number(ev.timestamp.toString()) * 1000,
        txHash: signature,
        trader: ev.user.toBase58(),
        quoteAmount: Number(ev.solAmount.toString()) / 10 ** SOL_DECIMALS,
        tokenAmount: Number(ev.tokenAmount.toString()) / 10 ** TOKEN_DECIMALS,
        price,
        marketCap: price * PUMP_TOTAL_SUPPLY,
      });
    } catch {
      // Unknown event layout, skip
    }
  });
  return out;
}

async function fetchLogs(rpcUrl: string, signature: string): Promise<string[] | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: MAX_TX_VERSION }],
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || "RPC error");
  return body.result?.meta?.logMessages ?? null;
}

export async function GET(req: NextRequest) {
  const mintParam = req.nextUrl.searchParams.get("mint") || "";
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintParam);
  } catch {
    return NextResponse.json({ error: "Invalid mint address" }, { status: 400 });
  }

  const key = mint.toBase58();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ success: true, trades: hit.trades, cached: true });
  }

  try {
    const rpcUrl = getServerRpcUrl();
    const connection = new Connection(rpcUrl, "confirmed");
    const sigs = await connection.getSignaturesForAddress(bondingCurvePda(mint), {
      limit: 60,
      until: hit?.newestSig,
    });
    const okSigs = sigs.filter((s) => !s.err).map((s) => s.signature);

    const fresh: TradeRecord[] = [];
    let anyFailed = false;
    // Small parallel chunks keep public RPC endpoints from rate limiting us
    for (let i = 0; i < okSigs.length; i += 6) {
      const chunk = okSigs.slice(i, i + 6);
      const logsList = await Promise.all(chunk.map((sig) => fetchLogs(rpcUrl, sig).catch(() => undefined)));
      logsList.forEach((logs, j) => {
        if (logs === undefined) anyFailed = true;
        else if (logs) fresh.push(...parseTrades(chunk[j], logs, mint));
      });
    }

    const seen = new Set((hit?.trades ?? []).map((t) => t.id));
    const trades = [...(hit?.trades ?? []), ...fresh.filter((t) => !seen.has(t.id))]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-MAX_TRADES_KEPT);

    // Only move the cursor forward when every transaction was read, so rate-limited ones are retried
    const newestSig = anyFailed ? hit?.newestSig : sigs[0]?.signature ?? hit?.newestSig;
    cache.set(key, { at: Date.now(), trades, newestSig });
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    return NextResponse.json({ success: true, trades });
  } catch (err: unknown) {
    console.error("Trade history fetch failed:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch trades";
    // Serve stale data rather than an empty chart when the RPC rate-limits us
    if (hit) return NextResponse.json({ success: true, trades: hit.trades, stale: true });
    return NextResponse.json({ success: false, error: message, trades: [] }, { status: 502 });
  }
}
