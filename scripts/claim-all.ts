/**
 * Claim creator fees from many creator wallets and forward them to ONE destination wallet.
 *
 *   npx tsx scripts/claim-all.ts                 # dry run: only shows what is claimable
 *   npx tsx scripts/claim-all.ts --execute       # claims + forwards to the destination wallets
 *   npx tsx scripts/claim-all.ts --config other.json --only solana|robinhood
 *
 * Wallets come from claim-wallets.json (git-ignored, see claim-wallets.example.json). Private keys never leave
 * this machine and are never printed.
 *
 * Solana (pump.fun): collect creator vault fees (pump.fun + PumpSwap), then send exactly the claimed SOL to the destination.
 *   If `payerKey` (the destination's key) is set, it pays every network fee, so creator wallets can sit at 0 SOL.
 * Robinhood (Pons v2): for each token the wallet launched, sweepFees(0) on curves holding creator tax, claim() the
 *   FeeEscrow, then send the claimed ETH to the destination. Creator wallets need a little ETH for gas.
 *
 * RPC: SOLANA_RPC_URL / ROBINHOOD_RPC_URL env vars (public endpoints by default; some Indonesian ISPs DNS-block
 * the Robinhood RPC, so use a VPN, 1.1.1.1 DNS, or run this on the VPS).
 */
import fs from "fs";
import path from "path";
import bs58 from "bs58";
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseAbiItem,
  parseEther,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACT_ADDRESSES, robinhoodChain } from "../src/config/chain";
import { PONS_CURVE_ABI, PONS_FACTORY_ABI, PONS_FEE_ESCROW_ABI } from "../src/config/abis";

// ─── Config ──────────────────────────────────────────────────────────────────

interface ClaimConfig {
  solana?: { destination: string; payerKey?: string; creatorKeys: string[] };
  robinhood?: { destination: string; creatorKeys: string[] };
}

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const CONFIG_PATH = path.resolve(args.includes("--config") ? args[args.indexOf("--config") + 1] : "claim-wallets.json");

const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const ROBINHOOD_RPC = process.env.ROBINHOOD_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

// Below these, claiming costs more in fees than it returns
const MIN_SOL_CLAIM = 0.0005;
const MIN_ETH_CLAIM = parseEther("0.00005");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

function loadConfig(): ClaimConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}\nCopy claim-wallets.example.json to claim-wallets.json and fill in your wallets.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

/** Accepts a Phantom-style base58 secret or a JSON byte array (solana-keygen file contents). */
function solanaKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  const bytes = trimmed.startsWith("[") ? Uint8Array.from(JSON.parse(trimmed)) : bs58.decode(trimmed);
  return Keypair.fromSecretKey(bytes);
}

// ─── Solana (pump.fun) ───────────────────────────────────────────────────────

