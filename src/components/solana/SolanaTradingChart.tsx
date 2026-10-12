"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  ExternalLink,
  RefreshCw,
  Clock,
} from "lucide-react";
import { formatUsd } from "@/hooks/useSolPrice";
import { explorerTxUrl } from "@/config/solana";
import type { TradeRecord } from "@/app/api/trades/route";

export type TradeEvent = TradeRecord;

interface RealTradingChartProps {
  mintAddress?: string;
  tokenSymbol?: string;
  currentPriceSol?: number;
  currentMarketCapSol?: number;
  initialPriceSol?: number;
  initialMarketCapSol?: number;
  solPriceUsd?: number;
  isGraduated?: boolean;
  refreshTrigger?: number;
  onStatsChange?: (stats: { volumeSol: number; tradeCount: number }) => void;
}

// Fresh pump.fun curve: 30 SOL virtual / 1.073B virtual tokens
const DEFAULT_INITIAL_PRICE = 0.000000028;
const DEFAULT_INITIAL_MC = 27.96;

export function RealTradingChart({
  mintAddress,
  tokenSymbol = "TOKEN",
  currentPriceSol,
  currentMarketCapSol,
  initialPriceSol,
  initialMarketCapSol,
  solPriceUsd = 150,
  isGraduated,
  refreshTrigger,
  onStatsChange,
}: RealTradingChartProps) {
  const [trades, setTrades] = useState<TradeEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeMetric, setActiveMetric] = useState<"price" | "marketCap">("marketCap");
  const [hoveredPoint, setHoveredPoint] = useState<{
    x: number;
    y: number;
    trade: TradeEvent | null;
    displayValue: string;
    displayLabel: string;
  } | null>(null);

  // Recent trades decoded from pump.fun TradeEvent logs (server-side, see /api/trades)
  const fetchTrades = useCallback(async () => {
    if (!mintAddress) return;
    try {
      setIsLoading(true);
      const res = await fetch(`/api/trades?mint=${mintAddress}`);
      const data = await res.json();
      if (Array.isArray(data.trades)) setTrades(data.trades);
    } catch (err) {
      console.warn("Failed to fetch on-chain trades:", err);
    } finally {
      setIsLoading(false);
    }
  }, [mintAddress]);

  useEffect(() => {
    fetchTrades();
    const id = setInterval(fetchTrades, 15000);
    return () => clearInterval(id);
  }, [fetchTrades, refreshTrigger]);

  // Construct chart series: Floor baseline -> onchain trades -> latest live point
  const chartSeries = useMemo(() => {
    const initialPrice = initialPriceSol || DEFAULT_INITIAL_PRICE;
    const initialMc = initialMarketCapSol || DEFAULT_INITIAL_MC;
    const launchTs = trades.length > 0 ? trades[0].timestamp - 60000 : Date.now() - 3600000;

    const points: Array<{
      timestamp: number;
      price: number;
      marketCap: number;
      trade: TradeEvent | null;
    }> = [
      {
        timestamp: launchTs,
        price: initialPrice,
        marketCap: initialMc,
        trade: null,
      },
    ];

    // Append all real on-chain trades
    trades.forEach((t) => {
      points.push({
        timestamp: t.timestamp,
        price: t.price,
        marketCap: t.marketCap,
        trade: t,
      });
    });

    // Append latest live point from props if provided
    if (currentPriceSol !== undefined && currentMarketCapSol !== undefined) {
      points.push({
        timestamp: Date.now(),
        price: currentPriceSol > 0 ? currentPriceSol : initialPrice,
        marketCap: currentMarketCapSol > 0 ? currentMarketCapSol : initialMc,
        trade: null,
      });
    } else {
      points.push({
        timestamp: Date.now(),
        price: points[points.length - 1].price,
        marketCap: points[points.length - 1].marketCap,
        trade: null,
      });
    }

    return points;
  }, [trades, currentPriceSol, currentMarketCapSol, initialPriceSol, initialMarketCapSol]);

  // Current stats derived from real onchain points
  const latestPoint = chartSeries[chartSeries.length - 1];
  const initialPoint = chartSeries[0];
  const currentPriceDisplay = currentPriceSol !== undefined && currentPriceSol > 0
    ? currentPriceSol
    : latestPoint.price;
  const currentMcDisplay = currentMarketCapSol !== undefined && currentMarketCapSol > 0
    ? currentMarketCapSol
    : latestPoint.marketCap;

  const currentMcUsd = currentMcDisplay * solPriceUsd;
  const currentPriceUsd = currentPriceDisplay * solPriceUsd;

  const priceDeltaPercent =
    initialPoint.price > 0
      ? ((currentPriceDisplay - initialPoint.price) / initialPoint.price) * 100
      : 0;

  const isPositive = priceDeltaPercent >= 0;

  // High, Low, Total Volume in SOL & USD
  const prices = chartSeries.map((p) => p.price);
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  const totalVolumeSOL = trades.reduce((acc, t) => acc + t.quoteAmount, 0);
  const totalVolumeUSD = totalVolumeSOL * solPriceUsd;

  // Sync volume to parent component
  useEffect(() => {
    if (onStatsChange) {
      onStatsChange({
        volumeSol: totalVolumeSOL,
        tradeCount: trades.length,
      });
    }
  }, [totalVolumeSOL, trades.length, onStatsChange]);

  // SVG Chart Geometry
  const svgWidth = 800;
  const svgHeight = 280;
  const padding = { top: 20, right: 30, bottom: 30, left: 65 };
  const graphWidth = svgWidth - padding.left - padding.right;
  const graphHeight = svgHeight - padding.top - padding.bottom;

  const values = chartSeries.map((p) =>
    activeMetric === "price" ? p.price * solPriceUsd : p.marketCap * solPriceUsd
  );
  const valMin = Math.min(...values);
  const valMax = Math.max(...values);
  const valRange = valMax === valMin ? valMax * 0.1 || 1 : valMax - valMin;

  const yMin = Math.max(0, valMin - valRange * 0.1);
  const yMax = valMax + valRange * 0.1;

  const tMin = chartSeries[0].timestamp;
  const tMax = chartSeries[chartSeries.length - 1].timestamp;
  const tRange = tMax === tMin ? 1 : tMax - tMin;

  // Compute SVG Points
  const coordinates = useMemo(() => {
    return chartSeries.map((p) => {
      const x = padding.left + ((p.timestamp - tMin) / tRange) * graphWidth;
      const val = activeMetric === "price" ? p.price * solPriceUsd : p.marketCap * solPriceUsd;
      const y = padding.top + (1 - (val - yMin) / (yMax - yMin)) * graphHeight;
      return { x, y, point: p };
    });
  }, [chartSeries, tMin, tRange, graphWidth, activeMetric, solPriceUsd, yMin, yMax, graphHeight, padding.left, padding.top]);

  // SVG Path strings
  const linePath = useMemo(() => {
    if (coordinates.length === 0) return "";
    return coordinates.reduce((acc, curr, idx) => {
      return idx === 0 ? `M ${curr.x} ${curr.y}` : `${acc} L ${curr.x} ${curr.y}`;
    }, "");
  }, [coordinates]);

  const areaPath = useMemo(() => {
    if (coordinates.length === 0) return "";
    const firstX = coordinates[0].x;
    const lastX = coordinates[coordinates.length - 1].x;
    const bottomY = padding.top + graphHeight;
    return `${linePath} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`;
  }, [linePath, coordinates, padding.top, graphHeight]);

  // Y-axis ticks in USD
  const yTicks = useMemo(() => {
    const ticksCount = 4;
    return Array.from({ length: ticksCount + 1 }).map((_, i) => {
      const value = yMin + ((yMax - yMin) * i) / ticksCount;
      const y = padding.top + (1 - i / ticksCount) * graphHeight;
      return { value, y };
    });
  }, [yMin, yMax, graphHeight, padding.top]);

  return (
    <div className="sketch-card p-5 sm:p-6 space-y-6 bg-[#121318] border border-zinc-800 rounded-2xl">
      {/* Chart Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        {/* Left: Price & Market Cap Real-Time */}
        <div className="space-y-1">
          <div className="flex items-center space-x-3">
            <span className="text-2xl sm:text-3xl font-black font-mono text-white tracking-tight">
              {activeMetric === "price"
                ? formatUsd(currentPriceUsd)
                : formatUsd(currentMcUsd)}
            </span>
            <span className="text-xs font-mono text-yellow-400 bg-yellow-400/10 border border-yellow-400/30 px-2 py-0.5 rounded-md">
              {activeMetric === "price"
                ? `${currentPriceDisplay < 0.0001 ? currentPriceDisplay.toFixed(9) : currentPriceDisplay.toFixed(6)} SOL`
                : `${currentMcDisplay.toFixed(3)} SOL`}
            </span>
            <span
              className={`inline-flex items-center space-x-0.5 text-xs font-mono font-bold px-2 py-0.5 rounded-md ${
                isPositive
                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                  : "bg-rose-500/15 text-rose-400 border border-rose-500/30"
              }`}
            >
              {isPositive ? (
                <ArrowUpRight className="w-3.5 h-3.5" />
              ) : (
                <ArrowDownRight className="w-3.5 h-3.5" />
              )}
              <span>{priceDeltaPercent >= 0 ? "+" : ""}{priceDeltaPercent.toFixed(2)}%</span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-slate-400">
            <span>
              Pair: <strong className="text-yellow-400">{tokenSymbol}/SOL</strong>
            </span>
            <span>•</span>
            <span>
              MC: <strong className="text-white font-bold">{formatUsd(currentMcUsd)}</strong> <span className="text-slate-500 text-[11px]">({currentMcDisplay.toFixed(3)} SOL)</span>
            </span>
            <span>•</span>
            <span>
              24h High: <strong className="text-slate-200">{formatUsd(maxPrice * solPriceUsd)}</strong>
            </span>
            <span>•</span>
            <span>
              24h Low: <strong className="text-slate-200">{formatUsd(minPrice * solPriceUsd)}</strong>
            </span>
            <span>•</span>
            <span>
              Total Vol: <strong className="text-yellow-400 font-bold">{formatUsd(totalVolumeUSD)}</strong> <span className="text-slate-500 text-[11px]">({totalVolumeSOL.toFixed(3)} SOL)</span>
            </span>
          </div>
        </div>

        {/* Right: Metric Switcher & Live Indicator */}
        <div className="flex items-center space-x-2 shrink-0">
          {/* Market Status Indicator */}
          <div className="px-2.5 py-1 text-[11px] font-mono flex items-center space-x-1.5 bg-yellow-400/10 border border-yellow-400/30 text-yellow-400 rounded-md">
            <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></span>
            <span>{isGraduated ? "PumpSwap Pool" : "pump.fun Curve"}</span>
          </div>

          {/* Metric Switch */}
          <div className="clay-inset p-0.5 rounded-xl flex text-xs font-mono">
            <button
              type="button"
              onClick={() => setActiveMetric("marketCap")}
              className={`px-3 py-1 rounded-lg transition font-bold ${
                activeMetric === "marketCap"
                  ? "clay-btn-primary text-slate-950 shadow"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Market Cap
            </button>
            <button
              type="button"
              onClick={() => setActiveMetric("price")}
              className={`px-3 py-1 rounded-lg transition font-bold ${
                activeMetric === "price"
                  ? "clay-btn-primary text-slate-950 shadow"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              Price
            </button>
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={fetchTrades}
            disabled={isLoading}
            className="p-1.5 clay-btn-secondary text-slate-400 hover:text-white"
            title="Refresh onchain trades"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin text-sky-400" : ""}`} />
          </button>
        </div>
      </div>

      {/* Interactive SVG Chart Container */}
      <div className="relative w-full overflow-hidden clay-surface rounded-2xl p-2 sm:p-4">
        {/* Subtle grid backdrop */}
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full h-56 sm:h-72 select-none overflow-visible"
          onMouseLeave={() => setHoveredPoint(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const mouseX = ((e.clientX - rect.left) / rect.width) * svgWidth;
            // Find closest coordinate point
            let closest = coordinates[0];
            let minDist = Infinity;
            coordinates.forEach((c) => {
              const d = Math.abs(c.x - mouseX);
              if (d < minDist) {
                minDist = d;
                closest = c;
              }
            });

            if (closest) {
              const valUsd = activeMetric === "price" ? closest.point.price * solPriceUsd : closest.point.marketCap * solPriceUsd;
              const valSol = activeMetric === "price" ? closest.point.price : closest.point.marketCap;
              const formattedVal = `${formatUsd(valUsd)} (${activeMetric === "price" ? (valSol < 0.0001 ? valSol.toFixed(9) : valSol.toFixed(6)) : valSol.toFixed(3)} SOL)`;
              setHoveredPoint({
                x: closest.x,
                y: closest.y,
                trade: closest.point.trade,
                displayValue: formattedVal,
                displayLabel: new Date(closest.point.timestamp).toLocaleTimeString(),
              });
            }
          }}
        >
          <defs>
            <linearGradient id="bullGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
            </linearGradient>
            <linearGradient id="bearGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.0" />
            </linearGradient>
            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Horizontal Grid lines */}
          {yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={padding.left}
                y1={tick.y}
                x2={svgWidth - padding.right}
                y2={tick.y}
                stroke="#123d22"
                strokeDasharray="4 4"
                strokeWidth="1"
              />
              <text
                x={padding.left - 8}
                y={tick.y + 4}
                textAnchor="end"
                fill="#4ade80"
                fontSize="10"
                fontFamily="monospace"
              >
                {formatUsd(tick.value)}
              </text>
            </g>
          ))}

          {/* Area fill */}
          <path
            d={areaPath}
            fill={isPositive ? "url(#bullGradient)" : "url(#bearGradient)"}
          />

          {/* Main Price Line */}
          <path
            d={linePath}
            fill="none"
            stroke={isPositive ? "#10b981" : "#f43f5e"}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#glow)"
          />

          {/* Individual trade markers */}
          {coordinates.map((c, i) => {
            if (!c.point.trade) return null;
            const isBuy = c.point.trade.type === "BUY";
            return (
              <circle
                key={i}
                cx={c.x}
                cy={c.y}
                r={hoveredPoint && hoveredPoint.x === c.x ? 5 : 3.5}
                className="transition-all duration-150 cursor-pointer"
                fill={isBuy ? "#22c55e" : "#ef4444"}
                stroke="#ffffff"
                strokeWidth="1.5"
              />
            );
          })}

          {/* Crosshair indicator when hovering */}
          {hoveredPoint && (
            <g>
              <line
                x1={hoveredPoint.x}
                y1={padding.top}
                x2={hoveredPoint.x}
                y2={padding.top + graphHeight}
                stroke="#4ade80"
                strokeWidth="1"
                strokeDasharray="2 2"
              />
              <circle
                cx={hoveredPoint.x}
                cy={hoveredPoint.y}
                r="5"
                fill="#22c55e"
                stroke="#ffffff"
                strokeWidth="2"
                filter="url(#glow)"
              />
            </g>
          )}
        </svg>

        {/* Hover Tooltip Overlay */}
        {hoveredPoint && (
          <div
            className="absolute pointer-events-none sketch-card p-3 text-xs font-mono shadow-2xl border border-emerald-500/40 bg-[#06180e]/95 space-y-1 z-20"
            style={{
              left: `${Math.min(Math.max(10, (hoveredPoint.x / svgWidth) * 100), 75)}%`,
              top: "12px",
            }}
          >
            <div className="flex items-center justify-between gap-3 border-b border-emerald-900/60 pb-1">
              <span className="text-slate-400 text-[10px]">{hoveredPoint.displayLabel}</span>
              {hoveredPoint.trade && (
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    hoveredPoint.trade.type === "BUY"
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-rose-500/20 text-rose-300"
                  }`}
                >
                  {hoveredPoint.trade.type}
                </span>
              )}
            </div>
            <div className="text-emerald-300 font-extrabold text-sm">{hoveredPoint.displayValue}</div>
            {hoveredPoint.trade && (
              <div className="text-[10px] text-slate-400 space-y-0.5 pt-0.5">
                <div>Vol USD: {formatUsd(hoveredPoint.trade.quoteAmount * solPriceUsd)} ({hoveredPoint.trade.quoteAmount.toFixed(4)} SOL)</div>
                <div>Tokens: {hoveredPoint.trade.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
              </div>
            )}
          </div>
        )}

        {/* Zero trades notice if brand new token */}
        {trades.length === 0 && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center pointer-events-none">
            <span className="sketch-badge px-3 py-1 text-[11px] font-mono text-emerald-300">
              Floor Price Initialized • Ready to Trade
            </span>
          </div>
        )}
      </div>

      {/* Recent On-Chain Trades Table */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-bold text-white flex items-center space-x-2">
            <Activity className="w-4 h-4 text-emerald-400" />
            <span>Recent On-Chain Activity ({trades.length})</span>
          </span>
          <span className="text-[11px] font-mono text-slate-400">
            {mintAddress ? `Token: ${mintAddress.slice(0, 4)}...${mintAddress.slice(-4)} • ` : ""}Source: Solana
          </span>
        </div>

        {trades.length > 0 ? (
          <div className="max-h-[240px] overflow-y-auto overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/90">
            <table className="w-full text-left text-xs font-mono relative">
              <thead className="sticky top-0 z-10 bg-zinc-900 text-zinc-300 border-b border-zinc-800 text-[11px] shadow-sm">
                <tr>
                  <th className="py-2.5 px-3">Type</th>
                  <th className="py-2.5 px-3">Price (USD)</th>
                  <th className="py-2.5 px-3">Volume (USD)</th>
                  <th className="py-2.5 px-3">Tokens</th>
                  <th className="py-2.5 px-3">Trader</th>
                  <th className="py-2.5 px-3 text-right">Explorer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80 text-zinc-200">
                {trades
                  .slice()
                  .reverse()
                  .map((t) => (
                    <tr key={t.id} className="hover:bg-emerald-500/10 transition">
                      <td className="py-2 px-3">
                        <span
                          className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                            t.type === "BUY"
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-rose-500/20 text-rose-400"
                          }`}
                        >
                          {t.type}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-slate-200">
                        {formatUsd(t.price * solPriceUsd)}
                        <span className="text-[10px] text-slate-500 block">{t.price < 0.0001 ? t.price.toFixed(9) : t.price.toFixed(6)} SOL</span>
                      </td>
                      <td className="py-2 px-3 font-semibold text-white">
                        {formatUsd(t.quoteAmount * solPriceUsd)}
                        <span className="text-[10px] text-slate-500 block">{t.quoteAmount.toFixed(4)} SOL</span>
                      </td>
                      <td className="py-2 px-3 text-slate-300">
                        {t.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </td>
                      <td className="py-2 px-3 text-slate-400 text-[11px]">
                        {`${t.trader.slice(0, 4)}...${t.trader.slice(-4)}`}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <a
                          href={explorerTxUrl(t.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-400 hover:text-emerald-300 inline-flex items-center space-x-1"
                        >
                          <span>Tx</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-8 text-center clay-surface rounded-xl text-xs font-mono text-slate-500 space-y-1">
            <Clock className="w-5 h-5 mx-auto text-slate-600 mb-1" />
            <p>No on-chain trades executed yet for this curve.</p>
            <p className="text-[11px] text-slate-600">
              Execute a buy or sell on the right to see live transaction points.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

