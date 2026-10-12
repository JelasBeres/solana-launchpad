"use client";

import { useCallback, useEffect, useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { formatEther, isAddress, parseAbiItem, getAddress } from "viem";
import { ArrowDownToLine, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { CONTRACT_ADDRESSES } from "@/config/chain";
import { PONS_CURVE_ABI, PONS_FACTORY_ABI, PONS_TOKEN_ABI } from "@/config/abis";
import { useToast } from "@/components/Toast";

// Robinhood Chain has Multicall3 at the canonical address; the RPC caps eth_getLogs at 10M blocks
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const LOG_WINDOW = 10_000_000n;
const TOKEN_LAUNCHED = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)"
);

interface PendingRow {
  token: `0x${string}`;
  curve: `0x${string}`;
  symbol: string;
  pendingTax: bigint;
  graduated: boolean;
}

interface CachedScan {
  tokens: `0x${string}`[];
  scannedTo: string; // last block included in the scan
}

const cacheKey = (addr: string) => `lockey_pons_tokens_${addr.toLowerCase()}`;

function readCache(addr: string): CachedScan | null {
  try {
    const raw = localStorage.getItem(cacheKey(addr));
    return raw ? (JSON.parse(raw) as CachedScan) : null;
  } catch {
    return null;
  }
}

function writeCache(addr: string, scan: CachedScan) {
  try {
    localStorage.setItem(cacheKey(addr), JSON.stringify(scan));
  } catch {
    // storage unavailable, rescan next time
  }
}

/**
 * Creator tax that is still sitting on each curve. Pons only moves it into the FeeEscrow on
 * sweepFees(), so until then the escrow balance (and the Claim button) reads 0.
 */
