"use client";

import { ParsedTweet } from "@/app/api/x-feed/route";
import { ChainSelector, useLaunchChain } from "@/components/ChainProvider";
import { SolanaFastLaunchModal } from "@/components/solana/SolanaFastLaunchModal";
import { PonsFastLaunchModal } from "@/components/pons/PonsFastLaunchModal";

interface FastLaunchModalProps {
  tweet: ParsedTweet | null;
  isOpen: boolean;
  onClose: () => void;
}

/** Radar 1-click launch: same tweet, launched on whichever chain is selected. */
export function FastLaunchModal(props: FastLaunchModalProps) {
  const { chain } = useLaunchChain();
  const switcher = (
    <div className="flex items-center justify-between text-xs">
      <span className="font-semibold text-zinc-400">Launch on:</span>
      <ChainSelector />
    </div>
  );

  return chain === "robinhood" ? (
    <PonsFastLaunchModal {...props} headerExtra={switcher} />
  ) : (
    <SolanaFastLaunchModal {...props} headerExtra={switcher} />
  );
}
