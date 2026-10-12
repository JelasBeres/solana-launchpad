/**
 * Simulates create / buy / sell transactions against the live mainnet pump.fun program
 * without signing or spending anything (simulateTransaction with sigVerify: false).
 *
 *   SOLANA_RPC_URL=<mainnet rpc> npx tsx scripts/simulate-mainnet.ts
 */
import { createHash } from "crypto";
import BN from "bn.js";
import { Connection, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { PUMP_PROGRAM_ID, PUMP_SDK } from "@pump-fun/pump-sdk";
import {
  buildBuyTx,
  buildCreateTokenTx,
  buildSellTx,
  fetchCurveSnapshot,
  fetchOnchainMetadata,
  fetchProtocolState,
  fetchTokenBalance,
  getMintTokenProgram,
  graduationTargetSol,
  quoteBuy,
} from "../src/lib/pump";

const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const TRADE_EVENT = createHash("sha256").update("event:TradeEvent").digest().subarray(0, 8);

async function simulate(label: string, tx: Transaction, feePayer: PublicKey) {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer;
  const encoded = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const res = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [encoded, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }],
    }),
  }).then((r) => r.json());
  const value = res.result?.value;
  const ok = value && !value.err;
  console.log(`${ok ? "✔" : "✘"} ${label}: ${ok ? `ok, ${value.unitsConsumed} CU` : JSON.stringify(value?.err ?? res.error)}`);
  if (!ok) console.log((value?.logs || []).slice(-12).join("\n"));
  return ok;
}

async function findRecentTrade() {
  const sigs = await connection.getSignaturesForAddress(PUMP_PROGRAM_ID, { limit: 40 });
  for (const s of sigs) {
    if (s.err) continue;
    await new Promise((r) => setTimeout(r, 400)); // stay under public RPC rate limits
    const tx = await fetch(connection.rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [s.signature, { encoding: "base64", maxSupportedTransactionVersion: 1 }] }),
    }).then((r) => r.json());
    for (const line of (tx.result?.meta?.logMessages as string[]) || []) {
      if (!line.startsWith("Program data: ")) continue;
      const data = Buffer.from(line.slice(14), "base64");
      if (!data.subarray(0, 8).equals(TRADE_EVENT)) continue;
      const ev = PUMP_SDK.decodeTradeEventBc(data.subarray(8));
      // Skip mayhem coins: their curves use different reserves than a normal launch
      if (ev.isBuy && !ev.mayhemMode) return { mint: ev.mint, trader: ev.user };
    }
  }
  throw new Error("No recent pump.fun buy found");
}

async function main() {
  const state = await fetchProtocolState(connection);
  console.log("createV2Enabled:", state.global.createV2Enabled, "| creatorFeeConfigurable:", state.global.creatorFeeConfigurable, "| maxCreatorFeeBps:", state.global.maxConfigurableCreatorFeeBps.toString());
  console.log("graduation target:", graduationTargetSol(state.global).toFixed(2), "SOL");

  // SIM_MINT / SIM_TRADER skip the discovery step (handy when the public RPC rate-limits)
  const { mint, trader } =
    process.env.SIM_MINT && process.env.SIM_TRADER
      ? { mint: new PublicKey(process.env.SIM_MINT), trader: new PublicKey(process.env.SIM_TRADER) }
      : await findRecentTrade();
  console.log("sample coin:", mint.toBase58(), "| sample trader:", trader.toBase58());
  console.log("trader balance:", (await connection.getBalance(trader)) / LAMPORTS_PER_SOL, "SOL");

  const tokenProgram = await getMintTokenProgram(connection, mint);
  console.log("metadata:", await fetchOnchainMetadata(connection, mint, tokenProgram));
  const snap = await fetchCurveSnapshot(connection, mint, state.global);
  console.log(`curve: price=${snap?.priceSol.toExponential(4)} SOL, mcap=${snap?.marketCapSol.toFixed(2)} SOL, progress=${snap?.progressPercent.toFixed(2)}%, complete=${snap?.complete}`);
  if (snap) console.log("quote 0.01 SOL ->", quoteBuy(state, snap.bondingCurve, new BN(0.01 * LAMPORTS_PER_SOL)).toString(), "base units");

  // Use the recent buyer as a stand-in wallet (it has SOL); nothing is signed or sent.
  if (snap && !snap.complete) {
    await simulate("buy 0.01 SOL", await buildBuyTx({ connection, user: trader, mint, solAmount: new BN(0.01 * LAMPORTS_PER_SOL), slippagePercent: 5 }), trader);
    const held = await fetchTokenBalance(connection, trader, mint);
    if (held.raw.gtn(0)) {
      await simulate("sell 10% of holdings", await buildSellTx({ connection, user: trader, mint, tokenAmount: held.raw.divn(10), slippagePercent: 5 }), trader);
    } else {
      console.log("(trader holds none of this coin now, skipping sell simulation)");
    }
  }

  for (const [label, devBuy, name] of [
    ["create_v2 (no dev buy)", 0, "Simulation Only"],
    ["create_v2 + 0.01 SOL dev buy", 0.01, "Simulation Only"],
    ["create_v2 + dev buy, 32-char name", 0.01, "Simulation Only Max Length Name!"],
  ] as const) {
    const { tx } = await buildCreateTokenTx({
      connection,
      user: trader,
      name,
      symbol: "SIMULATE10",
      metadataUri: "https://ipfs.io/ipfs/bafkreigx3f5u3xzh3k6xq4d3y2zfr6r6cbfm3j3p2kq7m3gq4t5v3vynxe",
      devBuyLamports: new BN(devBuy * LAMPORTS_PER_SOL),
    });
    const hasBudget = tx.instructions.some((ix) => ix.programId.toBase58().startsWith("ComputeBudget"));
    await simulate(`${label}${hasBudget ? "" : " [no priority fee]"}`, tx, trader);
    await new Promise((r) => setTimeout(r, 1500));
    console.log("  tx size:", tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length, "bytes (max 1232)");
  }
}

main().catch((err) => {
  console.error("✘", err?.message || err);
  process.exit(1);
});
