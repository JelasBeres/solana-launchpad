"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Coins, Sparkles, Loader2, ShieldCheck } from "lucide-react";
import { creatorVaultPda } from "@pump-fun/pump-sdk";
import { useToast } from "@/components/Toast";
import { useSolanaTx, shortTxError } from "@/hooks/useSolanaTx";
import { buildClaimCreatorFeesTx, fetchCreatorFeeBalance, lamportsToSol } from "@/lib/pump";
import { explorerAccountUrl } from "@/config/solana";

export default function SolanaCreatorFees() {
  const toast = useToast();
  const { connection } = useConnection();
  const { publicKey, connected: isConnected } = useWallet();
  const { setVisible: openWalletModal } = useWalletModal();
  const { send, isBusy: isClaiming } = useSolanaTx();
  const [claimableSol, setClaimableSol] = useState(0);

  // Creator fees waiting in the pump.fun + PumpSwap creator vaults
  const refetchClaimable = useCallback(async () => {
    if (!publicKey) {
      setClaimableSol(0);
      return;
    }
    try {
      const lamports = await fetchCreatorFeeBalance(connection, publicKey);
      setClaimableSol(lamportsToSol(lamports));
    } catch (err) {
      console.warn("Failed to fetch creator vault balance:", err);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    refetchClaimable();
    const id = setInterval(refetchClaimable, 10000);
    return () => clearInterval(id);
  }, [refetchClaimable]);

  const vaultAddress = publicKey ? creatorVaultPda(publicKey).toBase58() : "";
  const formattedClaimable = claimableSol;

  const handleClaim = async () => {
    if (!publicKey) {
      openWalletModal(true);
      return;
    }
    try {
      const tx = await buildClaimCreatorFeesTx(connection, publicKey);
      const signature = await send(tx);
      toast.success("Creator Fees Claimed!", "Accumulated SOL fees have been transferred to your wallet.", signature);
      refetchClaimable();
    } catch (err) {
      console.error("Claim failed:", err);
      toast.error("Claim Failed", shortTxError(err));
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-20">
      <div className="space-y-2">
        <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-md bg-yellow-400/10 text-yellow-400 text-xs font-mono font-bold tracking-wide border border-yellow-400/30">
          <Sparkles className="w-4 h-4 text-yellow-400" />
          <span>pump.fun Creator Payouts • Solana</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight flex items-center space-x-2">
          <span>Creator Fees</span>
          <span className="text-3xl">💰</span>
        </h1>
        <p className="text-sm text-zinc-400">
          Claim the creator fees earned by every pump.fun coin you created, straight from your pump.fun and PumpSwap creator vaults.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div className="p-6 bg-[#121318] border border-zinc-800 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">Royalty Payout Asset</span>
          <div className="text-3xl font-bold font-mono text-yellow-400">Native SOL</div>
          <p className="text-xs text-zinc-400 leading-relaxed font-sans">
            Creator fees accrue in SOL on every buy &amp; sell, both on the bonding curve and on PumpSwap after graduation.
          </p>
        </div>

        <div className="p-6 bg-[#121318] border border-zinc-800 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">Your Creator Vault</span>
          <div className="text-xs font-mono text-yellow-400 truncate">
            {vaultAddress ? (
              <a href={explorerAccountUrl(vaultAddress)} target="_blank" rel="noopener noreferrer" className="hover:underline">
                {vaultAddress}
              </a>
            ) : (
              "Connect wallet to view"
            )}
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed font-sans">
            A program-owned account (PDA) derived from your wallet. Only you can withdraw from it.
          </p>
        </div>
      </div>

      {/* Claim Voucher Card */}
      <div className="p-6 sm:p-8 space-y-6 bg-[#121318] border border-zinc-800 rounded-2xl shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5 pb-6 border-b border-zinc-800">
          <div className="space-y-1">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">
              Claimable Creator Fees
            </span>
            <div className="text-4xl sm:text-5xl font-bold font-mono text-white flex items-center space-x-3">
              <Coins className="w-9 h-9 text-yellow-400" />
              <span>{formattedClaimable.toFixed(6)} SOL</span>
            </div>
            <p className="text-xs text-zinc-400 font-sans">
              Available for withdrawal to your wallet anytime with zero vesting or lockup.
            </p>
          </div>

          <button
            onClick={handleClaim}
            disabled={(isConnected && formattedClaimable === 0) || isClaiming}
            className="py-3 px-7 rounded-lg bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-base flex items-center justify-center space-x-2 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 transition-colors shadow-sm"
          >
            {isClaiming ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin text-black" />
                <span>Claiming SOL...</span>
              </>
            ) : (
              <span>{!isConnected ? "Connect Wallet" : `Claim ${formattedClaimable > 0 ? `${formattedClaimable.toFixed(4)} SOL` : "Fees"}`}</span>
            )}
          </button>
        </div>

        <div className="p-4 sketch-surface rounded-sketch space-y-2 text-xs font-hand text-slate-300">
          <div className="font-bold text-white text-sm flex items-center space-x-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>How Do Creator Fees Work?</span>
          </div>
          <p className="leading-relaxed text-slate-400 text-xs">
            Every trade of a coin you created pays a creator fee to your pump.fun creator vault (and to your PumpSwap vault once the coin graduates). Claiming collects both vaults into your wallet in one transaction, with no extra platform fee.
          </p>
        </div>
      </div>
    </div>
  );
}
