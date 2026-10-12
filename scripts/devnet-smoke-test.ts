/**
 * Devnet smoke test: create a pump.fun coin, buy, sell and claim creator fees
 * with the same helpers the app uses (src/lib/pump.ts).
 *
 *   npx tsx scripts/devnet-smoke-test.ts /path/to/devnet-wallet.json
 *
 * The wallet file is created (and airdropped devnet SOL) if it does not exist.
 */
import fs from "fs";
import BN from "bn.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  buildBuyTx,
  buildClaimCreatorFeesTx,
  buildCreateTokenTx,
  buildSellTx,
  fetchCreatorFeeBalance,
  fetchCurveSnapshot,
  fetchOnchainMetadata,
  fetchProtocolState,
  fetchTokenBalance,
  getMintTokenProgram,
} from "../src/lib/pump";

const walletPath = process.argv[2];
if (!walletPath) throw new Error("Usage: npx tsx scripts/devnet-smoke-test.ts <wallet.json>");

const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const wallet = fs.existsSync(walletPath)
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))))
  : Keypair.generate();
fs.writeFileSync(walletPath, JSON.stringify(Array.from(wallet.secretKey)));

async function send(label: string, tx: Transaction, extra: Keypair[] = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet, ...extra);
  const sig = await connection.sendRawTransaction(tx.serialize());
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)}`);
  console.log(`✔ ${label}: https://solscan.io/tx/${sig}?cluster=devnet`);
  return sig;
}

async function main() {
  console.log("wallet:", wallet.publicKey.toBase58());
  let balance = await connection.getBalance(wallet.publicKey);
  if (balance < 0.5 * LAMPORTS_PER_SOL) {
    console.log("requesting devnet airdrop...");
    const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    balance = await connection.getBalance(wallet.publicKey);
  }
  console.log("balance:", balance / LAMPORTS_PER_SOL, "SOL");

  const state = await fetchProtocolState(connection);
  console.log("createV2Enabled:", state.global.createV2Enabled, "| creatorFeeConfigurable:", state.global.creatorFeeConfigurable);

  // 1. Create + dev buy 0.05 SOL
  const { tx, mint } = await buildCreateTokenTx({
    connection,
    user: wallet.publicKey,
    name: "Lockey Smoke Test",
    symbol: "LKTEST",
    metadataUri: "https://ipfs.io/ipfs/bafkreigx3f5u3xzh3k6xq4d3y2zfr6r6cbfm3j3p2kq7m3gq4t5v3vynxe",
    devBuyLamports: new BN(0.05 * LAMPORTS_PER_SOL),
  });
  await send("create_v2 + dev buy", tx, [mint]);
  console.log("mint:", mint.publicKey.toBase58());

  const tokenProgram = await getMintTokenProgram(connection, mint.publicKey);
  console.log("token program:", tokenProgram.toBase58());
  console.log("metadata:", await fetchOnchainMetadata(connection, mint.publicKey, tokenProgram));

  const logSnap = async (label: string) => {
    const snap = await fetchCurveSnapshot(connection, mint.publicKey, state.global);
    const bal = await fetchTokenBalance(connection, wallet.publicKey, mint.publicKey);
    console.log(
      `${label}: price=${snap?.priceSol.toExponential(4)} SOL, mcap=${snap?.marketCapSol.toFixed(2)} SOL, ` +
        `progress=${snap?.progressPercent.toFixed(3)}%, raised=${snap?.realSolReserves.toFixed(4)} SOL, held=${bal.ui.toLocaleString()}`
    );
    return bal;
  };
  await logSnap("after create");

  // 2. Buy 0.1 SOL
  await send("buy 0.1 SOL", await buildBuyTx({ connection, user: wallet.publicKey, mint: mint.publicKey, solAmount: new BN(0.1 * LAMPORTS_PER_SOL), slippagePercent: 5 }));
  const held = await logSnap("after buy");

  // 3. Sell half
  await send("sell 50%", await buildSellTx({ connection, user: wallet.publicKey, mint: mint.publicKey, tokenAmount: held.raw.divn(2), slippagePercent: 5 }));
  await logSnap("after sell");

  // 4. Creator fees
  const fees = await fetchCreatorFeeBalance(connection, wallet.publicKey);
  console.log("claimable creator fees:", fees.toNumber() / LAMPORTS_PER_SOL, "SOL");
  if (fees.gtn(0)) await send("claim creator fees", await buildClaimCreatorFeesTx(connection, wallet.publicKey));

  console.log("\nDone. Token page: /token/" + mint.publicKey.toBase58());
}

main().catch((err) => {
  console.error("✘", err?.message || err);
  if (err?.logs) console.error(err.logs.join("\n"));
  process.exit(1);
});
