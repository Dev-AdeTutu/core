/**
 * Hana wallet adapter.
 *
 * Hana is a Stellar-compatible extension wallet.
 * Wraps the SWK instance provided by the consumer.
 */

import { WalletType } from "../types";
import type {
  WalletAdapter,
  SignTransactionInput,
  SWKInstance,
} from "../types";
import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import { isBrowser } from "../../shared";
import { swkSignTransaction, describeSignFailure } from "./swkSign";

function describeHanaFailure(action: "connection" | "signing", cause: unknown): string {
  return describeSignFailure("Hana", action, cause);
}

export class HanaAdapter implements WalletAdapter {
  readonly walletType = WalletType.HANA;

  constructor(private readonly kit: SWKInstance) {}

  isAvailable(): boolean {
    return isBrowser();
  }

  async connect(): Promise<SorokitResult<string>> {
    if (!this.isAvailable()) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "Hana requires a browser environment.",
      );
    }
    try {
      const { address } = await this.kit.getAddress();
      return ok(address);
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        describeHanaFailure("connection", cause),
        cause,
      );
    }
  }

  async disconnect(): Promise<SorokitResult<undefined>> {
    return ok(undefined);
  }

  async signTransaction(
    input: SignTransactionInput,
  ): Promise<SorokitResult<string>> {
    if (!this.isAvailable()) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "Hana requires a browser environment.",
      );
    }
    return swkSignTransaction(this.kit, "Hana", input);
  }
}
