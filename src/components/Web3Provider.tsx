"use client";

import React, { ReactNode, useMemo } from "react";
import { Buffer } from "buffer";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { getBrowserRpcUrl } from "@/config/solana";
import { wagmiConfig } from "@/config/wagmi";
import { ChainProvider } from "./ChainProvider";
import { ToastProvider } from "./Toast";

import "@solana/wallet-adapter-react-ui/styles.css";

// Solana libraries (Anchor, spl-token) expect a global Buffer in the browser
if (typeof window !== "undefined" && !(window as unknown as { Buffer?: unknown }).Buffer) {
  (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

const queryClient = new QueryClient();

/** Both stacks stay mounted: wagmi for Robinhood (Pons v2), wallet-adapter for Solana (pump.fun). */
export function Web3Provider({ children }: { children: ReactNode }) {
  // Phantom, Solflare, Backpack etc. register themselves via the Wallet Standard
  const wallets = useMemo(() => [], []);
  const endpoint = useMemo(() => getBrowserRpcUrl(), []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
          <WalletProvider wallets={wallets} autoConnect>
            <WalletModalProvider>
              <ChainProvider>
                <ToastProvider>{children}</ToastProvider>
              </ChainProvider>
            </WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
