/**
 * Pons v2 sniper for Robinhood Chain: watches the factory for new launches, buys the ones that pass your
 * filters, then sells on take-profit / stop-loss / max hold time.
 *
 *   npx tsx scripts/pons-sniper.ts              # dry run: shows what it WOULD buy, sends nothing
 *   npx tsx scripts/pons-sniper.ts --execute    # really buys and sells
 *   npx tsx scripts/pons-sniper.ts --config other.json
 *
 * Settings + the wallet key come from sniper-config.json (git-ignored, see sniper-config.example.json).
 * The key never leaves this machine and is never printed. Open positions are saved to sniper-positions.json,
 * so a restart keeps managing them, and finished trades are appended to sniper-history.json.
 *
 * RPC: ROBINHOOD_RPC_URL env var (public endpoint by default; some Indonesian ISPs DNS-block it, so use a VPN,
 * 1.1.1.1 DNS, or run this on the VPS). A faster/private RPC means earlier entries.
 */
import fs from "fs";
import path from "path";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  maxUint256,
  parseAbiItem,
  parseEther,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACT_ADDRESSES, robinhoodChain } from "../src/config/chain";
import { PONS_CURVE_ABI, PONS_FACTORY_ABI, PONS_TOKEN_ABI } from "../src/config/abis";

// ─── Config ──────────────────────────────────────────────────────────────────

interface SniperConfig {
  privateKey: string;
  buyEth: string; // ETH spent per snipe
  slippagePercent: number;
  maxCreatorTaxPercent: number; // skip tokens whose creator tax is above this
  maxSnipeTaxPercent: number; // skip while Pons' anti-snipe tax is above this
  maxLaunchAgeSeconds: number; // skip launches we noticed too late
  maxOpenPositions: number;
  maxTotalSpendEth: string; // lifetime budget of this run
  gasReserveEth: string; // never spend below this balance
  takeProfitPercent: number; // sell when the position is worth +X% (after fees)
  stopLossPercent: number; // sell when it is worth -X%
  maxHoldSeconds: number; // sell anyway after this long (0 = never)
  keywords: string[]; // name/symbol must contain one of these (empty = any)
  blockedKeywords: string[];
  allowedDeployers: string[]; // only snipe these deployers (empty = any)
  blockedDeployers: string[];
  rpcUrl?: string; // optional private RPC (falls back to ROBINHOOD_RPC_URL, then the public endpoint)
}

interface Position {
  token: `0x${string}`;
  curve: `0x${string}`;
  symbol: string;
  costWei: string;
  boughtAt: number;
  buyTx: string;
  valueWei?: string; // what selling everything would pay right now, refreshed every few seconds
  pnlPercent?: number;
}

interface Trade {
  token: `0x${string}`;
  symbol: string;
  costWei: string;
  receivedWei: string | null; // null when the tokens left the wallet outside the bot
  boughtAt: number;
  closedAt: number;
  reason: string;
  tx: string | null;
}

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const CONFIG_PATH = path.resolve(args.includes("--config") ? args[args.indexOf("--config") + 1] : "sniper-config.json");
const POSITIONS_PATH = path.resolve("sniper-positions.json");
const HISTORY_PATH = path.resolve("sniper-history.json");

const POLL_MS = 300;
const POSITION_CHECK_MS = 3000;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TOKEN_LAUNCHED = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)"
);

