/**
 * Freighter wallet adapter.
 *
 * Freighter is the SDF-maintained browser extension wallet.
 * This adapter wraps the SWK instance provided by the consumer —
 * sorokit-core never instantiates SWK directly.
 *
 * Consumer responsibilities:
 * - Install @creit.tech/stellar-wallets-kit (peer dependency)
 * - Initialise StellarWalletsKit with the Freighter module
 * - Pass the kit instance to this adapter
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

function describeFreighterFailure(action: "connection" | "signing", cause: unknown): string {
  return describeSignFailure("Freighter", action, cause);
}

export class FreighterAdapter implements WalletAdapter {
  readonly walletType = WalletType.FREIGHTER;

  constructor(private readonly kit: SWKInstance) {}

  isAvailable(): boolean {
    return isBrowser();
  }

  async connect(): Promise<SorokitResult<string>> {
    if (!this.isAvailable()) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "Freighter requires a browser environment.",
      );
    }
    try {
      const { address } = await this.kit.getAddress();
      return ok(address);
    } catch (cause) {
      return err(
        SorokitErrorCode.WALLET_CONNECT_FAILED,
        describeFreighterFailure("connection", cause),
        cause,
      );
    }
  }

  async disconnect(): Promise<SorokitResult<undefined>> {
    // Freighter does not expose a programmatic disconnect.
    // Return success — state cleanup is the consumer's responsibility.
    return ok(undefined);
  }

  async signTransaction(
    input: SignTransactionInput,
  ): Promise<SorokitResult<string>> {
    if (!this.isAvailable()) {
      return err(
        SorokitErrorCode.WALLET_BROWSER_ONLY,
        "Freighter requires a browser environment.",
      );
    }
    return swkSignTransaction(this.kit, "Freighter", input);
  }
}
