import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { robinhoodChain } from "./chain";

const DIRECT_RPC = process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

// Browsers read through this app's /api/evm-rpc proxy (some ISPs block the public RPC domain);
// the server talks to the RPC directly. Wallets still broadcast with their own RPC.
const transportUrl = typeof window !== "undefined" ? `${window.location.origin}/api/evm-rpc` : DIRECT_RPC;

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [
    injected(),
  ],
  transports: {
    [robinhoodChain.id]: http(transportUrl),
  },
  ssr: true,
});
