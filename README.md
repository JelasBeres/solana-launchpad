# LOCKEY Launchpad: Solana (pump.fun) + Robinhood (Pons v2)

LOCKEY's X narrative radar plus one launch UI for two chains. The chain switch sits in the navbar,
on /create (`?chain=solana|robinhood` also works) and in the radar's 1-click launch modal.
Token pages pick the chain from the address (`0x…` means Robinhood, base58 means Solana).

- **Solana:** launches, trades and creator-fee claims go straight to the official pump.fun program through
  [`@pump-fun/pump-sdk`](https://www.npmjs.com/package/@pump-fun/pump-sdk) (`src/components/solana`, `src/lib/pump.ts`).
- **Robinhood Chain:** the original Pons v2 integration (wagmi/viem), carried over from `launchpad/frontend`
  (`src/components/pons`, `src/config/chain.ts`, `src/config/abis.ts`). The Pons admin page is still at `/083826007503`.

Neither side has a smart contract of its own.

| Robinhood version (Pons v2) | This version (pump.fun) |
|---|---|
| `launchToken` / `launchAndBuy` | `create_v2` (+ dev buy in the same tx) |
| Curve `buy` / `sell` | pump.fun `buy` / `sell` |
| Uniswap v4 graduation | Automatic migration to PumpSwap |
| Pons Fee Escrow `claim` | `collectCoinCreatorFee` (pump.fun + PumpSwap vaults) |
| Admin page (protocol fees) | Robinhood only: protocol fees on pump.fun go to pump.fun |

## Getting started

```bash
cp .env.example .env.local   # then fill in SOLANA_RPC_URL, PINATA_JWT, ADMIN_SECRET
npm install
npm run dev
```

Set `NEXT_PUBLIC_SOLANA_CLUSTER` to `devnet` for testing (free SOL from https://faucet.solana.com),
then `mainnet-beta` for production.

### Production checklist
- **RPC:** set `SOLANA_RPC_URL` to a paid RPC (Helius, Triton, QuickNode). Public mainnet RPC blocks browsers (403)
  and rate-limits hard (429). The browser goes through `/api/rpc`, so the key stays on the server.
- **IPFS:** set `PINATA_JWT`. Without it, uploads fall back to pump.fun's unofficial `/api/ipfs` endpoint.
- **Storage:** the token registry (`src/data/platform-tokens.json`) and tweets (`data/tweets.json`) are local files.
  They need a persistent disk (VPS/Docker volume). On Vercel/serverless, move them to a database.
- **Robinhood RPC:** browsers read Robinhood Chain through `/api/evm-rpc` (some Indonesian ISPs, e.g. XL,
  DNS-block `rpc.mainnet.chain.robinhood.com`). Host the app outside that filter; `ROBINHOOD_RPC_URL` overrides the upstream.
- **Admin:** set `ADMIN_SECRET` to allow `DELETE /api/tokens?token=<mint>` with header `x-admin-secret`.

## Testing scripts

```bash
# Real transactions on devnet: create + dev buy, buy, sell, claim (airdrops devnet SOL if the faucet allows)
npx tsx scripts/devnet-smoke-test.ts ~/devnet-wallet.json

# Simulate create / buy / sell against the live mainnet program (signs and spends nothing)
SOLANA_RPC_URL=<mainnet rpc> npx tsx scripts/simulate-mainnet.ts
```

## Claim creator fees from many wallets at once

`scripts/claim-all.ts` claims creator fees from several creator wallets and forwards them to one destination wallet
(Solana pump.fun vaults and Robinhood Pons curves/escrow).

```bash
cp claim-wallets.example.json claim-wallets.json   # git-ignored: holds private keys, keep it safe
npm run claim-fees                                  # dry run: shows claimable per wallet
npm run claim-fees -- --execute                     # claim + forward to the destination wallets
npm run claim-fees -- --execute --only solana       # one chain only
```

## Structure

```
src/
├── lib/pump.ts              # pump.fun helpers: quotes, curve snapshot, create/buy/sell/claim tx builders
├── config/solana.ts         # cluster, RPC, explorer links
├── hooks/                   # useSolanaTx (sign + confirm), useLaunchToken, useSolPrice
├── components/
│   ├── ChainProvider.tsx    # selected chain (Solana / Robinhood) + ChainSelector
│   ├── solana/              # pump.fun create form, token view, fees, chart, fast-launch modal, docs
│   ├── pons/                # Pons v2 create form, token view, fees, chart, fast-launch modal, docs
│   └── Navbar, FastLaunchModal (chain-aware wrappers), Toast
└── app/
    ├── radar/               # X narrative radar (home)
    ├── create/              # launch form
    ├── token/[address]/     # trading page
    ├── creator-dashboard/   # claim creator fees
    └── api/
        ├── rpc/             # whitelisted Solana JSON-RPC proxy for the browser
        ├── evm-rpc/         # whitelisted Robinhood Chain JSON-RPC proxy for the browser
        ├── metadata/        # POST: pin logo + metadata to IPFS; GET: read token metadata JSON
        ├── trades/          # trade history decoded from pump.fun TradeEvent logs
        └── tokens/          # platform token registry (both chains, verified on-chain)
```
