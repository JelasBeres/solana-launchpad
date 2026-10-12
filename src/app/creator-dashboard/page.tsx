"use client";

import { ChainSelector, useLaunchChain } from "@/components/ChainProvider";
import SolanaCreatorFees from "@/components/solana/SolanaCreatorFees";
import PonsCreatorFees from "@/components/pons/PonsCreatorFees";

export default function CreatorDashboardPage() {
  const { chain } = useLaunchChain();

  return (
    <div className="space-y-6">
      <div className="max-w-4xl mx-auto flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Fees earned on</span>
        <ChainSelector />
      </div>
      {chain === "robinhood" ? <PonsCreatorFees /> : <SolanaCreatorFees />}
    </div>
  );
}
