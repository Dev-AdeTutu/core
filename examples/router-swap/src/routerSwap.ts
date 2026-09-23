/**
 * Router integration example — framework-agnostic swap logic (#357).
 *
 * This module is the part of the example a real frontend would keep: it has no
 * DOM access, no framework imports, and returns `SorokitResult` values so the
 * UI layer never has to write a try/catch. `app.ts` wires it to a plain HTML
 * form; the same functions drop into React, Vue, or Svelte unchanged.
 *
 * The flow it demonstrates is the usual three steps of a DEX swap:
 *
 *   1. Quote  — discover the best route on the Stellar DEX and price it.
 *   2. Swap   — sign the quoted transaction with the connected wallet.
 *   3. Track  — submit it and follow the transaction until it settles.
 *
 * The example lives inside the sorokit-core repository, so it imports the SDK
 * from source. In your own app the imports below become:
 *
 *   import { buildPathPayment, findSwapPath, ... } from "sorokit-core";
 */

import { TransactionBuilder } from "@stellar/stellar-sdk";
import { resolveNetwork } from "../../../src/network/resolveNetwork";
import { buildPathPayment } from "../../../src/transaction/buildTransaction";
import {
  describeRouterSwapFailure,
  findSwapPath,
} from "../../../src/transaction/pathPayment";
import { submitTransaction } from "../../../src/transaction/submitTransaction";
import { getTransactionStatus } from "../../../src/transaction/status";
import { signTransaction } from "../../../src/wallet/signTransaction";
import { err, ok, SorokitErrorCode } from "../../../src/shared/response";
import type { SorokitResult } from "../../../src/shared/response";
import type { NetworkType } from "../../../src/network/config";
import type { ResolvedNetworkConfig } from "../../../src/shared/types";
import type { WalletAdapter } from "../../../src/wallet/types";
import type {
  PathPaymentMode,
  PathPaymentParams,
  TransactionResult,
} from "../../../src/transaction/types";

/** Stellar amounts are fixed-point with seven decimal places. */
const STROOPS_PER_UNIT = 10_000_000n;
const AMOUNT_DECIMALS = 7;

/** How long the example waits for a submitted swap to settle. */
const DEFAULT_POLL_ATTEMPTS = 10;
const DEFAULT_POLL_INTERVAL_MS = 2000;

/** Configuration for the router client. */
export interface RouterSwapConfig {
  /** Target network — "testnet" while you develop */
  network: NetworkType;
  /** Optional Horizon override (defaults to the network's public endpoint) */
  horizonUrl?: string;
  /** Optional Soroban RPC override */
  rpcUrl?: string;
}

/** An asset as entered in a swap form. Omit `issuer` for native XLM. */
export interface SwapAsset {
  /** Asset code, e.g. "XLM" or "USDC" */
  code: string;
  /** Issuer account for non-native assets */
  issuer?: string;
}

/** A swap the user wants to perform. */
export interface SwapRequest {
  /** Account paying for the swap — the connected wallet */
  sourcePublicKey: string;
  /** Account receiving the destination asset (usually the source account) */
  destination: string;
  /** Asset being sold */
  sendAsset: SwapAsset;
  /** Asset being bought */
  receiveAsset: SwapAsset;
  /**
   * "strict-send" spends exactly `amount` of `sendAsset`;
   * "strict-receive" delivers exactly `amount` of `receiveAsset`.
   */
  mode: PathPaymentMode;
  /** Amount interpreted according to `mode` */
  amount: string;
  /**
   * Price movement the user accepts between quoting and settlement, in percent.
   * Defaults to 0.5%. A quote built without tolerance sets the on-chain bound to
   * the exact quoted price, which fails as soon as the pool moves a stroop.
   */
  slippageTolerancePercent?: number;
}

/** A priced, ready-to-sign swap. */
export interface SwapQuote {
  /** Unsigned transaction XDR — sign this exact value */
  transactionXdr: string;
  /** Mode the quote was built for */
  mode: PathPaymentMode;
  /** Amount of the send asset leaving the account (quoted) */
  sendAmount: string;
  /** Amount of the receive asset arriving (quoted) */
  receiveAmount: string;
  /**
   * Worst acceptable outcome enforced on-chain: minimum received in
   * "strict-send" mode, maximum spent in "strict-receive" mode.
   */
  slippageBound: string;
  /** Slippage tolerance applied to the bound, in percent */
  slippageTolerancePercent: number;
  /** Human-readable route, e.g. ["XLM", "USDC", "EURC"] */
  route: string[];
  /** Fee in stroops the transaction will pay */
  feeStroops: string;
}

