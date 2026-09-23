import { Keypair, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";

/**
 * Sign a transaction XDR offline using a Stellar secret key.
 *
 * Intended for air-gapped / headless flows where a live wallet connection
 * is unavailable. Uses the Stellar SDK `Keypair` signing path — no browser
 * extension or wallet adapter is required.
 *
 * @param xdr - Unsigned (or partially signed) transaction envelope XDR.
 * @param privateKey - Stellar secret seed (`S...`).
 * @param networkPassphrase - Passphrase for the network the transaction was built for.
 * @returns Signed transaction XDR on success.
 *
 * @example
 * const signed = signTransactionOffline(unsignedXdr, secret, Networks.TESTNET);
 * if (signed.status === "ok") {
 *   await submitTransaction(horizonUrl, Networks.TESTNET, signed.data);
 * }
 */
export function signTransactionOffline(
  xdr: string,
  privateKey: string,
  networkPassphrase: string,
): SorokitResult<string> {
  if (typeof xdr !== "string" || xdr.trim().length === 0) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      "Transaction XDR must be a non-empty string.",
    );
  }

  if (typeof privateKey !== "string" || privateKey.trim().length === 0) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      "Private key must be a non-empty Stellar secret seed.",
    );
  }

  if (!StrKey.isValidEd25519SecretSeed(privateKey)) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      "Private key must be a valid Stellar secret seed (S...).",
    );
  }

  if (
    typeof networkPassphrase !== "string" ||
    networkPassphrase.trim().length === 0
  ) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      "Network passphrase is required for offline signing.",
    );
  }

  try {
    const keypair = Keypair.fromSecret(privateKey);
    const transaction = TransactionBuilder.fromXDR(
      xdr.trim(),
      networkPassphrase,
    );
    transaction.sign(keypair);
    return ok(transaction.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      `Offline signing failed: ${toMessage(cause)}`,
      cause,
    );
  }
}
