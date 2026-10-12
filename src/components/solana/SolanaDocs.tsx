"use client";

import { useState } from "react";
import { ShieldCheck, Copy, Check, Terminal, AlertTriangle, Rocket, TrendingUp, Coins, Wallet } from "lucide-react";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { CLUSTER_LABEL, explorerAccountUrl } from "@/config/solana";

interface CodeBlockProps {
  caption: string;
  code: string;
}

function CodeSnippet({ caption, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden my-4 shadow-sm">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/90">
        <span className="text-[11px] font-mono text-yellow-400 font-semibold flex items-center space-x-2">
          <Terminal className="w-3.5 h-3.5 text-yellow-400" />
          <span>{caption}</span>
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center space-x-1.5 text-[11px] text-zinc-300 hover:text-white px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 font-mono transition-colors"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-yellow-400" />
              <span className="text-yellow-400 font-bold">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <div className="p-4 overflow-x-auto bg-black/60">
        <pre className="font-mono text-xs text-zinc-200 leading-relaxed">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}

function FormulaBox({ title, formula }: { title: string; formula: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-zinc-900/80 border border-zinc-800 rounded-xl my-3 text-xs font-mono gap-2">
      <span className="text-zinc-300 font-medium">{title}</span>
      <code className="text-yellow-400 px-3 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-[11px]">
        {formula}
      </code>
    </div>
  );
}

const STEPS = [
  {
    icon: Wallet,
    title: "Connect a Solana Wallet",
    body: "Connect Phantom, Solflare, Backpack or any Wallet Standard wallet. You need a little SOL for rent, network fees and your optional dev buy.",
  },
  {
    icon: Rocket,
    title: "Launch on pump.fun",
    body: "Your logo and metadata are pinned to IPFS, then one transaction calls pump.fun's create_v2 instruction (plus your first buy if you set one). The coin appears on pump.fun right away.",
  },
  {
    icon: TrendingUp,
    title: "Trade on the Bonding Curve",
    body: "Everyone buys and sells against pump.fun's constant-product bonding curve. Prices are deterministic and quoted with the official pump.fun SDK.",
  },
  {
    icon: Coins,
    title: "Graduate & Earn",
    body: "When every curve token is sold, pump.fun migrates the liquidity to PumpSwap automatically. Creator fees keep flowing to you before and after graduation.",
  },
];

const PROGRAMS = [
  { key: "pump", label: "pump.fun Bonding Curve Program", value: PUMP_PROGRAM_ID.toBase58() },
  { key: "amm", label: "PumpSwap AMM Program", value: PUMP_AMM_PROGRAM_ID.toBase58() },
];

const TRADE_SNIPPET = `import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { buildBuyTx } from "@/lib/pump";

const connection = new Connection(RPC_URL, "confirmed");
const tx = await buildBuyTx({
  connection,
  user: wallet.publicKey,
  mint: new PublicKey(MINT),
  solAmount: new BN(0.1 * 1e9), // 0.1 SOL
  slippagePercent: 5,
});
const signature = await wallet.sendTransaction(tx, connection);`;

const STATE_SNIPPET = `import { OnlinePumpSdk, bondingCurvePda } from "@pump-fun/pump-sdk";

const sdk = new OnlinePumpSdk(connection);
const curve = await sdk.fetchBondingCurve(mint);
// curve.virtualQuoteReserves, curve.virtualTokenReserves,
// curve.realTokenReserves, curve.complete, curve.creator
console.log("curve account:", bondingCurvePda(mint).toBase58());`;

export default function SolanaDocs() {
  const [copied, setCopied] = useState<string | null>(null);

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const navItems = [
    { id: "overview", label: "Overview" },
    { id: "how-it-works", label: "How It Works" },
    { id: "bonding-curve", label: "Bonding Curve & Graduation" },
    { id: "fees", label: "Fees & Creator Rewards" },
    { id: "risks", label: "Risk Disclosures" },
    { id: "programs", label: "Program Addresses" },
    { id: "developers", label: "Developer Snippets" },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-10 pb-24">
      {/* Hero Banner */}
      <div className="relative p-8 sm:p-12 overflow-hidden bg-[#121318] border border-zinc-800 rounded-2xl shadow-sm">
        <div className="absolute top-0 right-0 w-[30rem] h-[30rem] bg-yellow-400/5 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20"></div>

        <div className="relative z-10 max-w-3xl space-y-5">
          <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-md bg-yellow-400/10 border border-yellow-400/30 text-yellow-400 text-xs font-mono font-bold">
            <span className="w-2 h-2 rounded-full bg-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.5)] animate-pulse"></span>
            <span>LOCKEY Documentation • Solana {CLUSTER_LABEL}</span>
          </div>

          <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight leading-tight">
            How It Works <span className="text-yellow-400">LOCKEY</span>
          </h1>

          <p className="text-zinc-300 text-sm sm:text-base leading-relaxed font-sans">
            LOCKEY is a narrative radar and launch interface for pump.fun on Solana. Spot a narrative on X, launch a coin in one click, and trade it on pump.fun&apos;s bonding curve, all from your own wallet.
          </p>

          <div className="pt-2 flex flex-wrap items-center gap-3 text-xs font-mono">
            <span className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-300">
              Gas Asset: <strong className="text-yellow-400">SOL</strong>
            </span>
            <span className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-300">
              Total Supply: <strong className="text-yellow-400">1,000,000,000 Fixed</strong>
            </span>
            <span className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-300">
              Graduation: <strong className="text-zinc-100">Automatic to PumpSwap</strong>
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Sticky Sidebar Navigation */}
        <aside className="lg:col-span-3 lg:sticky lg:top-24">
          <div className="p-5 space-y-1 bg-[#121318] border border-zinc-800 rounded-2xl shadow-sm">
            {navItems.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="block px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-yellow-400 hover:bg-zinc-900 transition font-medium"
              >
                {item.label}
              </a>
            ))}
          </div>
        </aside>

        {/* Content Column */}
        <div className="lg:col-span-9 space-y-16">
          <section id="overview" className="scroll-mt-24 space-y-4">
            <div className="border-b border-zinc-800 pb-3">
              <h2 className="text-2xl font-black text-white">Overview</h2>
              <p className="text-xs text-slate-400">A non-custodial frontend on top of the pump.fun program</p>
            </div>
            <div className="text-sm text-slate-300 leading-relaxed space-y-4">
              <p>
                LOCKEY does not run its own smart contract. Every launch, trade and fee claim is an instruction to the official <strong>pump.fun program</strong>, built with the official <code>@pump-fun/pump-sdk</code> and signed by your wallet. Coins launched here are regular pump.fun coins and show up on pump.fun, Solscan and every Solana DEX tool.
              </p>
              <div className="p-5 clay-surface text-xs space-y-2.5">
                <span className="font-bold text-yellow-400 flex items-center space-x-2 text-sm">
                  <ShieldCheck className="w-4 h-4" />
                  <span>What pump.fun guarantees</span>
                </span>
                <ul className="list-disc list-inside space-y-1.5 text-slate-300">
                  <li><strong>Fixed supply:</strong> 1,000,000,000 tokens (6 decimals), created by the pump.fun program.</li>
                  <li><strong>No dev allocation:</strong> the creator only holds what they buy on the curve, like everyone else.</li>
                  <li><strong>Automatic migration:</strong> the curve&apos;s liquidity moves to PumpSwap when the curve completes.</li>
                </ul>
              </div>
            </div>
          </section>

          <section id="how-it-works" className="scroll-mt-24 space-y-4">
            <div className="border-b border-zinc-800 pb-3">
              <h2 className="text-2xl font-black text-white">How It Works</h2>
              <p className="text-xs text-slate-400">From narrative to coin in four steps</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {STEPS.map((step, i) => (
                <div key={step.title} className="p-5 clay-surface space-y-3">
                  <div className="w-9 h-9 rounded-xl bg-yellow-400/10 border border-yellow-400/30 flex items-center justify-center text-yellow-400 font-mono font-bold">
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <h3 className="text-white font-bold text-sm flex items-center space-x-2">
                    <step.icon className="w-4 h-4 text-yellow-400" />
                    <span>{step.title}</span>
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed">{step.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="bonding-curve" className="scroll-mt-24 space-y-4">
            <div className="border-b border-zinc-800 pb-3">
              <h2 className="text-2xl font-black text-white">Bonding Curve &amp; Graduation</h2>
              <p className="text-xs text-slate-400">Constant product pricing on virtual reserves</p>
            </div>
            <div className="text-sm text-slate-300 leading-relaxed space-y-3">
              <p>
                Each coin has a bonding curve account holding virtual SOL and token reserves. Buys add SOL and remove tokens, sells do the opposite, and the product of the two reserves stays constant.
              </p>
              <FormulaBox title="Spot price (SOL per token)" formula="virtualSolReserves / virtualTokenReserves" />
              <FormulaBox title="Market cap (SOL)" formula="price × 1,000,000,000" />
              <FormulaBox title="Curve progress" formula="1 − realTokenReserves / initialRealTokenReserves" />
              <p>
                When the last curve token is sold the curve is marked <code>complete</code>, trading on the curve stops, and pump.fun migrates the liquidity into a PumpSwap pool. From then on the coin trades on PumpSwap and on pump.fun&apos;s site.
              </p>
            </div>
          </section>

          <section id="fees" className="scroll-mt-24 space-y-4">
            <div className="border-b border-zinc-800 pb-3">
              <h2 className="text-2xl font-black text-white">Fees &amp; Creator Rewards</h2>
              <p className="text-xs text-slate-400">Set by pump.fun on-chain, not by LOCKEY</p>
            </div>
            <div className="text-sm text-slate-300 leading-relaxed space-y-3">
              <p>
                Every trade pays pump.fun&apos;s protocol fee and a creator fee. Rates come from pump.fun&apos;s on-chain fee config and follow market-cap tiers. For SOL-paired coins (everything launched here) pump.fun does not allow a custom creator fee: the standard rate always applies. Need a custom creator tax? Launch on Robinhood (Pons v2) instead.
              </p>
              <p>
                Creator fees collect in your creator vault (and your PumpSwap vault after graduation). Open <strong>Claim Fees</strong> from the wallet menu to collect both in one transaction. LOCKEY adds no extra platform fee.
              </p>
            </div>
          </section>

          <section id="risks" className="scroll-mt-24 space-y-4">
            <div className="border-b border-zinc-800 pb-3">
              <h2 className="text-2xl font-black text-white">Risk Disclosures</h2>
            </div>
            <div className="p-5 rounded-xl border border-amber-500/30 bg-amber-500/5 text-xs text-slate-300 space-y-2 leading-relaxed">
              <p className="font-bold text-amber-300 flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4" />
                <span>Memecoins are highly speculative</span>
              </p>
              <ul className="list-disc list-inside space-y-1.5">
                <li>Most coins never graduate and can lose nearly all of their value.</li>
                <li>Prices move between quote and execution; trades revert if they move past your slippage.</li>
                <li>Launching a coin from someone else&apos;s post does not mean they endorse it.</li>
                <li>Only trade what you can afford to lose. Nothing here is financial advice.</li>
              </ul>
            </div>
          </section>

          <section id="programs" className="scroll-mt-24 space-y-4">
            <div className="border-b border-zinc-800 pb-3">
              <h2 className="text-2xl font-black text-white">Program Addresses</h2>
              <p className="text-xs text-slate-400">Same program IDs on mainnet and devnet</p>
            </div>
            <div className="space-y-3">
              {PROGRAMS.map((p) => (
                <div key={p.key} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-4 bg-zinc-900/80 border border-zinc-800 rounded-xl text-xs">
                  <span className="text-zinc-300 font-medium">{p.label}</span>
                  <div className="flex items-center space-x-2 min-w-0">
                    <a
                      href={explorerAccountUrl(p.value)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-yellow-400 truncate hover:underline"
                    >
                      {p.value}
                    </a>
                    <button
                      onClick={() => copyText(p.key, p.value)}
                      className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 shrink-0"
                      aria-label={`Copy ${p.label}`}
                    >
                      {copied === p.key ? <Check className="w-3.5 h-3.5 text-yellow-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section id="developers" className="scroll-mt-24 space-y-4">
            <div className="border-b border-zinc-800 pb-3">
              <h2 className="text-2xl font-black text-white">Developer Snippets</h2>
              <p className="text-xs text-slate-400">The same helpers this app uses (src/lib/pump.ts)</p>
            </div>
            <CodeSnippet caption="Read bonding curve state" code={STATE_SNIPPET} />
            <CodeSnippet caption="Buy on the curve" code={TRADE_SNIPPET} />
          </section>
        </div>
      </div>
    </div>
  );
}