async function sendSolanaTx(connection: Connection, ixs: TransactionInstruction[], payer: Keypair, signers: Keypair[]) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ...ixs);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  const uniqueSigners = [payer, ...signers].filter((k, i, arr) => arr.findIndex((x) => x.publicKey.equals(k.publicKey)) === i);
  tx.sign(...uniqueSigners);
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`);
  return sig;
}

async function runSolana(cfg: NonNullable<ClaimConfig["solana"]>) {
  console.log(`\n=== Solana (pump.fun) → destination ${cfg.destination} ===`);
  const connection = new Connection(SOLANA_RPC, "confirmed");
  const sdk = new OnlinePumpSdk(connection);
  const destination = new PublicKey(cfg.destination);
  const payer = cfg.payerKey ? solanaKeypair(cfg.payerKey) : null;
  if (payer && !payer.publicKey.equals(destination)) {
    console.log(`(payerKey belongs to ${short(payer.publicKey.toBase58())}, it pays all network fees)`);
  }

  let total = 0;
  for (const secret of cfg.creatorKeys) {
    const creator = solanaKeypair(secret);
    const addr = creator.publicKey.toBase58();
    try {
      const claimable = (await sdk.getCreatorVaultBalanceBothPrograms(creator.publicKey)).toNumber() / LAMPORTS_PER_SOL;
      total += claimable;
      console.log(`${short(addr)}  claimable ${claimable.toFixed(6)} SOL`);
      if (!EXECUTE || claimable < MIN_SOL_CLAIM) {
        if (EXECUTE) console.log(`   skip: below ${MIN_SOL_CLAIM} SOL`);
        continue;
      }

      const feePayer = payer ?? creator;
      const before = await connection.getBalance(creator.publicKey);
      const claimIxs = await sdk.collectCoinCreatorFeeInstructions(creator.publicKey, feePayer.publicKey);
      const claimSig = await sendSolanaTx(connection, claimIxs, feePayer, [creator]);
      console.log(`   claimed: https://solscan.io/tx/${claimSig}`);

      // Forward only what the claim added (the creator's own SOL stays put)
      const after = await connection.getBalance(creator.publicKey);
      const transferFee = payer ? 0 : 10_000; // claim tx fee is already reflected in `after`
      const lamports = after - before - transferFee;
      if (lamports <= 0) {
        console.log("   nothing to forward after fees");
        continue;
      }
      const sendSig = await sendSolanaTx(
        connection,
        [SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: destination, lamports })],
        feePayer,
        [creator]
      );
      console.log(`   sent ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL → ${short(cfg.destination)}: https://solscan.io/tx/${sendSig}`);
    } catch (err) {
      console.log(`   ✘ ${short(addr)}: ${(err as Error).message.split("\n")[0]}`);
    }
    await sleep(600); // public RPC rate limits
  }
  console.log(`Solana total claimable: ${total.toFixed(6)} SOL`);
}

// ─── Robinhood (Pons v2) ─────────────────────────────────────────────────────

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const LOG_WINDOW = 10_000_000n; // RPC cap per eth_getLogs
const TOKEN_LAUNCHED = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)"
);