/** Final state of a submitted swap. */
export interface SwapExecution {
  /** Transaction hash — link it to an explorer in your UI */
  hash: string;
  /** Horizon's view of the transaction once polling finished */
  transaction: TransactionResult;
}

/** Options for {@link RouterSwapClient.executeSwap}. */
export interface ExecuteSwapOptions {
  /** How many times to poll Horizon before giving up. Default: 10 */
  pollAttempts?: number;
  /** Delay between polls in milliseconds. Default: 2000 */
  pollIntervalMs?: number;
  /** Called after every step so the UI can show progress */
  onProgress?: (step: SwapProgressStep) => void;
}

/** Progress steps reported while a swap executes. */
export type SwapProgressStep = "signing" | "submitting" | "confirming";

/** The example's public surface. */
export interface RouterSwapClient {
  /** Resolved network configuration used for every call */
  readonly networkConfig: ResolvedNetworkConfig;
  /** Price a swap and build the transaction that would execute it */
  getQuote(request: SwapRequest): Promise<SorokitResult<SwapQuote>>;
  /** Sign, submit, and track a quoted swap */
  executeSwap(
    quote: SwapQuote,
    adapter: WalletAdapter,
    signerPublicKey: string,
    options?: ExecuteSwapOptions,
  ): Promise<SorokitResult<SwapExecution>>;
}

/**
 * Convert a decimal amount string into stroops.
 * Returns null when the input is not a positive decimal number.
 */
function toStroops(amount: string): bigint | null {
  if (!/^\d+(\.\d{1,7})?$/.test(amount.trim())) return null;
  const [whole = "0", fraction = ""] = amount.trim().split(".");
  const padded = fraction.padEnd(AMOUNT_DECIMALS, "0");
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(padded);
}

/** Format stroops back into the seven-decimal string Stellar expects. */
function fromStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  const fraction = (stroops % STROOPS_PER_UNIT)
    .toString()
    .padStart(AMOUNT_DECIMALS, "0");
  return `${whole}.${fraction}`;
}

/**
 * Widen a quoted amount by the slippage tolerance.
 *
 * Selling (`strict-send`) lowers the minimum the user will accept; buying
 * (`strict-receive`) raises the maximum the user will spend. Integer math on
 * stroops keeps the bound exact — floating point would drift on large amounts.
 */
export function applySlippage(
  amount: string,
  tolerancePercent: number,
  direction: "lower" | "raise",
): string | null {
  const stroops = toStroops(amount);
  if (stroops === null) return null;

  // Basis points keep a fractional percent (e.g. 0.5%) in integer math.
  const toleranceBps = BigInt(Math.round(tolerancePercent * 100));
  const adjusted =
    direction === "lower"
      ? (stroops * (10_000n - toleranceBps)) / 10_000n
      : (stroops * (10_000n + toleranceBps)) / 10_000n;

  return fromStroops(adjusted);
}

/** Build the SDK params for a path payment, omitting absent issuers. */
function toPathPaymentParams(
  request: SwapRequest,
  overrides: {
    path?: Array<{ assetCode?: string; assetIssuer?: string }>;
    slippageAmount?: string;
  } = {},
): PathPaymentParams {
  return {
    destination: request.destination,
    mode: request.mode,
    amount: request.amount,
    sendAssetCode: request.sendAsset.code,
    ...(request.sendAsset.issuer
      ? { sendAssetIssuer: request.sendAsset.issuer }
      : {}),
    destAssetCode: request.receiveAsset.code,
    ...(request.receiveAsset.issuer
      ? { destAssetIssuer: request.receiveAsset.issuer }
      : {}),
    ...(overrides.path ? { path: overrides.path } : {}),
    ...(overrides.slippageAmount
      ? { slippageAmount: overrides.slippageAmount }
      : {}),
  };
}

/** Amounts and route read back out of a built path payment XDR. */
interface DecodedPathPayment {
  sendAmount: string;
  receiveAmount: string;
  slippageBound: string;
  hops: Array<{ assetCode?: string; assetIssuer?: string }>;
  routeCodes: string[];
  feeStroops: string;
}

