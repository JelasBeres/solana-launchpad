import { Buffer } from "buffer";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import BN from "bn.js";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurveMarketCap,
  bondingCurvePda,
  computeFeesBps,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  isSolLikeQuoteMint,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from "@pump-fun/pump-sdk";
import { PRIORITY_FEE_MICROLAMPORTS, PUMP_TOTAL_SUPPLY, SOL_DECIMALS, TOKEN_DECIMALS } from "@/config/solana";

// ─── Amount helpers ──────────────────────────────────────────────────────────

/** Parses a decimal string ("0.25") into base units without floating point loss. */
export function parseAmount(value: string, decimals: number): BN {
  const trimmed = (value || "").trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return new BN(0);
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return new BN((whole || "0") + fracPadded);
}

/** Base units -> JS number (display only). */
export function toUiAmount(amount: BN | bigint | number, decimals: number): number {
  const str = amount.toString();
  return Number(str) / 10 ** decimals;
}

/** Base units -> exact decimal string (for inputs). */
export function formatAmount(amount: BN, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export const lamportsToSol = (lamports: BN | bigint | number) => toUiAmount(lamports, SOL_DECIMALS);

// ─── Protocol state ──────────────────────────────────────────────────────────

export interface PumpProtocolState {
  global: Global;
  feeConfig: FeeConfig | null;
}

export async function fetchProtocolState(connection: Connection): Promise<PumpProtocolState> {
  const sdk = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([
    sdk.fetchGlobal(),
    sdk.fetchFeeConfig().catch(() => null),
  ]);
  return { global, feeConfig };
}

// Custom creator fees only apply to coins quoted through pump.fun's QuoteControl list. On SOL (and USDC) curves,
// which is every coin this app launches, create_v2 ignores creator_fee_bps (even with Global.creatorFeeConfigurable
// on), so the app never offers a creator fee choice for Solana.

/** pump.fun's fee schedule for a fresh SOL curve (rates are tiered by market cap and may change as it grows). */
export function launchFeeSchedule(state: PumpProtocolState): { protocolBps: number; creatorBps: number } | null {
  try {
    const fees = computeFeesBps({
      global: state.global,
      feeConfig: state.feeConfig,
      mintSupply: state.global.tokenTotalSupply,
      virtualQuoteReserves: state.global.initialVirtualSolReserves,
      virtualTokenReserves: state.global.initialVirtualTokenReserves,
      quoteMint: NATIVE_MINT,
    });
    return { protocolBps: Number(fees.protocolFeeBps.toString()), creatorBps: Number(fees.creatorFeeBps.toString()) };
  } catch {
    return null;
  }
}

/** Starting price / market cap of a fresh curve, used as the chart baseline. */
export function initialCurvePrice(global: Global) {
  const vSol = lamportsToSol(global.initialVirtualSolReserves);
  const vTok = toUiAmount(global.initialVirtualTokenReserves, TOKEN_DECIMALS);
  const priceSol = vTok > 0 ? vSol / vTok : 0;
  return { priceSol, marketCapSol: priceSol * PUMP_TOTAL_SUPPLY };
}

/** SOL that must flow into the curve before it completes and migrates to PumpSwap. */
export function graduationTargetSol(global: Global): number {
  const vSol0 = BigInt(global.initialVirtualSolReserves.toString());
  const vTok0 = BigInt(global.initialVirtualTokenReserves.toString());
  const real0 = BigInt(global.initialRealTokenReserves.toString());
  if (vTok0 <= real0) return 0;
  const vSolFinal = (vSol0 * vTok0) / (vTok0 - real0);
  return lamportsToSol(vSolFinal - vSol0);
}

// ─── Token program / metadata ────────────────────────────────────────────────

export async function getMintTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error("Mint account not found on this cluster.");
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error("Address is not an SPL token mint.");
}

const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function readBorshString(buf: Buffer, offset: number): [string, number] {
  const len = buf.readUInt32LE(offset);
  const str = buf.subarray(offset + 4, offset + 4 + len).toString("utf8").replace(/\0/g, "").trim();
  return [str, offset + 4 + len];
}

