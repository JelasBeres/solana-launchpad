"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { chainForAddress, useLaunchChain } from "@/components/ChainProvider";
import SolanaTokenView from "@/components/solana/SolanaTokenView";
import PonsTokenView from "@/components/pons/PonsTokenView";

export default function TokenDetailPage() {
  const params = useParams();
  const tokenChain = chainForAddress(String(params.address || ""));
  const { chain, setChain } = useLaunchChain();

  // Keep the navbar wallet on the token's chain
  useEffect(() => {
    if (chain !== tokenChain) setChain(tokenChain);
  }, [chain, tokenChain, setChain]);

  return tokenChain === "robinhood" ? <PonsTokenView /> : <SolanaTokenView />;
}