async function runRobinhood(cfg: NonNullable<ClaimConfig["robinhood"]>) {
  console.log(`\n=== Robinhood (Pons v2) → destination ${cfg.destination} ===`);
  if (!isAddress(cfg.destination)) throw new Error("robinhood.destination is not a valid 0x address");
  const destination = getAddress(cfg.destination);
  const client = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC) });
  const latest = await client.getBlockNumber();

  let totalEscrow = 0n;
  let totalPending = 0n;
  for (const rawKey of cfg.creatorKeys) {
    const account = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex);
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(ROBINHOOD_RPC) });
    const addr = account.address;
    try {
      // Tokens this wallet launched (TokenLaunched logs by deployer, newest window first)
      const tokens = new Set<`0x${string}`>();
      for (let to = latest; ; to -= LOG_WINDOW) {
        const from = to >= LOG_WINDOW ? to - LOG_WINDOW + 1n : 0n;
        const logs = await client.getLogs({ address: CONTRACT_ADDRESSES.factory, event: TOKEN_LAUNCHED, args: { deployer: addr }, fromBlock: from, toBlock: to });
        logs.forEach((l) => l.args.token && tokens.add(getAddress(l.args.token)));
        if (from === 0n) break;
      }

      const list = [...tokens];
      const records = list.length
        ? await client.multicall({
            multicallAddress: MULTICALL3,
            contracts: list.map((t) => ({ address: CONTRACT_ADDRESSES.factory, abi: PONS_FACTORY_ABI, functionName: "getLaunchedToken", args: [t] }) as const),
          })
        : [];
      const curves = records
        .map((r) => r.result as { curve: `0x${string}`; creatorFeeRecipient: string; exists: boolean } | undefined)
        .filter((r): r is { curve: `0x${string}`; creatorFeeRecipient: string; exists: boolean } => !!r?.exists && r.creatorFeeRecipient.toLowerCase() === addr.toLowerCase())
        .map((r) => r.curve);
      const pendings = curves.length
        ? await client.multicall({
            multicallAddress: MULTICALL3,
            contracts: curves.map((c) => ({ address: c, abi: PONS_CURVE_ABI, functionName: "creatorTaxBalance" }) as const),
          })
        : [];
      const pendingByCurve = curves.map((c, i) => ({ curve: c, pending: (pendings[i].result as bigint | undefined) ?? 0n }));
      const pending = pendingByCurve.reduce((a, x) => a + x.pending, 0n);
      const escrow = await client.readContract({ address: CONTRACT_ADDRESSES.feeEscrow, abi: PONS_FEE_ESCROW_ABI, functionName: "balanceOf", args: [addr] });
      const ethBalance = await client.getBalance({ address: addr });
      totalEscrow += escrow;
      totalPending += pending;

      console.log(
        `${short(addr)}  ${list.length} launches | on curves (needs sweep) ${formatEther(pending)} ETH | in escrow ${formatEther(escrow)} ETH | gas balance ${formatEther(ethBalance)} ETH`
      );
      if (!EXECUTE) continue;
      if (pending + escrow < MIN_ETH_CLAIM) {
        console.log(`   skip: below ${formatEther(MIN_ETH_CLAIM)} ETH`);
        continue;
      }

      const gasPrice = await client.getGasPrice();
      const sweepGas = 130_000n * gasPrice;
      if (ethBalance < sweepGas) {
        console.log(`   skip: needs ~${formatEther(sweepGas)} ETH for gas (send a little ETH to this wallet first)`);
        continue;
      }

      // 1. Sweep curves into the escrow
      for (const { curve, pending: p } of pendingByCurve) {
        if (p === 0n) continue;
        const hash = await wallet.writeContract({ address: curve, abi: PONS_CURVE_ABI, functionName: "sweepFees", args: [0n] });
        const rc = await client.waitForTransactionReceipt({ hash });
        console.log(`   swept ${formatEther(p)} ETH from ${short(curve)} (${rc.status}): ${hash}`);
      }

      // 2. Claim the escrow to this wallet
      const claimable = await client.readContract({ address: CONTRACT_ADDRESSES.feeEscrow, abi: PONS_FEE_ESCROW_ABI, functionName: "balanceOf", args: [addr] });
      if (claimable === 0n) {
        console.log("   nothing in escrow after sweep");
        continue;
      }
      const claimHash = await wallet.writeContract({ address: CONTRACT_ADDRESSES.feeEscrow, abi: PONS_FEE_ESCROW_ABI, functionName: "claim" });
      const claimRc = await client.waitForTransactionReceipt({ hash: claimHash });
      if (claimRc.status !== "success") throw new Error(`claim reverted: ${claimHash}`);
      console.log(`   claimed ${formatEther(claimable)} ETH: ${claimHash}`);

      // 3. Forward the claimed amount, keeping enough for the transfer's own gas
      if (addr.toLowerCase() === destination.toLowerCase()) continue;
      const balance = await client.getBalance({ address: addr });
      const transferGas = 21_000n * (await client.getGasPrice()) * 2n;
      const amount = claimable < balance - transferGas ? claimable : balance - transferGas;
      if (amount <= 0n) {
        console.log("   not enough left to forward after gas");
        continue;
      }
      const sendHash = await wallet.sendTransaction({ to: destination, value: amount });
      await client.waitForTransactionReceipt({ hash: sendHash });
      console.log(`   sent ${formatEther(amount)} ETH → ${short(destination)}: ${sendHash}`);
    } catch (err) {
      console.log(`   ✘ ${short(addr)}: ${((err as { shortMessage?: string }).shortMessage || (err as Error).message).split("\n")[0]}`);
    }
  }
  console.log(`Robinhood totals: ${formatEther(totalPending)} ETH on curves + ${formatEther(totalEscrow)} ETH in escrow`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  console.log(EXECUTE ? "MODE: EXECUTE (claims and transfers will be sent)" : "MODE: DRY RUN (read only, add --execute to claim)");
  if (cfg.solana && ONLY !== "robinhood") await runSolana(cfg.solana);
  if (cfg.robinhood && ONLY !== "solana") await runRobinhood(cfg.robinhood);
}

main().catch((err) => {
  console.error("✘", (err as Error).message);
  process.exit(1);
});