export interface OnchainTokenMetadata {
  name: string;
  symbol: string;
  uri: string;
}

/** Reads name/symbol/uri from Token-2022 metadata (create_v2 coins) or Metaplex (legacy coins). */
export async function fetchOnchainMetadata(
  connection: Connection,
  mint: PublicKey,
  tokenProgram: PublicKey
): Promise<OnchainTokenMetadata | null> {
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    const meta = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
    if (meta) return { name: meta.name, symbol: meta.symbol, uri: meta.uri };
  }

  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM_ID
  );
  const info = await connection.getAccountInfo(metadataPda);
  if (!info) return null;
  // key (1) + update authority (32) + mint (32), then name / symbol / uri
  let offset = 1 + 32 + 32;
  const [name, o1] = readBorshString(info.data, offset);
  offset = o1;
  const [symbol, o2] = readBorshString(info.data, offset);
  offset = o2;
  const [uri] = readBorshString(info.data, offset);
  return { name, symbol, uri };
}

export interface OffchainTokenMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export function resolveIpfsUrl(url: string | undefined): string {
  if (!url) return "";
  if (url.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${url.slice("ipfs://".length)}`;
  return url;
}

export async function fetchOffchainMetadata(uri: string): Promise<OffchainTokenMetadata | null> {
  if (!uri) return null;
  try {
    // Proxied through the app's server: IPFS gateways often block browser CORS
    const res = await fetch(`/api/metadata?uri=${encodeURIComponent(uri)}`);
    if (!res.ok) return null;
    return (await res.json()) as OffchainTokenMetadata;
  } catch {
    return null;
  }
}

// ─── Curve snapshot ──────────────────────────────────────────────────────────

export interface CurveSnapshot {
  bondingCurve: BondingCurve;
  priceSol: number;
  marketCapSol: number;
  realSolReserves: number;
  progressPercent: number;
  complete: boolean;
  isSolQuoted: boolean;
}

export async function fetchCurveSnapshot(
  connection: Connection,
  mint: PublicKey,
  global: Global
): Promise<CurveSnapshot | null> {
  const info = await connection.getAccountInfo(bondingCurvePda(mint));
  if (!info) return null;
  const bondingCurve = PUMP_SDK.decodeBondingCurveNullable(info);
  if (!bondingCurve) return null;

  const vSol = lamportsToSol(bondingCurve.virtualQuoteReserves);
  const vTok = toUiAmount(bondingCurve.virtualTokenReserves, TOKEN_DECIMALS);
  const priceSol = vTok > 0 ? vSol / vTok : 0;

  const marketCapSol = lamportsToSol(
    bondingCurveMarketCap({
      mintSupply: bondingCurve.tokenTotalSupply,
      virtualQuoteReserves: bondingCurve.virtualQuoteReserves,
      virtualTokenReserves: bondingCurve.virtualTokenReserves,
    })
  );

  const initialReal = toUiAmount(global.initialRealTokenReserves, TOKEN_DECIMALS);
  const remaining = toUiAmount(bondingCurve.realTokenReserves, TOKEN_DECIMALS);
  const progressPercent = bondingCurve.complete
    ? 100
    : initialReal > 0
      ? Math.min(100, Math.max(0, ((initialReal - remaining) / initialReal) * 100))
      : 0;

  return {
    bondingCurve,
    priceSol,
    marketCapSol,
    realSolReserves: lamportsToSol(bondingCurve.realQuoteReserves),
    progressPercent,
    complete: bondingCurve.complete,
    isSolQuoted: isSolLikeQuoteMint(bondingCurve.quoteMint),
  };
}

/** Fee rates a specific curve charges right now (same numbers GMGN / pump.fun show). */
export function curveFeeRates(state: PumpProtocolState, bondingCurve: BondingCurve): { protocolBps: number; creatorBps: number } | null {
  try {
    const fees = computeFeesBps({
      global: state.global,
      feeConfig: state.feeConfig,
      mintSupply: bondingCurve.tokenTotalSupply,
      virtualQuoteReserves: bondingCurve.virtualQuoteReserves,
      virtualTokenReserves: bondingCurve.virtualTokenReserves,
      quoteMint: bondingCurve.quoteMint,
      creatorFeeBps: bondingCurve.creatorFeeBps,
    });
    return { protocolBps: Number(fees.protocolFeeBps.toString()), creatorBps: Number(fees.creatorFeeBps.toString()) };
  } catch {
    return null;
  }
}

// ─── Quotes ──────────────────────────────────────────────────────────────────

export function quoteBuy(state: PumpProtocolState, bondingCurve: BondingCurve, solAmount: BN): BN {
  if (solAmount.lten(0)) return new BN(0);
  return getBuyTokenAmountFromSolAmount({
    global: state.global,
    feeConfig: state.feeConfig,
    mintSupply: bondingCurve.tokenTotalSupply,
    bondingCurve,
    amount: solAmount,
    quoteMint: bondingCurve.quoteMint,
  });
}

export function quoteSell(state: PumpProtocolState, bondingCurve: BondingCurve, tokenAmount: BN): BN {
  if (tokenAmount.lten(0)) return new BN(0);
  return getSellSolAmountFromTokenAmount({
    global: state.global,
    feeConfig: state.feeConfig,
    mintSupply: bondingCurve.tokenTotalSupply,
    bondingCurve,
    amount: tokenAmount,
  });
}

// ─── Transaction builders ────────────────────────────────────────────────────

function withComputeBudget(units: number, ixs: TransactionInstruction[]): Transaction {
  return new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }),
    ...ixs
  );
}

export interface CreateTokenParams {
  connection: Connection;
  user: PublicKey;
  name: string;
  symbol: string;
  metadataUri: string;
  devBuyLamports: BN;
}

/**
 * Builds create_v2 (Token-2022 coin quoted in SOL), optionally with the creator's first buy
 * in the same transaction. The returned mint keypair must co-sign the transaction.
 */
export async function buildCreateTokenTx(params: CreateTokenParams): Promise<{ tx: Transaction; mint: Keypair }> {
  const { connection, user, name, symbol, metadataUri, devBuyLamports } = params;
  const { global, feeConfig } = await fetchProtocolState(connection);

  if (!global.createV2Enabled) {
    throw new Error("pump.fun has create_v2 disabled on this cluster right now.");
  }

  const mint = Keypair.generate();

  let ixs: TransactionInstruction[];
  if (devBuyLamports.gtn(0)) {
    ixs = await PUMP_SDK.createV2AndBuyInstructions({
      global,
      mint: mint.publicKey,
      name,
      symbol,
      uri: metadataUri,
      creator: user,
      user,
      solAmount: devBuyLamports,
      amount: getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: null,
        bondingCurve: null,
        amount: devBuyLamports,
        quoteMint: NATIVE_MINT,
      }),
      mayhemMode: false,
    });
  } else {
    ixs = [
      await PUMP_SDK.createV2Instruction({
        mint: mint.publicKey,
        name,
        symbol,
        uri: metadataUri,
        creator: user,
        user,
        mayhemMode: false,
      }),
    ];
  }

  // create_v2 + ATA + buy touches ~27 accounts and sits right at Solana's 1232-byte packet limit,
  // so drop the compute budget instructions when they don't fit (keeps the dev buy atomic).
  const withBudget = withComputeBudget(devBuyLamports.gtn(0) ? 400_000 : 250_000, ixs);
  if (serializedSize(withBudget, user) <= MAX_TX_BYTES) return { tx: withBudget, mint };

  const bare = new Transaction().add(...ixs);
  if (serializedSize(bare, user) <= MAX_TX_BYTES) return { tx: bare, mint };

  throw new Error("Transaction too large. Use a shorter token name / metadata URL, or launch without a dev buy.");
}

const MAX_TX_BYTES = 1232;

function serializedSize(tx: Transaction, feePayer: PublicKey): number {
  const probe = new Transaction().add(...tx.instructions);
  probe.feePayer = feePayer;
  probe.recentBlockhash = PublicKey.default.toBase58();
  try {
    return probe.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch {
    return Number.POSITIVE_INFINITY; // web3.js throws when the message itself exceeds the limit
  }
}

export async function buildBuyTx(params: {
  connection: Connection;
  user: PublicKey;
  mint: PublicKey;
  solAmount: BN;
  slippagePercent: number;
}): Promise<Transaction> {
  const { connection, user, mint, solAmount, slippagePercent } = params;
  const sdk = new OnlinePumpSdk(connection);
  const tokenProgram = await getMintTokenProgram(connection, mint);
  const [state, buyState] = await Promise.all([fetchProtocolState(connection), sdk.fetchBuyState(mint, user, tokenProgram)]);

  if (buyState.bondingCurve.complete) throw new Error("Bonding curve is complete. This coin now trades on PumpSwap.");
  if (!isSolLikeQuoteMint(buyState.bondingCurve.quoteMint)) throw new Error("Only SOL-quoted coins are supported.");

  const ixs = await PUMP_SDK.buyInstructions({
    global: state.global,
    bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
    bondingCurve: buyState.bondingCurve,
    associatedUserAccountInfo: buyState.associatedUserAccountInfo,
    mint,
    user,
    solAmount,
    amount: quoteBuy(state, buyState.bondingCurve, solAmount),
    slippage: slippagePercent,
    tokenProgram,
  });
  return withComputeBudget(200_000, ixs);
}

export async function buildSellTx(params: {
  connection: Connection;
  user: PublicKey;
  mint: PublicKey;
  tokenAmount: BN;
  slippagePercent: number;
}): Promise<Transaction> {
  const { connection, user, mint, tokenAmount, slippagePercent } = params;
  const sdk = new OnlinePumpSdk(connection);
  const tokenProgram = await getMintTokenProgram(connection, mint);
  const [state, sellState] = await Promise.all([fetchProtocolState(connection), sdk.fetchSellState(mint, user, tokenProgram)]);

  if (sellState.bondingCurve.complete) throw new Error("Bonding curve is complete. This coin now trades on PumpSwap.");
  if (!isSolLikeQuoteMint(sellState.bondingCurve.quoteMint)) throw new Error("Only SOL-quoted coins are supported.");

  const ixs = await PUMP_SDK.sellInstructions({
    global: state.global,
    bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
    bondingCurve: sellState.bondingCurve,
    mint,
    user,
    amount: tokenAmount,
    solAmount: quoteSell(state, sellState.bondingCurve, tokenAmount),
    slippage: slippagePercent,
    tokenProgram,
    mayhemMode: sellState.bondingCurve.isMayhemMode,
    cashback: sellState.bondingCurve.isCashbackCoin,
  });
  return withComputeBudget(200_000, ixs);
}

/** Creator fees waiting in the pump.fun + PumpSwap creator vaults (lamports). */
export async function fetchCreatorFeeBalance(connection: Connection, creator: PublicKey): Promise<BN> {
  return new OnlinePumpSdk(connection).getCreatorVaultBalanceBothPrograms(creator);
}

export async function buildClaimCreatorFeesTx(connection: Connection, creator: PublicKey): Promise<Transaction> {
  const ixs = await new OnlinePumpSdk(connection).collectCoinCreatorFeeInstructions(creator, creator);
  return withComputeBudget(200_000, ixs);
}

/** User's token balance for a mint (UI units), 0 if no account. */
export async function fetchTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<{ raw: BN; ui: number }> {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint });
  let total = new BN(0);
  for (const acc of res.value) {
    const amount = acc.account.data.parsed?.info?.tokenAmount?.amount;
    if (amount) total = total.add(new BN(amount));
  }
  return { raw: total, ui: toUiAmount(total, TOKEN_DECIMALS) };
}

export function isValidPublicKey(value: string): boolean {
  try {
    new PublicKey(value);
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  } catch {
    return false;
  }
}
