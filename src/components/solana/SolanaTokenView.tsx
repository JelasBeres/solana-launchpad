"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useParams } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { TrendingUp, ArrowDownUp, ShieldCheck, Flame, ExternalLink, AlertCircle, Globe, Send, Loader2 } from "lucide-react";
import { useToast } from "@/components/Toast";
import { RealTradingChart } from "@/components/solana/SolanaTradingChart";
import { useSolPrice, formatUsd, formatSolPrice } from "@/hooks/useSolPrice";
import { useSolanaTx, shortTxError } from "@/hooks/useSolanaTx";
import { explorerTokenUrl, pumpFunCoinUrl, SOL_DECIMALS, TOKEN_DECIMALS } from "@/config/solana";
import {
  buildBuyTx,
  buildSellTx,
  curveFeeRates,
  fetchCurveSnapshot,
  fetchOffchainMetadata,
  fetchOnchainMetadata,
  fetchProtocolState,
  fetchTokenBalance,
  formatAmount,
  getMintTokenProgram,
  graduationTargetSol,
  initialCurvePrice,
  isValidPublicKey,
  parseAmount,
  quoteBuy,
  quoteSell,
  resolveIpfsUrl,
  toUiAmount,
  type CurveSnapshot,
  type OffchainTokenMetadata,
  type PumpProtocolState,
} from "@/lib/pump";

const SLIPPAGE_PERCENT = 5;

