import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import {
  isNetworkConnectivityError,
  isTimeoutError,
  isUserRejection,
  toMessage,
} from "../../shared";
import type { SignTransactionInput, SWKInstance } from "../types";

export function describeSignFailure(
  walletName: string,
  action: "connection" | "signing",
  cause: unknown,
): string {
  if (isTimeoutError(cause)) {
    return `${walletName} ${action} timed out: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `${walletName} ${action} failed due to network connectivity: ${toMessage(cause)}`;
  }
  return `${walletName} ${action} failed: ${toMessage(cause)}`;
}

export async function swkSignTransaction(
  kit: SWKInstance,
  walletName: string,
  input: SignTransactionInput,
): Promise<SorokitResult<string>> {
  try {
    const { signedTxXdr } = await kit.signTransaction(input.transactionXdr, {
      networkPassphrase: input.networkPassphrase,
      ...(input.accountToSign !== undefined && { address: input.accountToSign }),
    });
    return ok(signedTxXdr);
  } catch (cause) {
    const rejected = isUserRejection(cause);
    return err(
      rejected ? SorokitErrorCode.WALLET_SIGN_REJECTED : SorokitErrorCode.WALLET_SIGN_FAILED,
      rejected
        ? `User rejected the ${walletName} signature request.`
        : describeSignFailure(walletName, "signing", cause),
      cause,
    );
  }
}
