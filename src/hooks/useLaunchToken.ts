import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import type { Global } from "@pump-fun/pump-sdk";
import { buildCreateTokenTx, fetchProtocolState, graduationTargetSol, launchFeeSchedule, parseAmount, type PumpProtocolState } from "@/lib/pump";
import { SOL_DECIMALS } from "@/config/solana";
import { useSolanaTx } from "@/hooks/useSolanaTx";

// Rough network cost of create_v2: mint + bonding curve + metadata rent and fees
export const ESTIMATED_CREATE_COST_SOL = 0.025;

/** pump.fun global config + the connected wallet's SOL balance, for the launch forms. */
export function useLaunchConfig() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [protocol, setProtocol] = useState<PumpProtocolState | null>(null);
  const global: Global | null = protocol?.global ?? null;
  const [balanceLamports, setBalanceLamports] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchProtocolState(connection)
      .then((s) => alive && setProtocol(s))
      .catch((e) => console.warn("Could not load pump.fun global config:", e));
    return () => {
      alive = false;
    };
  }, [connection]);

  useEffect(() => {
    // Reset right away so a newly selected wallet never shows the previous wallet's balance
    setBalanceLamports(null);
    setBalanceError(null);
    if (!publicKey) return;
    let alive = true;
    const load = () =>
      connection
        .getBalance(publicKey)
        .then((b) => {
          if (!alive) return;
          setBalanceLamports(b);
          setBalanceError(null);
        })
        .catch((e) => {
          console.warn("Could not load SOL balance:", e);
          if (alive) setBalanceError("Could not read balance from RPC");
        });
    load();
    const id = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [connection, publicKey]);

  return {
    global,
    walletAddress: publicKey?.toBase58() ?? null,
    balanceError,
    balanceSol: balanceLamports === null ? null : balanceLamports / 10 ** SOL_DECIMALS,
    graduationTargetSol: global ? graduationTargetSol(global) : null,
    feeSchedule: protocol ? launchFeeSchedule(protocol) : null,
  };
}

export interface LaunchInput {
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  devBuySol: string;
}

export type LaunchStep = "idle" | "metadata" | "signing" | "confirming" | "done";

export function useLaunchToken() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { send, status } = useSolanaTx();
  const [step, setStep] = useState<LaunchStep>("idle");

  const launch = useCallback(
    async (input: LaunchInput): Promise<{ mint: string; signature: string }> => {
      if (!publicKey) throw new Error("Connect your Solana wallet first.");
      setStep("metadata");
      try {
        // 1. Pin logo + metadata JSON to IPFS
        const metaRes = await fetch("/api/metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: input.name,
            symbol: input.symbol,
            description: input.description,
            imageUrl: input.imageUrl,
            twitter: input.twitter,
            telegram: input.telegram,
            website: input.website,
          }),
        });
        const meta = await metaRes.json();
        if (!metaRes.ok || !meta.metadataUri) throw new Error(meta.error || "Metadata upload failed");

        // 2. Build create_v2 (+ dev buy) and sign with wallet + fresh mint keypair
        setStep("signing");
        const devBuyLamports: BN = parseAmount(input.devBuySol, SOL_DECIMALS);
        const { tx, mint } = await buildCreateTokenTx({
          connection,
          user: publicKey,
          name: input.name,
          symbol: input.symbol,
          metadataUri: meta.metadataUri,
          devBuyLamports,
        });
        const signature = await send(tx, [mint]);
        const mintAddress = mint.publicKey.toBase58();

        // 3. Register in the platform explorer (best effort)
        fetch("/api/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: mintAddress,
            deployer: publicKey.toBase58(),
            name: input.name,
            symbol: input.symbol,
            logo: meta.image || input.imageUrl,
            description: input.description,
            metadataUri: meta.metadataUri,
            txHash: signature,
          }),
        }).catch((e) => console.warn("Could not register token to platform API:", e));

        setStep("done");
        return { mint: mintAddress, signature };
      } catch (err) {
        setStep("idle");
        throw err;
      }
    },
    [connection, publicKey, send]
  );

  // Mirror wallet signing/confirming progress
  const effectiveStep: LaunchStep = step === "signing" && status === "confirming" ? "confirming" : step;

  return { launch, step: effectiveStep, isBusy: effectiveStep !== "idle" && effectiveStep !== "done" };
}

export function launchStepLabel(step: LaunchStep): string {
  switch (step) {
    case "metadata":
      return "Uploading metadata to IPFS...";
    case "signing":
      return "Confirm in wallet...";
    case "confirming":
      return "Deploying on pump.fun...";
    case "done":
      return "Launched!";
    default:
      return "";
  }
}
