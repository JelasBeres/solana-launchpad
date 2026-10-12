import { useState, useEffect } from "react";

// Fallback constant in case network request fails
const FALLBACK_SOL_PRICE = 150;

export function useSolPrice() {
  const [solPriceUsd, setSolPriceUsd] = useState<number>(FALLBACK_SOL_PRICE);

  useEffect(() => {
    let isMounted = true;

    async function fetchPrice() {
      try {
        const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
        if (res.ok) {
          const data = await res.json();
          const p = parseFloat(data.price);
          if (p > 0 && isMounted) {
            setSolPriceUsd(p);
            return;
          }
        }
      } catch {
        try {
          const cgRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
          if (cgRes.ok) {
            const cgData = await cgRes.json();
            const p = cgData?.solana?.usd;
            if (p > 0 && isMounted) {
              setSolPriceUsd(p);
              return;
            }
          }
        } catch {
          // ignore, keep fallback
        }
      }
    }

    fetchPrice();
    const interval = setInterval(fetchPrice, 30000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  return solPriceUsd;
}

export function formatUsd(val: number): string {
  if (!val || isNaN(val) || val <= 0) return "$0.00";
  if (val >= 1_000_000) {
    return "$" + (val / 1_000_000).toFixed(2) + "M";
  }
  if (val >= 1_000) {
    return "$" + (val / 1_000).toFixed(2) + "K";
  }
  if (val >= 1) {
    return "$" + val.toFixed(2);
  }
  if (val >= 0.0001) {
    return "$" + val.toFixed(4);
  }
  return "$" + val.toFixed(7);
}

export function formatSolPrice(priceSol: number): string {
  if (!priceSol) return "0 SOL";
  return `${priceSol < 0.0001 ? priceSol.toFixed(10) : priceSol.toFixed(6)} SOL`;
}
