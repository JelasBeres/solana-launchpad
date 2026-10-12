"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

export type LaunchChain = "solana" | "robinhood";

export const CHAIN_OPTIONS: { id: LaunchChain; network: string; protocol: string; asset: string }[] = [
  { id: "solana", network: "Solana", protocol: "pump.fun", asset: "SOL" },
  { id: "robinhood", network: "Robinhood", protocol: "Pons v2", asset: "ETH" },
];

const STORAGE_KEY = "lockey_launch_chain";

const isLaunchChain = (v: unknown): v is LaunchChain => v === "solana" || v === "robinhood";

/** Token addresses tell the chain apart: EVM is 0x-hex, Solana is base58. */
export const chainForAddress = (address: string): LaunchChain => (address.startsWith("0x") ? "robinhood" : "solana");

interface ChainContextValue {
  chain: LaunchChain;
  setChain: (chain: LaunchChain) => void;
}

const ChainContext = createContext<ChainContextValue>({ chain: "solana", setChain: () => undefined });

export function ChainProvider({ children }: { children: React.ReactNode }) {
  const [chain, setChainState] = useState<LaunchChain>("solana");

  // ?chain= in the URL wins, then the viewer's last choice
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("chain");
    if (isLaunchChain(fromUrl)) {
      setChainState(fromUrl);
      return;
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isLaunchChain(saved)) setChainState(saved);
    } catch {
      // storage unavailable (private mode), keep default
    }
  }, []);

  const setChain = useCallback((next: LaunchChain) => {
    setChainState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  return <ChainContext.Provider value={{ chain, setChain }}>{children}</ChainContext.Provider>;
}

export function useLaunchChain() {
  return useContext(ChainContext);
}

/** Segmented Solana / Robinhood switch. "large" for page headers, "compact" for navbar and modals. */
export function ChainSelector({ size = "compact", className = "" }: { size?: "compact" | "large"; className?: string }) {
  const { chain, setChain } = useLaunchChain();

  if (size === "large") {
    return (
      <div className={`grid grid-cols-2 gap-3 ${className}`}>
        {CHAIN_OPTIONS.map((opt) => {
          const active = chain === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setChain(opt.id)}
              aria-pressed={active}
              className={`p-4 rounded-xl border text-left transition-colors ${
                active
                  ? "bg-yellow-400/10 border-yellow-400 shadow-sm"
                  : "bg-[#121318] border-zinc-800 hover:border-yellow-500/40"
              }`}
            >
              <span className="flex items-center space-x-2">
                <span className={`w-2 h-2 rounded-full ${active ? "bg-yellow-400 animate-pulse" : "bg-zinc-600"}`} />
                <span className={`text-sm font-bold ${active ? "text-white" : "text-zinc-300"}`}>{opt.network}</span>
              </span>
              <span className={`block mt-1 text-xs font-mono ${active ? "text-yellow-400" : "text-zinc-500"}`}>
                {opt.protocol} • {opt.asset}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`inline-flex items-center p-0.5 bg-zinc-900 border border-zinc-800 rounded-lg ${className}`}>
      {CHAIN_OPTIONS.map((opt) => {
        const active = chain === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => setChain(opt.id)}
            aria-pressed={active}
            title={`${opt.network} • ${opt.protocol}`}
            className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
              active ? "bg-yellow-400 text-black" : "text-zinc-400 hover:text-white"
            }`}
          >
            {opt.network}
          </button>
        );
      })}
    </div>
  );
}
