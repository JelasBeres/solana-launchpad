import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Browser -> server JSON-RPC proxy for Robinhood Chain. Some ISPs (e.g. Indonesian DNS filtering)
 * block the public RPC domain, so browsers talk to this app instead. Read-only methods only:
 * transactions are signed and broadcast by the user's wallet.
 */
const ALLOWED_METHODS = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
]);

const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH = 30;
const RATE_LIMIT_PER_MINUTE = 900;
const hits = new Map<string, { windowStart: number; count: number }>();

function rpcUrl(): string {
  return process.env.ROBINHOOD_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
}

function rateLimited(ip: string, cost: number): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart > 60_000) {
    hits.set(ip, { windowStart: now, count: cost });
    if (hits.size > 10_000) hits.clear();
    return false;
  }
  entry.count += cost;
  return entry.count > RATE_LIMIT_PER_MINUTE;
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, { status: 413 });
  }

  let payload: { id?: unknown; method?: string } | { id?: unknown; method?: string }[];
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }

  const calls = Array.isArray(payload) ? payload : [payload];
  if (calls.length === 0 || calls.length > MAX_BATCH) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid batch size" } }, { status: 400 });
  }
  const blocked = calls.find((c) => !c.method || !ALLOWED_METHODS.has(c.method));
  if (blocked) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: blocked.id ?? null, error: { code: -32601, message: `Method not allowed: ${blocked.method}` } },
      { status: 403 }
    );
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  if (rateLimited(ip, calls.length)) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: 429, message: "Too many requests" } }, { status: 429 });
  }

  try {
    const upstream = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await upstream.text();
    return new NextResponse(body, { status: upstream.status, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream RPC error";
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message } }, { status: 502 });
  }
}
