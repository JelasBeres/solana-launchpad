"use client";

import { ChainSelector, useLaunchChain } from "@/components/ChainProvider";
import SolanaDocs from "@/components/solana/SolanaDocs";
import PonsDocs from "@/components/pons/PonsDocs";

export default function DocsPage() {
  const { chain } = useLaunchChain();

  return (
    <div className="space-y-6">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Documentation for</span>
        <ChainSelector />
      </div>
      {chain === "robinhood" ? <PonsDocs /> : <SolanaDocs />}
    </div>
  );
}
