"use client";

import { useLaunchChain } from "@/components/ChainProvider";
import { CLUSTER_LABEL } from "@/config/solana";

export function NetworkBadge() {
  const { chain } = useLaunchChain();
  const [name, detail, asset] =
    chain === "robinhood" ? ["Robinhood Chain (Pons v2)", "ID: 4663", "ETH Native"] : ["Solana (pump.fun)", CLUSTER_LABEL, "SOL Native"];

  return (
    <div className="flex items-center space-x-2 text-zinc-200 px-3.5 py-1.5 bg-zinc-900/90 border border-yellow-500/25 rounded-lg shadow-sm">
      <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></span>
      <span className="font-semibold text-sm text-white tracking-wide">{name}</span>
      <span className="text-zinc-600">•</span>
      <span className="font-mono text-xs text-yellow-400 font-semibold">{detail}</span>
      <span className="text-zinc-600">•</span>
      <span className="font-mono text-xs text-zinc-300 font-bold">{asset}</span>
    </div>
  );
}
