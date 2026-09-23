import { createHash } from "crypto";
import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isUserRejection, toMessage } from "../shared";
import type { WalletAdapter, SignTransactionInput } from "./types";
import type { SigningHistoryStore } from "./signingHistory";
import type { SigningRateLimiter } from "./signingRateLimiter";

function deriveTxHash(xdr: string, networkPassphrase: string): string {
  return createHash("sha256").update(networkPassphrase + xdr).digest("hex");
}

async function performSignTransaction(
  adapter: WalletAdapter,
  input: SignTransactionInput,
  historyStore?: SigningHistoryStore,
): Promise<SorokitResult<string>> {
  if (!adapter.isAvailable()) {
    return err(
      SorokitErrorCode.WALLET_BROWSER_ONLY,
      `${adapter.walletType} requires a browser environment.`,
    );
  }

  const signer = input.accountToSign ?? "unknown";
  const timestamp = new Date().toISOString();
  const txHash = historyStore
    ? deriveTxHash(input.transactionXdr, input.networkPassphrase)
    : "";

  try {
    const result = await adapter.signTransaction(input);

    if (historyStore) {
      if (result.status === "ok") {
        historyStore.record({ txHash, signer, timestamp, status: "success" });
      } else {
        const record: import("./signingHistory").SigningRecord = {
          txHash,
          signer,
          timestamp,
          status: "failure",
        };
        if (result.error.message) record.error = result.error.message;
        historyStore.record(record);
      }
    }

    return result;
  } catch (cause) {
    const msg = isUserRejection(cause)
      ? "User rejected the signature request."
      : `Signing failed: ${toMessage(cause)}`;

    if (historyStore) {
      historyStore.record({
        txHash,
        signer,
        timestamp,
        status: "failure",
        error: msg,
      });
    }

    return err(
      isUserRejection(cause)
        ? SorokitErrorCode.WALLET_SIGN_REJECTED
        : SorokitErrorCode.WALLET_SIGN_FAILED,
      msg,
      cause,
    );
  }
}

/**
 * Sign a transaction XDR using the provided wallet adapter.
 *
 * Supports optional signing rate limiting and execution history recording.
 *
 * @param adapter      - Wallet adapter to sign with.
 * @param input        - Transaction XDR and network passphrase.
 * @param historyStore - Optional store to record the signing attempt.
 * @param rateLimiter  - Optional rate limiter to queue signing prompts.
 */
export async function signTransaction(
  adapter: WalletAdapter,
  input: SignTransactionInput,
  historyStore?: SigningHistoryStore,
  rateLimiter?: SigningRateLimiter,
): Promise<SorokitResult<string>> {
  if (rateLimiter) {
    const { promise } = rateLimiter.enqueue(() =>
      performSignTransaction(adapter, input, historyStore),
    );
    return promise;
  }

  return performSignTransaction(adapter, input, historyStore);
}
