"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Rocket, Info, AlertCircle, CheckCircle2, Sparkles, UploadCloud, X, Loader2, Coins, Globe, MessageSquare, Send } from "lucide-react";
import { useToast } from "@/components/Toast";
import { ESTIMATED_CREATE_COST_SOL, launchStepLabel, useLaunchConfig, useLaunchToken } from "@/hooks/useLaunchToken";
import { shortTxError } from "@/hooks/useSolanaTx";
import { CLUSTER_LABEL } from "@/config/solana";


export default function SolanaCreateForm() {
  const router = useRouter();
  const toast = useToast();
  const { connected: isConnected } = useWallet();
  const { setVisible: openWalletModal } = useWalletModal();
  const { global, walletAddress, balanceError, balanceSol, graduationTargetSol, feeSchedule } = useLaunchConfig();
  const [devBuyHint, setDevBuyHint] = useState<string | null>(null);
  const { launch, step, isBusy } = useLaunchToken();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [discord, setDiscord] = useState("");

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Optional Initial Dev Buy (in SOL)
  const [devBuyAmount, setDevBuyAmount] = useState<string>("");

  // Image Upload States
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);


  // Pre-fill from URL query parameters (from X Narrative Radar)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const searchParams = new URLSearchParams(window.location.search);
      const qName = searchParams.get("name");
      const qSymbol = searchParams.get("symbol");
      const qDesc = searchParams.get("desc") || searchParams.get("description");
      const qLogo = searchParams.get("logo") || searchParams.get("imageUrl");
      const qTwitter = searchParams.get("twitter");
      const qWebsite = searchParams.get("website");

      if (qName) setName(qName);
      if (qSymbol) setSymbol(qSymbol);
      if (qDesc) setDescription(qDesc);
      if (qLogo) {
        setImageUrl(qLogo);
        setImagePreview(qLogo);
      }
      if (qTwitter) setTwitter(qTwitter);
      if (qWebsite) {
        setWebsite(qWebsite);
      } else if (qTwitter) {
        setWebsite(qTwitter);
      }
    }
  }, []);

  const uploadImage = async (file: File) => {
    setIsUploadingImage(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      let data: any;
      try {
        data = await res.json();
      } catch {
        if (res.status === 413) {
          throw new Error("Image exceeds web server size limit (HTTP 413). Please upload an image under 1MB or update Nginx client_max_body_size.");
        }
        throw new Error(`Upload failed with server status ${res.status}`);
      }

      if (!res.ok) {
        throw new Error(data.error || "Failed to upload image");
      }

      const resolvedUrl = data.url || data.catboxUrl;
      setImageUrl(resolvedUrl);
    } catch (err: unknown) {
      console.error("Image upload error:", err);
      const msg = err instanceof Error ? err.message : "Failed to upload image";
      setUploadError(msg);
    } finally {
      setIsUploadingImage(false);
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      setUploadError("File size exceeds 5MB limit");
      return;
    }

    setImageFile(file);
    const previewUrl = URL.createObjectURL(file);
    setImagePreview(previewUrl);

    uploadImage(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setUploadError("File must be an image format (PNG, JPG, WebP, GIF, SVG)");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setUploadError("File size exceeds 5MB limit");
      return;
    }

    setImageFile(file);
    const previewUrl = URL.createObjectURL(file);
    setImagePreview(previewUrl);

    uploadImage(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleRemoveImage = () => {
    setImageFile(null);
    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }
    setImagePreview(null);
    setImageUrl("");
    setUploadError(null);
  };

  const devBuySol = devBuyAmount && Number(devBuyAmount) > 0 ? Number(devBuyAmount) : 0;
  const totalRequiredSol = ESTIMATED_CREATE_COST_SOL + devBuySol;
  const isInsufficientSol = balanceSol !== null && balanceSol < totalRequiredSol;

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!name || !symbol) return;
    if (!isConnected) {
      openWalletModal(true);
      return;
    }
    if (!imageUrl) {
      setErrorMessage("Upload a logo image first, pump.fun coins require one.");
      return;
    }

    try {
      const { mint, signature } = await launch({
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        description: description.trim(),
        imageUrl,
        twitter: twitter.trim(),
        telegram: telegram.trim(),
        website: website.trim() || discord.trim(),
        devBuySol: devBuyAmount,
      });

      toast.success("Token Launched on pump.fun!", "Entering live bonding curve trading page...", signature);
      setTimeout(() => router.push(`/token/${mint}`), 1200);
    } catch (err: unknown) {
      console.error(err);
      const msg = shortTxError(err);
      toast.error("Deployment Error", msg);
      setErrorMessage(msg);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-20">
      {/* Header Banner */}
      <div className="space-y-2">
        <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-md bg-yellow-400/10 text-yellow-400 text-xs font-mono font-bold tracking-wide border border-yellow-400/30">
          <Sparkles className="w-4 h-4 text-yellow-400" />
          <span>Creator Blueprint • pump.fun on Solana</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight flex items-center space-x-2">
          <span>Launch Meme Token</span>
          <span className="text-3xl">🚀</span>
        </h1>
        <p className="text-sm text-zinc-400">
          Deploy a pump.fun token with an automated bonding curve. When the curve completes, liquidity migrates to PumpSwap automatically.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Form: Blueprint Sketchpad */}
        <form onSubmit={handleDeploy} className="lg:col-span-7 space-y-6 bg-[#121318] border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-sm relative">

          <div className="space-y-5">
            <div>
              <label className="block text-base font-hand font-bold text-slate-200 mb-1">
                Token Name *
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Solana Doge"
                value={name}
                maxLength={32}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-4 py-2.5 sketch-inset text-sm font-hand text-white placeholder:text-slate-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-base font-hand font-bold text-slate-200 mb-1">
                Ticker Symbol *
              </label>
              <input
                type="text"
                required
                placeholder="e.g. SDOGE"
                value={symbol}
                maxLength={10}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                className="w-full px-4 py-2.5 sketch-inset text-sm text-white uppercase font-mono placeholder:text-slate-500 focus:outline-none"
              />
            </div>

            {/* Trading fees (set by pump.fun, not by the creator) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-base font-hand font-bold text-slate-200">Trading Fees</label>
                <span className="text-sm font-mono text-yellow-300 font-bold">
                  {feeSchedule ? `${(feeSchedule.protocolBps + feeSchedule.creatorBps) / 100}% per trade` : "..."}
                </span>
              </div>
              {!global ? (
                <p className="text-xs font-hand text-slate-400 flex items-center space-x-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Loading pump.fun fee settings...</span>
                </p>
              ) : (
                <div className="p-3 sketch-surface text-xs font-hand space-y-1.5">
                  <div className="flex justify-between text-slate-300">
                    <span>Creator fee (to your wallet)</span>
                    <span className="font-mono font-bold text-yellow-300">{feeSchedule ? `${feeSchedule.creatorBps / 100}%` : "-"}</span>
                  </div>
                  <div className="flex justify-between text-slate-300">
                    <span>pump.fun protocol fee</span>
                    <span className="font-mono text-slate-200">{feeSchedule ? `${feeSchedule.protocolBps / 100}%` : "-"}</span>
                  </div>
                  <p className="text-slate-500 pt-1 leading-relaxed">
                    pump.fun sets these rates for every SOL-paired coin, so the creator fee can&apos;t be changed at launch. Rates follow
                    pump.fun&apos;s market-cap tiers. For a custom creator fee, launch on Robinhood (Pons v2).
                  </p>
                </div>
              )}
            </div>

            <div>
              <label className="block text-base font-hand font-bold text-slate-200 mb-1">
                Project Description (Optional)
              </label>
              <textarea
                rows={3}
                placeholder="Tell the story of your meme token and community vision..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-4 py-2.5 sketch-inset text-sm font-hand text-white placeholder:text-slate-500 focus:outline-none"
              />
            </div>

            {/* Pinata IPFS Image Upload Zone in Sketch Style */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-base font-hand font-bold text-slate-200">
                  Token Logo / Image *
                </label>
                {imageUrl && (
                  <span className="text-xs font-hand text-emerald-400 font-bold flex items-center space-x-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Image Ready</span>
                  </span>
                )}
              </div>

              {imagePreview ? (
                <div className="relative sketch-surface p-4 flex items-center space-x-4">
                  <div className="relative w-16 h-16 rounded-sketch overflow-hidden bg-[#061426] border-2 border-sky-400 shrink-0 flex items-center justify-center shadow-sketch-sm">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={imagePreview}
                      alt="Token Preview"
                      className="w-full h-full object-cover rounded-sketch"
                    />
                    {isUploadingImage && (
                      <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
                        <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="text-sm font-hand font-bold text-white truncate">
                      {imageFile?.name || "Uploaded Image"}
                    </p>
                    {isUploadingImage ? (
                      <p className="text-xs font-hand text-sky-300 flex items-center space-x-1">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Uploading image...</span>
                      </p>
                    ) : imageUrl ? (
                      <p className="text-[11px] font-mono text-emerald-400 truncate">
                        {imageUrl}
                      </p>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    onClick={handleRemoveImage}
                    disabled={isUploadingImage}
                    className="p-1.5 sketch-btn-secondary text-slate-400 hover:text-rose-400"
                    title="Remove image"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  className={`relative border-2 border-dashed rounded-xl p-6 text-center transition cursor-pointer ${
                    isDragging
                      ? "border-yellow-400 bg-yellow-400/10"
                      : "border-zinc-750 hover:border-yellow-400/80 bg-zinc-950/60"
                  }`}
                >
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleImageSelect}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    disabled={isUploadingImage}
                  />
                  <div className="flex flex-col items-center justify-center space-y-2 pointer-events-none">
                    <div className="w-12 h-12 rounded-sketch sketch-btn-primary flex items-center justify-center text-slate-950">
                      <UploadCloud className="w-6 h-6" />
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-base font-hand font-bold text-white">
                        Drag &amp; drop logo image here, or <span className="text-sky-400 underline">browse files</span>
                      </p>
                      <p className="text-xs font-hand text-slate-400">
                        PNG, JPG, WebP, GIF up to 5MB
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {uploadError && (
                <p className="mt-2 text-xs font-hand text-rose-400 flex items-center space-x-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{uploadError}</span>
                </p>
              )}
            </div>

            {/* Social Links */}
            <div className="space-y-3 pt-2">
              <label className="block text-base font-hand font-bold text-slate-200">
                Social Links &amp; Community
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="relative">
                  <Globe className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="url"
                    placeholder="Website URL"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 sketch-inset text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none"
                  />
                </div>
                <div className="relative">
                  <span className="text-slate-500 font-bold absolute left-3.5 top-2 text-xs">𝕏</span>
                  <input
                    type="text"
                    placeholder="Twitter / X"
                    value={twitter}
                    onChange={(e) => setTwitter(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 sketch-inset text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none"
                  />
                </div>
                <div className="relative">
                  <Send className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    placeholder="Telegram"
                    value={telegram}
                    onChange={(e) => setTelegram(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 sketch-inset text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none"
                  />
                </div>
                <div className="relative">
                  <MessageSquare className="w-4 h-4 text-slate-500 absolute left-3.5 top-3" />
                  <input
                    type="text"
                    placeholder="Discord"
                    value={discord}
                    onChange={(e) => setDiscord(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 sketch-inset text-xs font-mono text-white placeholder:text-slate-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Optional Dev Buy Section */}
            <div className="pt-4 border-t border-zinc-800 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-base font-hand font-bold text-slate-200 flex items-center space-x-1.5">
                  <Coins className="w-4 h-4 text-yellow-300" />
                  <span>Initial Dev Buy (Optional)</span>
                </label>
                <span className="text-xs text-slate-400 font-mono">
                  {!walletAddress
                    ? "Wallet not connected"
                    : balanceSol !== null
                      ? `Balance: ${balanceSol.toFixed(4)} SOL`
                      : balanceError
                        ? "Balance unavailable"
                        : "Loading balance..."}
                </span>
              </div>
              
              <p className="text-xs font-hand text-slate-400 leading-relaxed">
                Buy the first tokens in the same transaction as the launch, so nobody can snipe ahead of you.
              </p>

              <div className="relative">
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="0.0 (SOL)"
                  value={devBuyAmount}
                  onChange={(e) => setDevBuyAmount(e.target.value)}
                  className="w-full px-4 py-2.5 sketch-inset text-sm text-white font-mono placeholder:text-slate-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    setDevBuyHint(null);
                    if (!walletAddress) {
                      openWalletModal(true);
                      return;
                    }
                    if (balanceSol === null) {
                      setDevBuyHint(balanceError ? "Could not read your balance. Check the RPC connection and try again." : "Balance is still loading, try again in a moment.");
                      return;
                    }
                    const safeMax = balanceSol - ESTIMATED_CREATE_COST_SOL - 0.01;
                    if (safeMax <= 0) {
                      setDevBuyHint(
                        `Balance ${balanceSol.toFixed(4)} SOL only covers the launch cost (~${ESTIMATED_CREATE_COST_SOL} SOL + 0.01 buffer). ` +
                          `Top up SOL on ${CLUSTER_LABEL}${balanceSol === 0 ? ", and make sure your wallet is on " + CLUSTER_LABEL + ", not Devnet/Testnet" : ""}.`
                      );
                      return;
                    }
                    setDevBuyAmount(safeMax.toFixed(4));
                  }}
                  className="absolute right-3 top-2 px-3 py-0.5 text-xs font-hand font-bold sketch-btn-secondary text-sky-300"
                >
                  MAX
                </button>
              </div>
              {walletAddress && (
                <p className="text-[11px] font-mono text-slate-500">
                  Wallet {walletAddress.slice(0, 4)}...{walletAddress.slice(-4)} • Solana {CLUSTER_LABEL}
                </p>
              )}
              {devBuyHint && (
                <p className="text-xs font-hand text-amber-300 flex items-start space-x-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{devBuyHint}</span>
                </p>
              )}
            </div>

            {/* Protocol Cost Summary Note */}
            <div className="p-4 sketch-surface space-y-2 text-xs font-hand">
              <div className="flex justify-between items-center text-slate-300 text-sm">
                <span className="flex items-center space-x-1.5">
                  <Info className="w-4 h-4 text-sky-400" />
                  <span>Network Cost (rent + fees, est.)</span>
                </span>
                <span className="font-mono font-bold text-white">
                  ~{ESTIMATED_CREATE_COST_SOL} SOL
                </span>
              </div>
              {devBuySol > 0 && (
                <div className="flex justify-between items-center text-slate-300 text-sm">
                  <span>Initial Dev Buy</span>
                  <span className="font-mono font-bold text-yellow-300">
                    {devBuySol} SOL
                  </span>
                </div>
              )}
              <div className="flex justify-between items-center text-slate-200 pt-2 border-t border-slate-700 text-sm">
                <span className="font-bold">Total SOL Required (est.)</span>
                <span className="font-mono font-bold text-emerald-400 text-base">
                  ~{totalRequiredSol.toFixed(4)} SOL
                </span>
              </div>
            </div>

            {isInsufficientSol && (
              <div className="p-3 sketch-card border-rose-500/40 text-rose-300 text-xs font-hand font-bold flex items-center space-x-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>Insufficient SOL balance for launch cost + dev buy.</span>
              </div>
            )}

            {errorMessage && (
              <div className="p-4 sketch-card border-rose-500/40 text-rose-300 text-xs font-hand font-bold flex items-start space-x-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isBusy || isUploadingImage || (isConnected && isInsufficientSol)}
              className="w-full py-3.5 sketch-btn-primary text-slate-950 font-bold text-xl flex items-center justify-center space-x-2 disabled:opacity-50"
            >
              {isBusy ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>{launchStepLabel(step)}</span>
                </>
              ) : !isConnected ? (
                <span>Connect Wallet</span>
              ) : (
                <>
                  <Rocket className="w-6 h-6" />
                  <span>Launch Token (~{totalRequiredSol.toFixed(3)} SOL)</span>
                </>
              )}
            </button>
          </div>
        </form>

        {/* Right Column: Live Card Preview */}
        <div className="lg:col-span-5 space-y-6 lg:sticky lg:top-24">
          <div className="p-6 space-y-4 relative bg-[#121318] border border-zinc-800 rounded-2xl shadow-sm">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <span className="text-sm font-semibold text-yellow-400 uppercase tracking-wider flex items-center space-x-1.5">
                <Sparkles className="w-4 h-4 text-yellow-400" />
                <span>Token Card Preview</span>
              </span>
              <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-yellow-400/10 text-yellow-400 border border-yellow-400/30">
                Live Draft
              </span>
            </div>

            <div className="flex items-start space-x-4 pt-1">
              <div className="w-16 h-16 rounded-xl overflow-hidden bg-zinc-950 border border-yellow-500/40 shrink-0 flex items-center justify-center p-1">
                {imagePreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={imagePreview} alt="Preview" className="w-full h-full object-cover rounded-lg" />
                ) : (
                  <span className="text-2xl">🪙</span>
                )}
              </div>
              <div className="min-w-0">
                <h3 className="text-xl font-bold text-white truncate">
                  {name.trim() || "Your Token Name"}
                </h3>
                <span className="text-xs px-2.5 py-0.5 rounded-md bg-yellow-400/10 text-yellow-400 font-mono font-bold uppercase border border-yellow-400/30">
                  ${symbol.trim() || "TICKER"}
                </span>
              </div>
            </div>

            <p className="text-sm font-hand text-slate-300 line-clamp-3 leading-relaxed">
              {description.trim() || "Your token description will appear here and on pump.fun..."}
            </p>

            <div className="p-3 sketch-surface space-y-2 text-xs font-hand">
              <div className="flex justify-between items-center text-slate-300">
                <span>Total Token Supply:</span>
                <span className="font-mono font-bold text-white">1,000,000,000</span>
              </div>
              <div className="flex justify-between items-center text-slate-300">
                <span>Creator Fee:</span>
                <span className="font-mono font-bold text-yellow-300">
                  {feeSchedule ? `${feeSchedule.creatorBps / 100}% (pump.fun standard)` : "pump.fun standard"}
                </span>
              </div>
              <div className="flex justify-between items-center text-slate-300">
                <span>Curve Graduation Target:</span>
                <span className="font-mono font-bold text-emerald-400">{graduationTargetSol ? `~${graduationTargetSol.toFixed(1)} SOL` : "..."} (PumpSwap)</span>
              </div>
            </div>

            <div className="pt-2 text-center text-xs font-hand text-slate-400">
              ✏️ This token will also appear on pump.fun
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