export default function SolanaTokenView() {
  const toast = useToast();
  const params = useParams();
  const mintAddress = params.address as string;
  const isValidMint = isValidPublicKey(mintAddress);
  const mint = useMemo(() => (isValidMint ? new PublicKey(mintAddress) : null), [mintAddress, isValidMint]);

  const { connection } = useConnection();
  const { publicKey, connected: isConnected } = useWallet();
  const { setVisible: openWalletModal } = useWalletModal();
  const { send, status: txStatus, isBusy: isTrading } = useSolanaTx();

  const [activeTab, setActiveTab] = useState<"buy" | "sell">("buy");
  const [amountInput, setAmountInput] = useState("");
  const [tradeCount, setTradeCount] = useState(0);
  const [liveVolumeSol, setLiveVolumeSol] = useState<number>(0);
  const [tradeError, setTradeError] = useState<string | null>(null);
  const solPriceUsd = useSolPrice();

  const [protocol, setProtocol] = useState<PumpProtocolState | null>(null);
  const [curve, setCurve] = useState<CurveSnapshot | null>(null);
  const [curveMissing, setCurveMissing] = useState(false);
  const [tokenName, setTokenName] = useState<string>("");
  const [tokenSymbol, setTokenSymbol] = useState<string>("");
  const [offchain, setOffchain] = useState<OffchainTokenMetadata | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [tokenBalance, setTokenBalance] = useState<{ raw: BN; ui: number }>({ raw: new BN(0), ui: 0 });

  // 1. pump.fun global config + token metadata (once)
  useEffect(() => {
    if (!mint) return;
    let alive = true;
    (async () => {
      try {
        const state = await fetchProtocolState(connection);
        if (alive) setProtocol(state);
        const tokenProgram = await getMintTokenProgram(connection, mint);
        const meta = await fetchOnchainMetadata(connection, mint, tokenProgram);
        if (!alive || !meta) return;
        setTokenName(meta.name);
        setTokenSymbol(meta.symbol);
        const off = await fetchOffchainMetadata(meta.uri);
        if (alive) setOffchain(off);
      } catch (err) {
        console.warn("Failed to load token metadata:", err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [connection, mint]);

  // 2. Bonding curve state (polled)
  const refreshCurve = useCallback(async () => {
    if (!mint || !protocol) return;
    try {
      const snap = await fetchCurveSnapshot(connection, mint, protocol.global);
      setCurve(snap);
      setCurveMissing(!snap);
    } catch (err) {
      console.warn("Failed to fetch bonding curve:", err);
    }
  }, [connection, mint, protocol]);

  useEffect(() => {
    refreshCurve();
    const id = setInterval(refreshCurve, 4000);
    return () => clearInterval(id);
  }, [refreshCurve]);

  // 3. Wallet balances
  const refreshBalances = useCallback(async () => {
    if (!publicKey || !mint) {
      setSolBalance(null);
      setTokenBalance({ raw: new BN(0), ui: 0 });
      return;
    }
    try {
      const [lamports, tokens] = await Promise.all([
        connection.getBalance(publicKey),
        fetchTokenBalance(connection, publicKey, mint),
      ]);
      setSolBalance(lamports / 10 ** SOL_DECIMALS);
      setTokenBalance(tokens);
    } catch (err) {
      console.warn("Failed to fetch balances:", err);
    }
  }, [connection, publicKey, mint]);

  useEffect(() => {
    refreshBalances();
    const id = setInterval(refreshBalances, 10000);
    return () => clearInterval(id);
  }, [refreshBalances]);

  // Parse input
  const parsedBuyInput = activeTab === "buy" ? parseAmount(amountInput, SOL_DECIMALS) : new BN(0);
  const parsedSellInput = activeTab === "sell" ? parseAmount(amountInput, TOKEN_DECIMALS) : new BN(0);

  // 4. Quote with the SDK's own fee math
  const quoteOutput = useMemo(() => {
    if (!protocol || !curve || curve.complete) return new BN(0);
    try {
      return activeTab === "buy"
        ? quoteBuy(protocol, curve.bondingCurve, parsedBuyInput)
        : quoteSell(protocol, curve.bondingCurve, parsedSellInput);
    } catch {
      return new BN(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocol, curve, activeTab, parsedBuyInput.toString(), parsedSellInput.toString()]);

  const isGraduated = !!curve?.complete;
  const currentPriceSol = curve?.priceSol ?? 0;
  const currentMarketCapSol = curve?.marketCapSol ?? 0;
  const thresholdSol = protocol ? graduationTargetSol(protocol.global) : 0;
  const progressPercent = curve?.progressPercent ?? 0;
  const chartBaseline = protocol ? initialCurvePrice(protocol.global) : null;
  const feeRates = protocol && curve ? curveFeeRates(protocol, curve.bondingCurve) : null;

  const handleTrade = async () => {
    if (!mint || !publicKey) {
      openWalletModal(true);
      return;
    }
    setTradeError(null);
    try {
      const tx =
        activeTab === "buy"
          ? await buildBuyTx({ connection, user: publicKey, mint, solAmount: parsedBuyInput, slippagePercent: SLIPPAGE_PERCENT })
          : await buildSellTx({ connection, user: publicKey, mint, tokenAmount: parsedSellInput, slippagePercent: SLIPPAGE_PERCENT });
      const signature = await send(tx);
      const actionName = activeTab === "buy" ? "Buy" : "Sell";
      toast.success(
        `${actionName} Confirmed!`,
        `${activeTab === "buy" ? "Successfully purchased" : "Successfully sold"} ${tokenSymbol || "tokens"} on pump.fun.`,
        signature
      );
      setAmountInput("");
      setTradeCount((c) => c + 1);
      refreshCurve();
      refreshBalances();
    } catch (err) {
      console.error("Trade failed:", err);
      const msg = shortTxError(err);
      setTradeError(msg);
      toast.error("Trade Failed", msg);
    }
  };

  const resolvedLogo = resolveIpfsUrl(offchain?.image) || "/logo.png";
  const description = offchain?.description || "A community token launched on pump.fun (Solana).";
  const socials = offchain;

  if (!isValidMint || curveMissing) {
    return (
      <div className="max-w-2xl mx-auto py-20 text-center space-y-4 sketch-card p-8">
        <AlertCircle className="w-12 h-12 text-yellow-400 mx-auto" />
        <h2 className="text-3xl font-kalam font-bold text-white">Token Not Found</h2>
        <p className="text-sm font-hand text-slate-400">
          Address <span className="font-mono text-sky-400 break-all">{mintAddress}</span> is not a pump.fun token on this Solana cluster.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-20">
      {/* Header Info - Flat Card */}
      <div className="sketch-card p-6 sm:p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 relative bg-[#121318] border border-zinc-800 rounded-2xl">
        <div className="flex items-center space-x-5">
          <div className="w-20 h-20 rounded-xl overflow-hidden bg-zinc-900 border border-yellow-500/40 shrink-0 flex items-center justify-center shadow-sm p-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={resolvedLogo} alt={tokenName || "Token"}
              onError={(e) => {
                // ipfs.io often rate-limits: retry the same CID on another gateway, then fall back
                const img = e.target as HTMLImageElement;
                const cid = img.src.match(/\/ipfs\/([A-Za-z0-9]+)/)?.[1];
                if (cid && !img.src.includes("dweb.link")) img.src = `https://dweb.link/ipfs/${cid}`;
                else img.src = "/logo.png";
              }} className="w-full h-full object-cover rounded-lg" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center space-x-3 flex-wrap gap-y-1">
              <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">{tokenName || "Loading..."}</h1>
              <span className="px-2.5 py-0.5 rounded-md bg-yellow-400/10 text-yellow-400 font-mono text-xs font-bold uppercase border border-yellow-400/30">${tokenSymbol || "..."}</span>
              {isGraduated ? (
                <span className="px-2.5 py-1 rounded-sketch text-xs font-hand font-bold bg-purple-500/20 text-purple-300 border-2 border-purple-500/40 shadow-sketch-sm flex items-center space-x-1">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Graduated to PumpSwap</span>
                </span>
              ) : (
                <span className="px-2.5 py-1 rounded-sketch text-xs font-hand font-bold bg-sky-500/20 text-sky-300 border-2 border-sky-400/40 shadow-sketch-sm flex items-center space-x-1">
                  <Flame className="w-3.5 h-3.5 text-sky-400" />
                  <span>Active Bonding Curve</span>
                </span>
              )}
            </div>
            <p className="text-sm font-hand text-slate-300 max-w-xl line-clamp-2 leading-relaxed">{description}</p>
            {socials && (
              <div className="flex items-center space-x-3 pt-1 text-slate-400 text-sm font-hand font-bold">
                {socials.website && (
                  <a href={socials.website} target="_blank" rel="noopener noreferrer" className="hover:text-sky-300 transition flex items-center space-x-1">
                    <Globe className="w-4 h-4" />
                    <span>Web</span>
                  </a>
                )}
                {socials.twitter && (
                  <a href={socials.twitter.startsWith("http") ? socials.twitter : `https://x.com/${socials.twitter}`} target="_blank" rel="noopener noreferrer" className="hover:text-sky-300 transition">
                    𝕏 Twitter
                  </a>
                )}
                {socials.telegram && (
                  <a href={socials.telegram.startsWith("http") ? socials.telegram : `https://t.me/${socials.telegram}`} target="_blank" rel="noopener noreferrer" className="hover:text-sky-300 transition flex items-center space-x-1">
                    <Send className="w-4 h-4" />
                    <span>Telegram</span>
                  </a>
                )}
              </div>
            )}
            <div className="flex items-center space-x-3 pt-1 text-slate-400 text-sm font-hand font-bold">
              <a
                href={explorerTokenUrl(mintAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-sky-300 transition flex items-center space-x-1"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Solscan</span>
              </a>
              <a
                href={pumpFunCoinUrl(mintAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-sky-300 transition flex items-center space-x-1"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>pump.fun</span>
              </a>
            </div>
          </div>
        </div>

        {/* Quick Stats in Hand-Drawn Ticket Format */}
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <div className="p-3 sketch-surface rounded-sketch text-right">
            <span className="text-[11px] font-hand text-slate-400 uppercase tracking-wider block">Price</span>
            <span className="font-mono text-sm sm:text-base font-bold text-white block">
              {currentPriceSol ? formatUsd(currentPriceSol * solPriceUsd) : "$0.00"}
            </span>
            <span className="text-[10px] font-mono text-slate-400 block">
              {formatSolPrice(currentPriceSol)}
            </span>
          </div>
          <div className="p-3 sketch-surface rounded-sketch text-right">
            <span className="text-[11px] font-hand text-slate-400 uppercase tracking-wider block">Market Cap</span>
            <span className="font-mono text-sm sm:text-base font-bold text-emerald-400 block">
              {currentMarketCapSol ? formatUsd(currentMarketCapSol * solPriceUsd) : "$0.00"}
            </span>
            <span className="text-[10px] font-mono text-emerald-300/80 block">
              {currentMarketCapSol ? `${currentMarketCapSol.toFixed(2)} SOL` : "0.00 SOL"}
            </span>
          </div>
          <div className="p-3 sketch-surface rounded-sketch text-right">
            <span className="text-[11px] font-hand text-slate-400 uppercase tracking-wider block">Total Volume</span>
            <span className="font-mono text-sm sm:text-base font-bold text-emerald-300 block">
              {liveVolumeSol > 0 ? formatUsd(liveVolumeSol * solPriceUsd) : "$0.00"}
            </span>
            <span className="text-[10px] font-mono text-slate-400 block">
              {liveVolumeSol > 0 ? `${liveVolumeSol.toFixed(3)} SOL` : "0.000 SOL"}
            </span>
          </div>
        </div>
      </div>

      {/* Graduation Progress Bar - Hatched Meter */}
      <div className="sketch-card p-6 space-y-3 bg-[#121318] border border-zinc-800 rounded-2xl">
        <div className="flex justify-between items-center text-sm font-semibold">
          <span className="text-zinc-200 uppercase tracking-wider flex items-center space-x-2">
            <TrendingUp className="w-5 h-5 text-yellow-400" />
            <span>Curve Graduation Target ({progressPercent.toFixed(1)}%)</span>
          </span>
          <span className="font-mono text-yellow-400 font-bold">
            {`${(curve?.realSolReserves ?? 0).toFixed(3)} SOL`} / ~{thresholdSol.toFixed(1)} SOL Target ({formatUsd(thresholdSol * solPriceUsd)})
          </span>
        </div>
        <div className="w-full h-3 bg-zinc-950 rounded-full border border-zinc-800 overflow-hidden p-0.5">
          <div
            className="h-full bg-yellow-400 rounded-full transition-all duration-500 shadow-sm"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-zinc-400 font-sans">
          <span>When every curve token is sold (~{thresholdSol.toFixed(1)} SOL raised), pump.fun migrates the liquidity to PumpSwap automatically.</span>
          {isGraduated && (
            <a
              href={pumpFunCoinUrl(mintAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-yellow-400 hover:text-yellow-300 underline font-bold shrink-0 ml-3"
            >
              Trade on pump.fun
            </a>
          )}
        </div>
      </div>

      {/* Trading & Chart Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Real Chart */}
        <div className="lg:col-span-2">
          <RealTradingChart
            mintAddress={mintAddress}
            tokenSymbol={tokenSymbol || "TOKEN"}
            currentPriceSol={currentPriceSol}
            currentMarketCapSol={currentMarketCapSol}
            initialPriceSol={chartBaseline?.priceSol}
            initialMarketCapSol={chartBaseline?.marketCapSol}
            solPriceUsd={solPriceUsd}
            isGraduated={isGraduated}
            refreshTrigger={tradeCount}
            onStatsChange={(stats) => {
              setLiveVolumeSol(stats.volumeSol);
            }}
          />
        </div>

        {/* Swap Card in Flat Style */}
        <div className="sketch-card p-6 sm:p-7 space-y-6 self-start shadow-sm bg-[#121318] border border-zinc-800 rounded-2xl">
          <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
            <div className="grid grid-cols-2 gap-2 p-1 bg-zinc-950 rounded-lg w-full border border-zinc-800">
              <button
                type="button"
                onClick={() => setActiveTab("buy")}
                className={`py-2 text-sm font-semibold rounded-md transition ${
                  activeTab === "buy" ? "bg-yellow-400 text-black font-bold shadow-sm" : "text-zinc-400 hover:text-white"
                }`}
              >
                Buy {tokenSymbol || "Token"}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("sell")}
                className={`py-2 text-sm font-semibold rounded-md transition ${
                  activeTab === "sell" ? "bg-yellow-400 text-black font-bold shadow-sm" : "text-zinc-400 hover:text-white"
                }`}
              >
                Sell {tokenSymbol || "Token"}
              </button>
            </div>
          </div>

          {/* Balance info */}
          <div className="flex items-center justify-between text-xs font-hand text-slate-400">
            <span>Your Balance:</span>
            <span className="font-mono text-slate-200 font-bold">
              {activeTab === "buy"
                ? `${solBalance !== null ? solBalance.toFixed(4) : "0.00"} SOL`
                : `${tokenBalance.ui.toLocaleString()} ${tokenSymbol || ""}`}
            </span>
          </div>

          {/* Amount Input */}
          <div className="space-y-2">
            <div className="relative">
              <input
                type="number"
                step="any"
                min="0"
                placeholder="0.0"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="w-full px-4 py-3 sketch-inset text-base font-mono text-white placeholder:text-slate-500 focus:outline-none"
              />
              <span className="absolute right-3.5 top-3 text-xs font-mono font-bold text-emerald-300">
                {activeTab === "buy" ? "SOL" : tokenSymbol || "TOKEN"}
              </span>
            </div>
            {activeTab === "buy" ? (
              <div className="flex items-center space-x-1.5 pt-1">
                {[0.1, 0.5, 1, 2].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setAmountInput(val.toString())}
                    className="flex-1 py-1 text-xs font-hand font-bold sketch-btn-secondary text-slate-300 hover:text-white"
                  >
                    +{val} SOL
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center space-x-1.5 pt-1">
                {[25, 50, 75, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => {
                      if (tokenBalance.raw.gtn(0)) {
                        const amt = tokenBalance.raw.muln(pct).divn(100);
                        setAmountInput(formatAmount(amt, TOKEN_DECIMALS));
                      }
                    }}
                    className="flex-1 py-1 text-xs font-hand font-bold sketch-btn-secondary text-slate-300 hover:text-white"
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Quote breakdown in Hand-Drawn Receipt Note */}
          <div className="p-4 sketch-surface space-y-2 text-xs font-hand rounded-sketch">
            <div className="flex justify-between items-center text-slate-300">
              <span>Estimated Output:</span>
              <span className="font-mono font-bold text-emerald-400 text-sm">
                {activeTab === "buy"
                  ? `${toUiAmount(quoteOutput, TOKEN_DECIMALS).toLocaleString()} ${tokenSymbol || "TOKEN"}`
                  : `${toUiAmount(quoteOutput, SOL_DECIMALS).toFixed(5)} SOL`}
              </span>
            </div>
            <div className="flex justify-between items-center text-slate-400">
              <span>Trading Fee:</span>
              <span className="font-mono text-slate-300">
                {feeRates
                  ? `${(feeRates.protocolBps + feeRates.creatorBps) / 100}% (creator ${feeRates.creatorBps / 100}% + pump.fun ${feeRates.protocolBps / 100}%)`
                  : "..."}
              </span>
            </div>
            <div className="flex justify-between items-center text-slate-400">
              <span>Max Slippage:</span>
              <span className="font-mono text-slate-300">{SLIPPAGE_PERCENT}%</span>
            </div>
          </div>

          {/* Action Button */}
          <button
            type="button"
            onClick={handleTrade}
            disabled={
              isTrading ||
              (isConnected &&
                (!curve || isGraduated || (activeTab === "buy" ? parsedBuyInput.lten(0) : parsedSellInput.lten(0))))
            }
            className={`w-full py-3.5 font-bold text-lg flex items-center justify-center space-x-2 disabled:opacity-50 ${
              activeTab === "buy" ? "sketch-btn-primary text-slate-950 font-bold" : "sketch-btn-secondary bg-rose-600/30 border-rose-500 text-rose-200"
            }`}
          >
            {isTrading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>{txStatus === "signing" ? "Confirm in Wallet..." : `Processing ${activeTab === "buy" ? "Purchase" : "Sale"}...`}</span>
              </>
            ) : !isConnected ? (
              <span>Connect Wallet</span>
            ) : isGraduated ? (
              <span>Graduated to PumpSwap</span>
            ) : (
              <>
                <ArrowDownUp className="w-5 h-5" />
                <span>{activeTab === "buy" ? "Buy with SOL" : `Sell ${tokenSymbol || "Token"}`}</span>
              </>
            )}
          </button>

          {tradeError && (
            <p className="text-xs font-hand text-rose-400 flex items-start space-x-1.5 leading-relaxed">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{tradeError}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