/**
 * Read the priced route back out of a built transaction.
 *
 * `buildPathPayment` performs the DEX path discovery itself, so decoding its
 * output is how the UI learns the route and the amount the user will receive —
 * no second price source to drift out of sync with what gets signed.
 */
function decodePathPayment(
  transactionXdr: string,
  networkPassphrase: string,
): SorokitResult<DecodedPathPayment> {
  const transaction = TransactionBuilder.fromXDR(
    transactionXdr,
    networkPassphrase,
  );

  // buildPathPayment never produces a fee-bump envelope; the guard keeps the
  // decoder honest for callers that pass their own XDR.
  if ("innerTransaction" in transaction) {
    return err(
      SorokitErrorCode.ROUTER_SWAP_FAILED,
      "Expected a plain transaction envelope, received a fee-bump transaction.",
    );
  }

  const operation = transaction.operations[0];

  if (
    operation?.type !== "pathPaymentStrictSend" &&
    operation?.type !== "pathPaymentStrictReceive"
  ) {
    return err(
      SorokitErrorCode.ROUTER_SWAP_FAILED,
      "Router returned a transaction without a path payment operation.",
    );
  }

  const hops = operation.path.map((asset) => ({
    assetCode: asset.getCode(),
    ...(asset.isNative() ? {} : { assetIssuer: asset.getIssuer() }),
  }));

  const sendCode = operation.sendAsset.getCode();
  const destCode = operation.destAsset.getCode();
  const routeCodes = [sendCode, ...hops.map((hop) => hop.assetCode), destCode];

  if (operation.type === "pathPaymentStrictSend") {
    return ok({
      sendAmount: operation.sendAmount,
      receiveAmount: operation.destMin,
      slippageBound: operation.destMin,
      hops,
      routeCodes,
      feeStroops: transaction.fee,
    });
  }

  return ok({
    sendAmount: operation.sendMax,
    receiveAmount: operation.destAmount,
    slippageBound: operation.sendMax,
    hops,
    routeCodes,
    feeStroops: transaction.fee,
  });
}

/** Pause between status polls. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create the router client used by this example.
 *
 * @param config - Network selection and optional endpoint overrides
 * @returns A quote/execute client, or an error if the network is unknown
 *
 * @example
 * const created = createRouterSwapClient({ network: "testnet" });
 * if (created.status === "error") throw new Error(created.error.message);
 * const router = created.data;
 */
