"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Rocket, X, Loader2, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";
import { ParsedTweet } from "@/app/api/x-feed/route";
import { useToast } from "@/components/Toast";
import { ESTIMATED_CREATE_COST_SOL, launchStepLabel, useLaunchConfig, useLaunchToken } from "@/hooks/useLaunchToken";
import { shortTxError } from "@/hooks/useSolanaTx";

interface FastLaunchModalProps {
  tweet: ParsedTweet | null;
  isOpen: boolean;
  onClose: () => void;
  headerExtra?: React.ReactNode;
}


export function SolanaFastLaunchModal({ tweet, isOpen, onClose, headerExtra }: FastLaunchModalProps) {
  const router = useRouter();
  const toast = useToast();
  const { connected: isConnected } = useWallet();
  const { setVisible: openWalletModal } = useWalletModal();
  const { balanceSol, feeSchedule } = useLaunchConfig();
  const { launch, step, isBusy } = useLaunchToken();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [description, setDescription] = useState("");
  const [devBuySol, setDevBuySol] = useState("");
  const [website, setWebsite] = useState("");
  const [statusError, setStatusError] = useState<string | null>(null);

  // Initialize or reset from tweet
  useEffect(() => {
    if (tweet) {
      setName((tweet.suggestedToken?.name || "Lockey Narrative").slice(0, 32));
      setSymbol((tweet.suggestedToken?.symbol || "LOCK").slice(0, 10));

      const mediaImage = tweet.media?.[0]?.url;
      setLogoUrl(mediaImage || tweet.author.profileImageUrl || "/logo.png");

      const tweetSource = tweet.tweetUrl ? `\n\nInspired by @${tweet.author.username}: ${tweet.tweetUrl}` : "";
      setDescription(`"${tweet.text}"${tweetSource}`);

      const tweetPostLink = tweet.tweetUrl || (tweet.author?.username ? `https://x.com/${tweet.author.username}` : "");
      setWebsite(tweetPostLink);

      setDevBuySol("");
      setStatusError(null);
    }
  }, [tweet]);

  if (!isOpen || !tweet) return null;

  const isLaunched = step === "done";
  const devBuy = devBuySol && Number(devBuySol) > 0 ? Number(devBuySol) : 0;
  const totalRequiredSol = ESTIMATED_CREATE_COST_SOL + devBuy;
  const isInsufficientSol = balanceSol !== null && balanceSol < totalRequiredSol;

  const handleFastLaunch = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusError(null);

    if (!isConnected) {
      openWalletModal(true);
      return;
    }

    if (!name.trim() || !symbol.trim()) {
      setStatusError("Name and symbol are required.");
      return;
    }

    try {
      const { mint, signature } = await launch({
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        description: description.trim(),
        imageUrl: logoUrl.trim() || "/logo.png",
        twitter: tweet.tweetUrl || `https://x.com/${tweet.author.username}`,
        website: website.trim() || tweet.tweetUrl || "",
        devBuySol,
      });
      toast.success("Token Launched on pump.fun!", "Redirecting to the bonding curve...", signature);
      setTimeout(() => {
        onClose();
        router.push(`/token/${mint}`);
      }, 1200);
    } catch (err: unknown) {
      console.error("Fast launch error:", err);
      setStatusError(shortTxError(err));
    }
  };

  const handleOpenInFullStudio = () => {
    onClose();
    const params = new URLSearchParams({
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(),
      logo: logoUrl.trim(),
      desc: description.trim(),
      twitter: tweet.tweetUrl || "",
      chain: "solana",
    });
    router.push(`/create?${params.toString()}`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-xl bg-[#121318] p-6 sm:p-8 space-y-6 rounded-2xl border border-zinc-800 shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-yellow-400/10 border border-yellow-400/30 flex items-center justify-center text-yellow-400">
              <Rocket className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <h2 className="text-xl font-extrabold text-white tracking-tight">
                Instant Narrative Launch
              </h2>
              <p className="text-xs text-zinc-400">
                Deploying token on pump.fun (Solana)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {headerExtra}

        {/* Origin Tweet Summary */}
        <div className="p-3.5 rounded-xl bg-zinc-900/80 border border-zinc-800 flex items-start space-x-3 text-xs">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={tweet.author.profileImageUrl}
            alt={tweet.author.name}
            className="w-8 h-8 rounded-full border border-yellow-500/40 object-cover shrink-0"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center space-x-1.5 font-semibold text-white">
              <span className="truncate">{tweet.author.name}</span>
              <span className="text-yellow-400 font-mono text-[11px]">@{tweet.author.username}</span>
            </div>
            <p className="text-zinc-300 text-xs line-clamp-2 mt-0.5 font-sans leading-relaxed">
              &ldquo;{tweet.text}&rdquo;
            </p>
          </div>
        </div>

        {/* Launch Form */}
        <form onSubmit={handleFastLaunch} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                Token Name *
              </label>
              <input
                type="text"
                required
                maxLength={32}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg bg-zinc-950 border border-zinc-700/80 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-yellow-400 transition-colors font-sans"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                Ticker / Symbol *
              </label>
              <input
                type="text"
                required
                maxLength={10}
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                className="w-full px-3.5 py-2.5 rounded-lg bg-zinc-950 border border-zinc-700/80 text-sm uppercase text-yellow-400 font-bold focus:outline-none focus:border-yellow-400 transition-colors font-mono"
              />
            </div>
          </div>

          {/* Logo Preview & URL */}
          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
              Logo URL (Auto-filled from Tweet / Avatar)
            </label>
            <div className="flex items-center space-x-3">
              <div className="w-11 h-11 rounded-lg border border-yellow-500/40 bg-zinc-900 overflow-hidden shrink-0 flex items-center justify-center p-0.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoUrl || "/logo.png"}
                  alt="Preview"
                  className="w-full h-full object-cover rounded-md"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = "/logo.png";
                  }}
                />
              </div>
              <input
                type="text"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="https://... or ipfs://..."
                className="flex-1 px-3.5 py-2.5 rounded-lg bg-zinc-950 border border-zinc-700/80 text-xs font-mono text-zinc-200 focus:outline-none focus:border-yellow-400 transition-colors"
              />
            </div>
          </div>

          {/* Website / Tweet Post Link */}
          <div>
            <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
              Website / Tweet Post Link
            </label>
            <input
              type="url"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://x.com/..."
              className="w-full px-3.5 py-2.5 rounded-lg bg-zinc-950 border border-zinc-700/80 text-xs font-mono text-zinc-200 focus:outline-none focus:border-yellow-400 transition-colors"
            />
          </div>

          {/* Initial Dev Buy */}
          <div className="p-3.5 rounded-xl bg-zinc-900/80 border border-zinc-800 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-white block">
                Initial Dev Buy (Optional)
              </span>
              <span className="text-[11px] text-zinc-400 block font-sans">
                Buy the first batch on the curve in SOL
              </span>
            </div>
            <div className="w-32 relative">
              <input
                type="number"
                step="0.0001"
                min="0"
                placeholder="0.0 SOL"
                value={devBuySol}
                onChange={(e) => setDevBuySol(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-xs font-mono text-white text-right focus:outline-none focus:border-yellow-400"
              />
            </div>
          </div>

          {/* Trading fees (fixed by pump.fun for SOL-paired coins) */}
          {feeSchedule && (
            <p className="text-[11px] text-zinc-400">
              Trading fee {(feeSchedule.protocolBps + feeSchedule.creatorBps) / 100}% per trade: creator {feeSchedule.creatorBps / 100}% to you,
              pump.fun {feeSchedule.protocolBps / 100}%. Set by pump.fun; for a custom fee, switch to Robinhood.
            </p>
          )}

          {/* Error Message */}
          {statusError && (
            <p className="text-xs text-rose-400 flex items-center space-x-1.5">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{statusError}</span>
            </p>
          )}

          {/* Insufficient balance warning */}
          {isInsufficientSol && (
            <p className="text-xs text-amber-300 flex items-center space-x-1.5">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>Insufficient SOL balance for launch cost (~{ESTIMATED_CREATE_COST_SOL} SOL) + dev buy.</span>
            </p>
          )}

          {/* Success state */}
          {isLaunched && (
            <div className="p-3 rounded-xl bg-yellow-400/10 border border-yellow-400/40 text-yellow-300 text-xs font-semibold flex items-center space-x-2">
              <CheckCircle2 className="w-4 h-4 text-yellow-400 animate-bounce" />
              <span>Token deployed on pump.fun! Redirecting to curve...</span>
            </div>
          )}

          {/* Actions */}
          <div className="pt-2 flex flex-col sm:flex-row items-center gap-3">
            <button
              type="submit"
              disabled={isBusy || isLaunched || (isConnected && isInsufficientSol)}
              className="w-full sm:flex-1 py-3 rounded-lg bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-sm flex items-center justify-center space-x-2 disabled:opacity-50 transition-colors shadow-sm"
            >
              {isBusy ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-black" />
                  <span>{launchStepLabel(step)}</span>
                </>
              ) : (
                <>
                  <Rocket className="w-4 h-4" />
                  <span>{isConnected ? "🚀 1-Click Launch Token" : "Connect Wallet"}</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleOpenInFullStudio}
              className="w-full sm:w-auto px-4 py-3 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-semibold text-zinc-300 hover:text-yellow-400 flex items-center justify-center space-x-1 transition-colors"
            >
              <span>Customize in Studio</span>
              <ExternalLink className="w-3.5 h-3.5 ml-1" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