function loadConfig(): SniperConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}\nCopy sniper-config.example.json to sniper-config.json and fill it in.`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as SniperConfig;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(cfg.privateKey ?? "")) {
    console.error("privateKey in the config must be a 64-hex-character EVM private key.");
    process.exit(1);
  }
  return cfg;
}

const cfg = loadConfig();
const account = privateKeyToAccount((cfg.privateKey.startsWith("0x") ? cfg.privateKey : `0x${cfg.privateKey}`) as Hex);
const transport = http(cfg.rpcUrl || process.env.ROBINHOOD_RPC_URL || undefined);
const publicClient = createPublicClient({ chain: robinhoodChain, transport });
const walletClient = createWalletClient({ account, chain: robinhoodChain, transport });

const BUY_WEI = parseEther(cfg.buyEth);
const MAX_SPEND_WEI = parseEther(cfg.maxTotalSpendEth);
const GAS_RESERVE_WEI = parseEther(cfg.gasReserveEth);
const lower = (list: string[] | undefined) => (list ?? []).map((s) => s.toLowerCase());
const KEYWORDS = lower(cfg.keywords);
const BLOCKED_KEYWORDS = lower(cfg.blockedKeywords);
const ALLOWED_DEPLOYERS = lower(cfg.allowedDeployers);
const BLOCKED_DEPLOYERS = lower(cfg.blockedDeployers);

let positions: Position[] = [];
let spentWei = 0n;
// Launches that pass every filter except the anti-snipe tax, re-checked each loop until it decays or they get too old
let waiting: LaunchLog[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const shortError = (err: unknown) => {
  const e = err as { shortMessage?: string; message?: string };
  return (e.shortMessage || e.message || String(err)).split("\n")[0];
};

function loadPositions() {
  try {
    positions = JSON.parse(fs.readFileSync(POSITIONS_PATH, "utf-8")) as Position[];
  } catch {
    positions = [];
  }
}

function savePositions() {
  if (EXECUTE) fs.writeFileSync(POSITIONS_PATH, JSON.stringify(positions, null, 2), "utf-8");
}

function readHistory(): Trade[] {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8")) as Trade[];
  } catch {
    return [];
  }
}

function recordTrade(trade: Trade) {
  const history = readHistory();
  history.push(trade);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf-8");
}

/** Approves the curve to pull this token when the current allowance would not cover `amount`. */
async function ensureAllowance(token: `0x${string}`, curve: `0x${string}`, amount: bigint) {
  const allowance = await publicClient.readContract({ address: token, abi: PONS_TOKEN_ABI, functionName: "allowance", args: [account.address, curve] });
  if (allowance >= amount) return;
  const approveTx = await walletClient.writeContract({ address: token, abi: PONS_TOKEN_ABI, functionName: "approve", args: [curve, maxUint256] });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
}

// ─── Buying ──────────────────────────────────────────────────────────────────

type LaunchLog = { token: `0x${string}`; curve: `0x${string}`; deployer: `0x${string}`; pairToken: `0x${string}`; blockNumber: bigint };

/**
 * Returns the reason a launch is skipped, or null when it passes every filter. `retry` is set when only Pons'
 * anti-snipe tax is in the way: it starts near 99% and decays within seconds, so the launch is checked again.
 */
async function rejectReason(launch: LaunchLog): Promise<{ reason: string | null; symbol: string; retry?: boolean }> {
  const deployer = launch.deployer.toLowerCase();
  if (launch.pairToken !== ZERO_ADDRESS) return { reason: "not paired with ETH", symbol: "?" };
  if (BLOCKED_DEPLOYERS.includes(deployer)) return { reason: "deployer is blocked", symbol: "?" };
  if (ALLOWED_DEPLOYERS.length > 0 && !ALLOWED_DEPLOYERS.includes(deployer)) return { reason: "deployer not in allowedDeployers", symbol: "?" };

  const [name, symbol, creatorTaxBps, snipeTaxBps, graduated, launchBlock, head] = await Promise.all([
    publicClient.readContract({ address: launch.token, abi: PONS_TOKEN_ABI, functionName: "name" }),
    publicClient.readContract({ address: launch.token, abi: PONS_TOKEN_ABI, functionName: "symbol" }),
    publicClient.readContract({ address: launch.curve, abi: PONS_CURVE_ABI, functionName: "creatorTaxBps" }),
    publicClient.readContract({ address: launch.curve, abi: PONS_CURVE_ABI, functionName: "currentSnipeTaxBps", args: [account.address] }),
    publicClient.readContract({ address: launch.curve, abi: PONS_CURVE_ABI, functionName: "graduated" }),
    publicClient.getBlock({ blockNumber: launch.blockNumber }),
    publicClient.getBlock(),
  ]);

  const text = `${name} ${symbol}`.toLowerCase();
  const age = Number(head.timestamp - launchBlock.timestamp);
  let reason: string | null = null;
  if (graduated) reason = "already graduated";
  else if (age > cfg.maxLaunchAgeSeconds) reason = `too late (${age}s old)`;
  else if (Number(creatorTaxBps) > cfg.maxCreatorTaxPercent * 100) reason = `creator tax ${Number(creatorTaxBps) / 100}% too high`;
  else if (BLOCKED_KEYWORDS.some((k) => text.includes(k))) reason = "name matches blockedKeywords";
  else if (KEYWORDS.length > 0 && !KEYWORDS.some((k) => text.includes(k))) reason = "name matches no keyword";
  else if (Number(snipeTaxBps) > cfg.maxSnipeTaxPercent * 100) {
    return { reason: `snipe tax ${Number(snipeTaxBps) / 100}% still active`, symbol, retry: true };
  }
  return { reason, symbol };
}

async function snipe(launch: LaunchLog) {
  if (positions.some((p) => p.token === launch.token)) return;
  const { reason, symbol, retry } = await rejectReason(launch);
  const wasWaiting = waiting.some((w) => w.token === launch.token);
  if (retry) {
    if (!wasWaiting) {
      waiting.push(launch);
      log(`wait  $${symbol} ${launch.token}: ${reason}, retrying until it drops`);
    }
    return;
  }
  waiting = waiting.filter((w) => w.token !== launch.token);
  if (reason) return log(`skip  $${symbol} ${launch.token}: ${reason}`);
  if (positions.length >= cfg.maxOpenPositions) return log(`skip  $${symbol}: ${positions.length} positions already open`);
  if (spentWei + BUY_WEI > MAX_SPEND_WEI) return log(`skip  $${symbol}: maxTotalSpendEth budget used up`);

  const balance = await publicClient.getBalance({ address: account.address });
  const underfunded = balance < BUY_WEI + GAS_RESERVE_WEI;
  if (underfunded && EXECUTE) return log(`skip  $${symbol}: wallet balance ${formatEther(balance)} ETH is too low`);

  // Simulating the real buy both prices it and catches honeypot-style reverts before any ETH is sent
  const { request, result: tokensOut } = await publicClient.simulateContract({
    account,
    address: launch.curve,
    abi: PONS_CURVE_ABI,
    functionName: "buy",
    args: [BUY_WEI, 0n, account.address],
    value: BUY_WEI,
    // A dry run should still price the buy when the wallet is not funded yet
    stateOverride: underfunded ? [{ address: account.address, balance: BUY_WEI + parseEther("1") }] : undefined,
  });
  const minTokensOut = (tokensOut * BigInt(Math.round((100 - cfg.slippagePercent) * 100))) / 10000n;

  if (!EXECUTE) {
    spentWei += BUY_WEI;
    return log(`DRY   would buy $${symbol} ${launch.token} with ${cfg.buyEth} ETH -> ${Number(formatEther(tokensOut)).toLocaleString()} tokens`);
  }

  const buyTx = await walletClient.writeContract({ ...request, args: [BUY_WEI, minTokensOut, account.address] });
  // Track it as soon as it is sent: if the receipt wait fails, the position is still managed (or closed once
  // the balance turns out to be zero) and the budget still counts it
  spentWei += BUY_WEI;
  positions.push({ token: launch.token, curve: launch.curve, symbol, costWei: BUY_WEI.toString(), boughtAt: Date.now(), buyTx });
  savePositions();
  const receipt = await publicClient.waitForTransactionReceipt({ hash: buyTx });
  if (receipt.status !== "success") {
    spentWei -= BUY_WEI;
    positions = positions.filter((p) => p.token !== launch.token);
    savePositions();
    return log(`FAIL  buy $${symbol} reverted (${buyTx})`);
  }
  log(`BUY   $${symbol} ${launch.token} for ${cfg.buyEth} ETH (${buyTx})`);

  // Approve once now so the exit is a single transaction later (retried before selling if this fails)
  await ensureAllowance(launch.token, launch.curve, maxUint256).catch((err) => log(`warn  approve $${symbol}: ${shortError(err)}`));
}

// ─── Selling ─────────────────────────────────────────────────────────────────

async function managePosition(pos: Position) {
  const [balance, graduated] = await publicClient.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: [
      { address: pos.token, abi: PONS_TOKEN_ABI, functionName: "balanceOf", args: [account.address] },
      { address: pos.curve, abi: PONS_CURVE_ABI, functionName: "graduated" },
    ],
  });

  const close = (why: string, reason: string, receivedWei: bigint | null, tx: string | null) => {
    positions = positions.filter((p) => p.token !== pos.token);
    savePositions();
    recordTrade({ token: pos.token, symbol: pos.symbol, costWei: pos.costWei, receivedWei: receivedWei?.toString() ?? null, boughtAt: pos.boughtAt, closedAt: Date.now(), reason, tx });
    log(why);
  };
  if (balance === 0n) {
    // The dashboard's "Jual sekarang" button already recorded this sale
    if (readHistory().some((t) => t.token === pos.token && t.closedAt >= pos.boughtAt)) {
      positions = positions.filter((p) => p.token !== pos.token);
      return savePositions();
    }
    return close(`CLOSE $${pos.symbol}: no tokens left in the wallet`, "sold outside the bot", null, null);
  }
  if (graduated) {
    return close(`GRAD  $${pos.symbol} graduated to the DEX. The bot only sells on the curve, sell ${pos.token} manually.`, "graduated", null, null);
  }

  // Selling needs the allowance, and so does simulating it
  await ensureAllowance(pos.token, pos.curve, balance);
  // What selling everything right now would really pay out (fees and taxes included)
  const { request, result: quoteOut } = await publicClient.simulateContract({
    account,
    address: pos.curve,
    abi: PONS_CURVE_ABI,
    functionName: "sell",
    args: [balance, 0n, account.address],
  });

  const cost = BigInt(pos.costWei);
  const pnlPercent = Number(((quoteOut - cost) * 10000n) / cost) / 100;
  // Shown live on the dashboard
  pos.valueWei = quoteOut.toString();
  pos.pnlPercent = pnlPercent;
  savePositions();

  const heldSeconds = (Date.now() - pos.boughtAt) / 1000;
  let trigger: string | null = null;
  if (pnlPercent >= cfg.takeProfitPercent) trigger = "take profit";
  else if (pnlPercent <= -cfg.stopLossPercent) trigger = "stop loss";
  else if (cfg.maxHoldSeconds > 0 && heldSeconds >= cfg.maxHoldSeconds) trigger = "max hold time";
  if (!trigger) return;

  const minQuoteOut = (quoteOut * BigInt(Math.round((100 - cfg.slippagePercent) * 100))) / 10000n;
  const sellTx = await walletClient.writeContract({ ...request, args: [balance, minQuoteOut, account.address] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: sellTx });
  if (receipt.status !== "success") return log(`FAIL  sell $${pos.symbol} reverted (${sellTx}), will retry`);
  const sign = pnlPercent >= 0 ? "+" : "";
  close(`SELL  $${pos.symbol} (${trigger}) for ~${formatEther(quoteOut)} ETH, ${sign}${pnlPercent}% (${sellTx})`, trigger, quoteOut, sellTx);
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function main() {
  loadPositions();
  const [chainId, balance, launchEnabled] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: CONTRACT_ADDRESSES.factory, abi: PONS_FACTORY_ABI, functionName: "launchEnabled" }),
  ]);
  if (chainId !== robinhoodChain.id) throw new Error(`RPC is on chain ${chainId}, expected ${robinhoodChain.id}`);

  console.log(`Pons sniper ${EXECUTE ? "LIVE" : "DRY RUN (add --execute to trade)"}`);
  console.log(`Wallet ${account.address} | balance ${formatEther(balance)} ETH | factory launches ${launchEnabled ? "enabled" : "PAUSED"}`);
  console.log(
    `Buy ${cfg.buyEth} ETH each, budget ${cfg.maxTotalSpendEth} ETH, max ${cfg.maxOpenPositions} positions | ` +
      `TP +${cfg.takeProfitPercent}% / SL -${cfg.stopLossPercent}% / hold ${cfg.maxHoldSeconds || "∞"}s | open positions: ${positions.length}\n`
  );

  let nextBlock = (await publicClient.getBlockNumber()) + 1n;
  let lastPositionCheck = 0;

  for (;;) {
    try {
      const head = await publicClient.getBlockNumber();
      if (head >= nextBlock) {
        const logs = await publicClient.getLogs({ address: CONTRACT_ADDRESSES.factory, event: TOKEN_LAUNCHED, fromBlock: nextBlock, toBlock: head });
        nextBlock = head + 1n;
        for (const l of logs) {
          const { token, curve, deployer, pairToken } = l.args;
          if (!token || !curve || !deployer || !pairToken) continue;
          await snipe({ token, curve, deployer, pairToken, blockNumber: l.blockNumber }).catch((err) =>
            log(`skip  ${token}: ${shortError(err)}`)
          );
        }
      }

      for (const launch of [...waiting]) {
        await snipe(launch).catch((err) => {
          waiting = waiting.filter((w) => w.token !== launch.token);
          log(`skip  ${launch.token}: ${shortError(err)}`);
        });
      }

      if (EXECUTE && Date.now() - lastPositionCheck >= POSITION_CHECK_MS) {
        lastPositionCheck = Date.now();
        for (const pos of [...positions]) {
          await managePosition(pos).catch((err) => log(`warn  $${pos.symbol}: ${shortError(err)}`));
        }
      }
    } catch (err) {
      log(`RPC error: ${shortError(err)}`);
      await sleep(2000);
    }
    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error(shortError(err));
  process.exit(1);
});