export function createRouterSwapClient(
  config: RouterSwapConfig,
): SorokitResult<RouterSwapClient> {
  const networkResult = resolveNetwork(config.network, {
    ...(config.horizonUrl ? { horizonUrl: config.horizonUrl } : {}),
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
  });
  if (networkResult.status === "error") return networkResult;

  const networkConfig = networkResult.data;

  async function getQuote(
    request: SwapRequest,
  ): Promise<SorokitResult<SwapQuote>> {
    if (toStroops(request.amount) === null) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Amount "${request.amount}" is not a positive number with at most ${AMOUNT_DECIMALS} decimal places.`,
      );
    }

    const tolerance = request.slippageTolerancePercent ?? 0.5;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance >= 100) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Slippage tolerance must be between 0 and 100 percent, received ${tolerance}.`,
      );
    }

    // Step 1 — reject routes the router cannot serve (same asset in and out)
    // before spending a Horizon round trip on them.
    const routeCheck = await findSwapPath(
      {
        code: request.sendAsset.code,
        issuer: request.sendAsset.issuer ?? null,
      },
      {
        code: request.receiveAsset.code,
        issuer: request.receiveAsset.issuer ?? null,
      },
    );
    if (routeCheck.status === "error") return routeCheck;

    // Step 2 — let the SDK discover the best route and price it. Without an
    // explicit `path`/`slippageAmount`, buildPathPayment queries Horizon's
    // strict-send/strict-receive path endpoints and uses the best record.
    const discovery = await buildPathPayment(
      networkConfig.horizonUrl,
      networkConfig,
      request.sourcePublicKey,
      toPathPaymentParams(request),
    );
    if (discovery.status === "error") {
      const failure = describeRouterSwapFailure(
        new Error(discovery.error.message),
      );
      return err(failure.code, failure.message, discovery.error.cause);
    }

    const decoded = decodePathPayment(
      discovery.data,
      networkConfig.networkPassphrase,
    );
    if (decoded.status === "error") return decoded;

    const quoted = decoded.data;

    // Step 3 — rebuild the transaction with a slippage bound the user can
    // actually settle at. The discovered route is reused so the rebuilt
    // transaction prices the same hops that were quoted.
    let transactionXdr = discovery.data;
    let slippageBound = quoted.slippageBound;

    if (tolerance > 0) {
      const bound = applySlippage(
        quoted.slippageBound,
        tolerance,
        request.mode === "strict-send" ? "lower" : "raise",
      );
      if (bound === null) {
        return err(
          SorokitErrorCode.ROUTER_SWAP_FAILED,
          `Router returned an unreadable amount: "${quoted.slippageBound}".`,
        );
      }

      const rebuilt = await buildPathPayment(
        networkConfig.horizonUrl,
        networkConfig,
        request.sourcePublicKey,
        toPathPaymentParams(request, {
          path: quoted.hops,
          slippageAmount: bound,
        }),
      );
      if (rebuilt.status === "error") {
        const failure = describeRouterSwapFailure(
          new Error(rebuilt.error.message),
        );
        return err(failure.code, failure.message, rebuilt.error.cause);
      }

      transactionXdr = rebuilt.data;
      slippageBound = bound;
    }

    return ok({
      transactionXdr,
      mode: request.mode,
      sendAmount: quoted.sendAmount,
      receiveAmount: quoted.receiveAmount,
      slippageBound,
      slippageTolerancePercent: tolerance,
      route: quoted.routeCodes,
      feeStroops: quoted.feeStroops,
    });
  }

  async function executeSwap(
    quote: SwapQuote,
    adapter: WalletAdapter,
    signerPublicKey: string,
    options: ExecuteSwapOptions = {},
  ): Promise<SorokitResult<SwapExecution>> {
    const attempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
    const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    options.onProgress?.("signing");
    const signed = await signTransaction(adapter, {
      transactionXdr: quote.transactionXdr,
      networkPassphrase: networkConfig.networkPassphrase,
      accountToSign: signerPublicKey,
    });
    // Wallet rejections keep their own code — the user cancelled, the router
    // never saw the swap — so they are returned unchanged.
    if (signed.status === "error") return signed;

    options.onProgress?.("submitting");
    const submitted = await submitTransaction(
      networkConfig.horizonUrl,
      networkConfig.networkPassphrase,
      signed.data,
    );
    if (submitted.status === "error") {
      const failure = describeRouterSwapFailure(
        new Error(submitted.error.message),
      );
      return err(failure.code, failure.message, submitted.error.cause);
    }

    let transaction = submitted.data;

    // Horizon acknowledges a submission before the swap is queryable, and a
    // transaction can be included in a ledger yet fail (the route moved past
    // the slippage bound). Poll until the ledger result is readable so the UI
    // reports what actually happened instead of "submitted".
    options.onProgress?.("confirming");
    for (let attempt = 0; attempt < attempts; attempt++) {
      const status = await getTransactionStatus(
        networkConfig.horizonUrl,
        transaction.hash,
      );
      // A not-yet-visible transaction and a transient lookup failure look the
      // same from here — keep the last known state and try again.
      if (status.status === "ok" && status.data.status !== "pending") {
        transaction = status.data;
        break;
      }
      if (attempt < attempts - 1) await delay(intervalMs);
    }

    if (transaction.status === "failed") {
      return err(
        SorokitErrorCode.ROUTER_SWAP_FAILED,
        `Swap ${transaction.hash} failed on-chain. The route may have moved beyond the ${quote.slippageTolerancePercent}% slippage bound of ${quote.slippageBound}.`,
        transaction,
      );
    }

    return ok({ hash: transaction.hash, transaction });
  }

  return ok({ networkConfig, getQuote, executeSwap });
}

/**
 * Format a quote for display, e.g.
 * "100.0000000 XLM → 24.1500000 USDC via XLM → USDC (min 24.0292500, fee 100 stroops)".
 */
export function formatQuote(quote: SwapQuote): string {
  const [sendCode = "?"] = quote.route;
  const receiveCode = quote.route[quote.route.length - 1] ?? "?";
  const boundLabel = quote.mode === "strict-send" ? "min" : "max";
  return (
    `${quote.sendAmount} ${sendCode} → ${quote.receiveAmount} ${receiveCode} ` +
    `via ${quote.route.join(" → ")} ` +
    `(${boundLabel} ${quote.slippageBound}, fee ${quote.feeStroops} stroops)`
  );
}
