import { clusterApiUrl } from "@solana/web3.js";

/**
 * Solana network configuration.
 * Set NEXT_PUBLIC_SOLANA_CLUSTER to "mainnet-beta" for production, defaults to devnet.
 * pump.fun runs the same program ID on both clusters.
 */
export type SolanaCluster = "mainnet-beta" | "devnet";

export const SOLANA_CLUSTER: SolanaCluster =
  process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "mainnet-beta" ? "mainnet-beta" : "devnet";

export const IS_MAINNET = SOLANA_CLUSTER === "mainnet-beta";

export const CLUSTER_LABEL = IS_MAINNET ? "Mainnet" : "Devnet";

// Server-side RPC (can hold a private API key). Use Helius/Triton/QuickNode in production,
// the public endpoints are heavily rate limited.
export function getServerRpcUrl(): string {
  return process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl(SOLANA_CLUSTER);
}

// Browser RPC: NEXT_PUBLIC_SOLANA_RPC_URL if set, otherwise this app's own /api/rpc proxy
// (public mainnet RPC answers 403 to browser origins).
export function getBrowserRpcUrl(): string {
  if (process.env.NEXT_PUBLIC_SOLANA_RPC_URL) return process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  if (typeof window !== "undefined") return `${window.location.origin}/api/rpc`;
  return clusterApiUrl(SOLANA_CLUSTER);
}

// Priority fee added to every transaction (micro-lamports per compute unit)
export const PRIORITY_FEE_MICROLAMPORTS = Number(process.env.NEXT_PUBLIC_PRIORITY_FEE_MICROLAMPORTS || 200_000);

// pump.fun tokens always use 6 decimals and SOL uses 9
export const TOKEN_DECIMALS = 6;
export const SOL_DECIMALS = 9;

// pump.fun total supply: 1,000,000,000 tokens
export const PUMP_TOTAL_SUPPLY = 1_000_000_000;

const clusterQuery = IS_MAINNET ? "" : `?cluster=${SOLANA_CLUSTER}`;

export const explorerTxUrl = (signature: string) => `https://solscan.io/tx/${signature}${clusterQuery}`;
export const explorerTokenUrl = (mint: string) => `https://solscan.io/token/${mint}${clusterQuery}`;
export const explorerAccountUrl = (address: string) => `https://solscan.io/account/${address}${clusterQuery}`;
export const pumpFunCoinUrl = (mint: string) => `https://pump.fun/coin/${mint}`;