export function PonsPendingFees({ address, onSwept }: { address: `0x${string}`; onSwept: () => void }) {
  const toast = useToast();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [rows, setRows] = useState<PendingRow[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState<string | null>(null);
  const [manualInput, setManualInput] = useState("");

  // 1. Tokens this wallet launched: TokenLaunched logs filtered by deployer, scanned in 10M-block windows
  const discoverTokens = useCallback(async (): Promise<`0x${string}`[]> => {
    if (!client) return [];
    const cached = readCache(address);
    const latest = await client.getBlockNumber();
    const stopAt = cached ? BigInt(cached.scannedTo) + 1n : 0n;
    const found = new Set<`0x${string}`>(cached?.tokens ?? []);

    for (let to = latest; to >= stopAt; to -= LOG_WINDOW) {
      const from = to >= LOG_WINDOW && to - LOG_WINDOW + 1n > stopAt ? to - LOG_WINDOW + 1n : stopAt;
      const logs = await client.getLogs({
        address: CONTRACT_ADDRESSES.factory,
        event: TOKEN_LAUNCHED,
        args: { deployer: address },
        fromBlock: from,
        toBlock: to,
      });
      logs.forEach((l) => l.args.token && found.add(getAddress(l.args.token)));
      if (from === stopAt) break;
    }

    const tokens = [...found];
    writeCache(address, { tokens, scannedTo: latest.toString() });
    return tokens;
  }, [client, address]);

  // 2. Pending creator tax per curve (one multicall for records, one for balances)
  const loadRows = useCallback(
    async (tokens: `0x${string}`[]) => {
      if (!client || tokens.length === 0) return [];
      const records = await client.multicall({
        multicallAddress: MULTICALL3,
        contracts: tokens.flatMap((token) => [
          { address: CONTRACT_ADDRESSES.factory, abi: PONS_FACTORY_ABI, functionName: "getLaunchedToken", args: [token] } as const,
          { address: token, abi: PONS_TOKEN_ABI, functionName: "symbol" } as const,
        ]),
      });

      const launches = tokens
        .map((token, i) => {
          const rec = records[i * 2].result as { curve: `0x${string}`; creatorFeeRecipient: string; exists: boolean } | undefined;
          const symbol = (records[i * 2 + 1].result as string | undefined) ?? "TOKEN";
          return rec?.exists && rec.creatorFeeRecipient.toLowerCase() === address.toLowerCase()
            ? { token, curve: rec.curve, symbol }
            : null;
        })
        .filter((x): x is { token: `0x${string}`; curve: `0x${string}`; symbol: string } => !!x);

      const balances = await client.multicall({
        multicallAddress: MULTICALL3,
        contracts: launches.flatMap((l) => [
          { address: l.curve, abi: PONS_CURVE_ABI, functionName: "creatorTaxBalance" } as const,
          { address: l.curve, abi: PONS_CURVE_ABI, functionName: "graduated" } as const,
        ]),
      });

      return launches.map((l, i) => ({
        ...l,
        pendingTax: (balances[i * 2].result as bigint | undefined) ?? 0n,
        graduated: Boolean(balances[i * 2 + 1].result),
      }));
    },
    [client, address]
  );

  const refresh = useCallback(async () => {
    setIsScanning(true);
    setScanError(null);
    try {
      const tokens = await discoverTokens();
      setRows(await loadRows(tokens));
    } catch (err) {
      console.warn("Failed to scan Pons launches:", err);
      setScanError("Could not read your launches from Robinhood Chain. Try Refresh.");
    } finally {
      setIsScanning(false);
    }
  }, [discoverTokens, loadRows]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAddManual = async () => {
    const value = manualInput.trim();
    if (!isAddress(value)) {
      toast.error("Invalid address", "Paste the token contract address (0x...).");
      return;
    }
    const cached = readCache(address);
    const tokens = [...new Set([...(cached?.tokens ?? []), getAddress(value)])];
    writeCache(address, { tokens, scannedTo: cached?.scannedTo ?? "0" });
    setManualInput("");
    const next = await loadRows(tokens);
    setRows(next);
    if (!next.some((r) => r.token.toLowerCase() === value.toLowerCase())) {
      toast.error("Not your token", "This token's creator fees go to a different wallet.");
    }
  };

  const handleSweep = async (row: PendingRow) => {
    if (!client) return;
    setSweeping(row.token);
    try {
      const hash = await writeContractAsync({
        address: row.curve,
        abi: PONS_CURVE_ABI,
        functionName: "sweepFees",
        args: [0n],
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Sweep transaction reverted.");
      toast.success("Fees Swept!", `${formatEther(row.pendingTax)} ETH from $${row.symbol} moved to the Fee Escrow. You can claim it now.`, hash);
      onSwept();
      setRows(await loadRows(rows.map((r) => r.token)));
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : "Sweep failed";
      toast.error("Sweep Failed", msg);
    } finally {
      setSweeping(null);
    }
  };

  const totalPending = rows.reduce((acc, r) => acc + r.pendingTax, 0n);

  return (
    <div className="p-6 sm:p-8 space-y-5 bg-[#121318] border border-zinc-800 rounded-2xl shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="space-y-1">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">
            Pending on Curves (not swept yet)
          </span>
          <div className="text-2xl font-bold font-mono text-amber-300">{Number(formatEther(totalPending)).toFixed(6)} ETH</div>
          <p className="text-xs text-zinc-400 font-sans">
            Pons keeps creator tax on each curve until it is swept. Sweep moves it into the Fee Escrow, then Claim sends it to your wallet.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={isScanning}
          className="px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-semibold text-zinc-300 flex items-center space-x-1.5 shrink-0 disabled:opacity-50"
        >
          {isScanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span>{isScanning ? "Scanning launches..." : "Refresh"}</span>
        </button>
      </div>

      {scanError && <p className="text-xs text-rose-400">{scanError}</p>}

      <div className="divide-y divide-zinc-800 border border-zinc-800 rounded-xl overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-5 text-center text-xs text-zinc-500 flex items-center justify-center space-x-2">
            {isScanning ? (
              <>
                <Search className="w-4 h-4 animate-pulse" />
                <span>Looking for tokens launched by this wallet...</span>
              </>
            ) : (
              <span>No Pons launches found for this wallet. Add a token address below if you launched from another wallet setup.</span>
            )}
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.token} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-zinc-950/40">
              <div className="min-w-0">
                <div className="flex items-center space-x-2">
                  <span className="text-sm font-bold text-white">${row.symbol}</span>
                  {row.graduated && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/40">
                      Graduated
                    </span>
                  )}
                </div>
                <span className="text-[11px] font-mono text-zinc-500 truncate block">{row.token}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="font-mono text-sm font-bold text-amber-300">{Number(formatEther(row.pendingTax)).toFixed(6)} ETH</span>
                <button
                  type="button"
                  onClick={() => handleSweep(row)}
                  disabled={row.pendingTax === 0n || sweeping !== null}
                  className="px-3.5 py-2 rounded-lg bg-yellow-400 hover:bg-yellow-300 text-black text-xs font-bold flex items-center space-x-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {sweeping === row.token ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowDownToLine className="w-3.5 h-3.5" />}
                  <span>{sweeping === row.token ? "Sweeping..." : "Sweep to Escrow"}</span>
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          placeholder="Add token address (0x...)"
          className="flex-1 px-3.5 py-2 rounded-lg bg-zinc-950 border border-zinc-700/80 text-xs font-mono text-zinc-200 focus:outline-none focus:border-yellow-400"
        />
        <button
          type="button"
          onClick={handleAddManual}
          className="px-3 py-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-semibold text-zinc-300 flex items-center space-x-1"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add</span>
        </button>
      </div>
    </div>
  );
}
