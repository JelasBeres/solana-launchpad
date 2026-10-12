"use client";

import { ChainSelector, useLaunchChain } from "@/components/ChainProvider";
import SolanaCreateForm from "@/components/solana/SolanaCreateForm";
import PonsCreateForm from "@/components/pons/PonsCreateForm";

export default function CreateTokenPage() {
  const { chain } = useLaunchChain();

  return (
    <div className="space-y-6">
      <div className="max-w-5xl mx-auto space-y-2">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Choose where to launch</span>
        <ChainSelector size="large" />
      </div>
      {chain === "robinhood" ? <PonsCreateForm /> : <SolanaCreateForm />}
    </div>
  );
}
