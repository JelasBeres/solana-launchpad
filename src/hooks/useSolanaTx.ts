import { useCallback, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Connection, Keypair, Transaction } from "@solana/web3.js";

export type TxStatus = "idle" | "signing" | "confirming";

/** Signs with the connected wallet (plus optional extra signers), sends and waits for confirmation. */
export function useSolanaTx() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [status, setStatus] = useState<TxStatus>("idle");

  const send = useCallback(
    async (tx: Transaction, signers: Keypair[] = []): Promise<string> => {
      if (!publicKey) throw new Error("Connect your Solana wallet first.");
      setStatus("signing");
      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = publicKey;

        const signature = await sendTransaction(tx, connection, {
          signers,
          preflightCommitment: "confirmed",
          maxRetries: 3,
        });

        setStatus("confirming");
        await waitForConfirmation(connection, signature, lastValidBlockHeight);
        return signature;
      } finally {
        setStatus("idle");
      }
    },
    [connection, publicKey, sendTransaction]
  );

  return { send, status, isBusy: status !== "idle" };
}

/** Polls signature status (no websocket needed, works through the /api/rpc proxy). */
async function waitForConfirmation(connection: Connection, signature: string, lastValidBlockHeight: number) {
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return;
    const height = await connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) throw new Error("Transaction expired before confirmation. Please try again.");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Turns wallet / RPC errors into a short, readable line. */
export function shortTxError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/User rejected|rejected the request/i.test(msg)) return "Transaction rejected in wallet.";
  if (/insufficient (funds|lamports)|0x1\b/i.test(msg)) return "Insufficient SOL balance for this transaction.";
  if (/TooMuchSolRequired|6002/.test(msg)) return "Price moved beyond slippage. Try again or increase slippage.";
  if (/TooLittleSolReceived|6003/.test(msg)) return "Price moved beyond slippage. Try again or increase slippage.";
  return msg.split("\n")[0];
}
