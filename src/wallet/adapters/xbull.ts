/**
 * xBull wallet adapter.
 *
 * xBull is a Stellar wallet available as both a browser extension and PWA.
 * Wraps the SWK instance — same pattern as FreighterAdapter.
 */

import { WalletType } from "../types";
import type {
  WalletAdapter,
  SignTransactionInput,
  SWKInstance,
} from "../types";
import { ok, err, SorokitErrorCode } from "../../shared/response";
import type { SorokitResult } from "../../shared/response";
import { isBrowser, isNetworkConnectivityError, isTimeoutError, toMessage } from "../../shared";
import { swkSignTransaction, describeSignFailure } from "./swkSign";

function describeXBullFailure(action: "connection" | "signing", cause: unknown): string {
  return describeSignFailure("xBull", action, cause);
}

export class XBullAdapter implements WalletAdapter {
  readonly walletType = WalletType.XBULL;

  constructor(private readonly kit: SWKInstance) {}

  isAvailable(): boolean {
    return isBrowser();
  }

  async connect(): Promise<SorokitResult<string>> {
    if (!this.isAvailable()) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "xBull requires a browser environment.",
      );
    }
    try {
      const { address } = await this.kit.getAddress();
      return ok(address);
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        describeXBullFailure("connection", cause),
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
        "xBull requires a browser environment.",
      );
    }
    return swkSignTransaction(this.kit, "xBull", input);
  }
}
