import {
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  BASE_FEE,
  Account,
  StrKey,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

import { validateIssuer } from "../shared/validateIssuer";
import { profileOperation } from "../shared/metrics";

import {
  isNetworkConnectivityError,
  isTimeoutError,
  isXdrInvalidError,
  toMessage,
  isNotFoundError,
  retryWithBackoff,
} from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import { createHorizonServer, createSorobanServer } from "../shared/serverFactory";
import { MAX_OPERATIONS_PER_TRANSACTION } from "./validateTransaction";
import type {
  MemoParams,
  MemoValidationConfig,
  PaymentParams,
  TrustlineParams,
  AccountCreateParams,
  PaymentWithTrustlineParams,
  SwapTransactionParams,
  ReverseTransactionParams,
  PathPaymentParams,
  AtomicSwapParams,
} from "./types";

// ─── Sequence cache (shared across builders for autoFetchSequence) ────────────

const SEQUENCE_CACHE_TTL_MS = 5_000;
const _sequenceCache = new Map<
  string,
  { sequence: string; cachedAt: number }
>();

function getSequenceCacheEntry(publicKey: string): Account | null {
  const entry = _sequenceCache.get(publicKey);
  if (!entry || Date.now() - entry.cachedAt > SEQUENCE_CACHE_TTL_MS) {
    _sequenceCache.delete(publicKey);
    return null;
  }
  return new Account(publicKey, entry.sequence);
}

function updateSequenceCache(
  publicKey: string,
  postBuildSequence: string,
): void {
  const existing = _sequenceCache.get(publicKey);
  _sequenceCache.set(publicKey, {
    sequence: postBuildSequence,
    cachedAt: existing?.cachedAt ?? Date.now(),
  });
}

/** Clear the module-level sequence cache. Useful for test isolation. */
export function clearSequenceCache(): void {
  _sequenceCache.clear();
}

// ─── Offline helper ───────────────────────────────────────────────────────────

/**
 * Resolve the source account for transaction building.
 *
 * - If `sequenceNumber` is provided, creates a local `Account` instance
 *   (offline mode — no network calls).
 * - Otherwise, fetches from Horizon (with optional sequence cache).
 *
 * @param horizonUrl       - Required when fetching from network.
 * @param sourcePublicKey  - The source account G-address.
 * @param sequenceNumber   - Optional offline sequence number.
 * @param autoFetchSequence - Whether to use the module-level sequence cache.
 * @returns `ok(Account)` or `error(TX_BUILD_FAILED)`.
 */
async function resolveSourceAccount(
  horizonUrl: string,
  sourcePublicKey: string,
  sequenceNumber?: string,
  autoFetchSequence?: boolean,
): Promise<SorokitResult<Account>> {
  // Offline path — no network call
  if (sequenceNumber !== undefined) {
    return ok(new Account(sourcePublicKey, sequenceNumber));
  }

  try {
    if (autoFetchSequence === true) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        return ok(cached);
      }
    }
    const server = createHorizonServer(horizonUrl);
    const sourceAccount = await server.loadAccount(sourcePublicKey);
    return ok(sourceAccount);
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to load source account: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Resolve the fee for a transaction.
 * Returns the provided `estimatedFee` or falls back to `BASE_FEE`.
 */
function resolveFee(estimatedFee?: string): string {
  return estimatedFee ?? BASE_FEE;
}

// ─────────────────────────────────────────────────────────────────────────────

function describeTransactionBuildFailure(
  action: string,
  cause: unknown,
): string {
  if (isTimeoutError(cause)) {
    return `Failed to build ${action} transaction because Horizon timed out: ${toMessage(cause)}`;
  }
  if (isNetworkConnectivityError(cause)) {
    return `Failed to build ${action} transaction due to network connectivity: ${toMessage(cause)}`;
  }
  return `Failed to build ${action} transaction: ${toMessage(cause)}`;
}

function isOfflineMode(params: { sequenceNumber?: string }): boolean {
  return (
    typeof params.sequenceNumber === "string" &&
    params.sequenceNumber.trim().length > 0
  );
}

function resolveAsset(
  assetCode?: string,
  assetIssuer?: string,
): SorokitResult<Asset> {
  if (!assetCode || assetCode.toUpperCase() === "XLM") {
    return ok(Asset.native());
  }
  if (!assetIssuer) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Asset issuer is required for non-native asset: ${assetCode}`,
    );
  }
  return ok(new Asset(assetCode, assetIssuer));
}

/**
 * Validate memo enforcement policy on transaction builder parameters.
 *
 * Checks `requireMemo`, `memoValidation` rules ("required", "prohibit", "require_format"),
 * and custom `memoValidator` callbacks before serialization.
 * Keeps policy validation separate from memo serialization.
 */
export function validateMemoPolicy(params: MemoParams): SorokitResult<void> {
  const hasMemo = typeof params.memo === "string" && params.memo.length > 0;

  // 1. Backward-compatible requireMemo flag
  if (params.requireMemo && !hasMemo) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Memo is required for this transaction",
    );
  }

  // 2. Structured memoValidation policy
  if (params.memoValidation) {
    const config: MemoValidationConfig =
      typeof params.memoValidation === "string"
        ? { rule: params.memoValidation }
        : params.memoValidation;

    switch (config.rule) {
      case "required":
        if (!hasMemo) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            config.errorMessage || "Memo is required for this transaction",
          );
        }
        break;

      case "prohibit":
        if (params.memo !== undefined && params.memo !== "") {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            config.errorMessage || "Memo is prohibited for this transaction",
          );
        }
        break;

      case "require_format": {
        if (!hasMemo) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            config.errorMessage || "Memo is required to match specified format",
          );
        }

        if (!config.format) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            "Format pattern is required when memo validation rule is require_format",
          );
        }

        let isMatch = false;
        if (config.format instanceof RegExp) {
          isMatch = config.format.test(params.memo as string);
        } else if (typeof config.format === "string") {
          try {
            const regex = new RegExp(config.format);
            isMatch = regex.test(params.memo as string);
          } catch (cause) {
            return err(
              SorokitErrorCode.TX_BUILD_FAILED,
              `Invalid regex format pattern "${config.format}": ${toMessage(cause)}`,
              cause,
            );
          }
        } else if (typeof config.format === "function") {
          isMatch = config.format(params.memo as string);
        }

        if (!isMatch) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            config.errorMessage ||
              `Memo "${params.memo}" does not match required format`,
          );
        }
        break;
      }

      default:
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          `Unsupported memo validation rule: ${(config as any).rule}`,
        );
    }
  }

  // 3. Custom memoValidator callback
  if (hasMemo && params.memoValidator) {
    const validationResult = params.memoValidator(params.memo as string);
    if (validationResult.status === "error") {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        validationResult.error.message,
        validationResult.error.cause,
      );
    }
  }

  return ok(undefined);
}

function validateMemoParams(
  params: MemoParams,
): SorokitResult<Memo | undefined> {
  const policyResult = validateMemoPolicy(params);
  if (policyResult.status === "error") {
    return policyResult;
  }

  if (!params.memo) {
    return ok(undefined);
  }

  const memoType = params.memoType ?? "text";

  try {
    switch (memoType) {
      case "text":
        return ok(Memo.text(params.memo));
      case "id":
        return ok(Memo.id(params.memo));
      case "hash":
        return ok(Memo.hash(params.memo));
      case "return":
        return ok(Memo["return"](params.memo));
      default:
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          `Unsupported memo type: ${memoType}. Supported memo types are text, id, hash, return.`,
        );
    }
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid memo for type ${memoType}: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Build an unsigned payment transaction XDR.
 *
 * Fetches the current sequence number from Horizon unless `autoFetchSequence`
 * is `true` and a cached sequence is available (TTL: 5 s). Validates the asset
 * issuer against `trustedIssuers` when provided.
 *
 * @param horizonUrl     - Base URL of the Horizon server.
 * @param networkConfig  - Resolved network configuration (passphrase, URLs).
 * @param sourcePublicKey - G-address of the transaction source account.
 * @param params          - Payment parameters: destination, amount, asset, memo.
 * @param trustedIssuers  - Optional whitelist of trusted issuer G-addresses.
 * @returns `ok(xdr)` — unsigned transaction XDR ready for signing,
 *          or `error(TX_BUILD_FAILED)` on any build error.
 *
 * @example
 * const result = await buildPaymentTransaction(horizonUrl, networkConfig, sourceKey, {
 *   destination: "GDEST...",
 *   amount: "10",
 *   assetCode: "USDC",
 *   assetIssuer: "GA5ZS...",
 * });
 * if (result.status === "ok") {
 *   const signed = await signTransaction(adapter, { transactionXdr: result.data, networkPassphrase });
 * }
 */
export async function buildPaymentTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: PaymentParams,
  trustedIssuers?: string[] | null,
): Promise<SorokitResult<string>> {
  return profileOperation("transaction.buildPayment", () =>
    buildPaymentTransactionInner(
      horizonUrl,
      networkConfig,
      sourcePublicKey,
      params,
      trustedIssuers,
    ),
  );
}

async function buildPaymentTransactionInner(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: PaymentParams,
  trustedIssuers?: string[] | null,
): Promise<SorokitResult<string>> {
  const assetResult = resolveAsset(params.assetCode, params.assetIssuer);
  if (assetResult.status === "error") return assetResult;

  // Validate issuer against whitelist if configured and not native
  if (
    params.assetCode &&
    params.assetCode.toUpperCase() !== "XLM" &&
    params.assetIssuer &&
    trustedIssuers !== null &&
    trustedIssuers !== undefined &&
    trustedIssuers.length > 0
  ) {
    try {
      validateIssuer(params.assetIssuer, trustedIssuers);
    } catch (cause: unknown) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        (cause as Error)?.message || String(cause),
        cause,
      );
    }
  }

  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

  // Resolve source account (offline if sequenceNumber is provided)
  const sourceResult = await resolveSourceAccount(
    horizonUrl,
    sourcePublicKey,
    params.sequenceNumber,
    params.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const sourceAccount = sourceResult.data;
  const fee = resolveFee(params.estimatedFee);

  try {
    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: params.destination,
          asset: assetResult.data,
          amount: params.amount,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();
    // Only update cache when using autoFetchSequence (not in offline mode)
    if (params.autoFetchSequence === true && params.sequenceNumber === undefined) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("payment", cause),
      cause,
    );
  }
}

/**
 * Build an unsigned create-account transaction XDR.
 *
 * Creates the target account on the Stellar network and funds it with
 * `startingBalance` XLM. The source account must hold sufficient XLM to
 * cover both the starting balance and transaction fee.
 *
 * @param horizonUrl      - Base URL of the Horizon server.
 * @param networkConfig   - Resolved network configuration.
 * @param sourcePublicKey - G-address of the funding account.
 * @param params          - Destination address, starting balance in XLM, and optional memo.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error(TX_BUILD_FAILED)`.
 *
 * @example
 * const result = await buildCreateAccountTransaction(horizonUrl, networkConfig, sourceKey, {
 *   destination: "GDEST...",
 *   startingBalance: "1",
 * });
 */
export async function buildCreateAccountTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: AccountCreateParams,
): Promise<SorokitResult<string>> {
  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

  // Resolve source account (offline if sequenceNumber is provided)
  const sourceResult = await resolveSourceAccount(
    horizonUrl,
    sourcePublicKey,
    params.sequenceNumber,
    params.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const sourceAccount = sourceResult.data;
  const fee = resolveFee(params.estimatedFee);

  try {
    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.createAccount({
          destination: params.destination,
          startingBalance: params.startingBalance,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();
    if (params.autoFetchSequence === true && params.sequenceNumber === undefined) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("create account", cause),
      cause,
    );
  }
}

/**
 * Build an unsigned change-trust (trustline) transaction XDR.
 *
 * Adds or removes a trustline for a non-native asset. Setting `limit` to `"0"`
 * removes the trustline. Validates the issuer against `trustedIssuers` when provided.
 *
 * @param horizonUrl      - Base URL of the Horizon server.
 * @param networkConfig   - Resolved network configuration.
 * @param sourcePublicKey - G-address of the account establishing the trustline.
 * @param params          - Asset code, issuer, optional limit, and optional memo.
 * @param trustedIssuers  - Optional whitelist of trusted issuer G-addresses.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error(TX_BUILD_FAILED)`.
 *
 * @example
 * const result = await buildTrustlineTransaction(horizonUrl, networkConfig, sourceKey, {
 *   assetCode: "USDC",
 *   assetIssuer: "GA5ZS...",
 * });
 */
export async function buildTrustlineTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: TrustlineParams,
  trustedIssuers?: string[] | null,
): Promise<SorokitResult<string>> {
  // Validate issuer against whitelist if configured
  if (
    trustedIssuers !== null &&
    trustedIssuers !== undefined &&
    trustedIssuers.length > 0
  ) {
    try {
      validateIssuer(params.assetIssuer, trustedIssuers);
    } catch (cause: unknown) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        (cause as Error)?.message || String(cause),
        cause,
      );
    }
  }

  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

  // Resolve source account (offline if sequenceNumber is provided)
  const sourceResult = await resolveSourceAccount(
    horizonUrl,
    sourcePublicKey,
    params.sequenceNumber,
    params.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const sourceAccount = sourceResult.data;
  const fee = resolveFee(params.estimatedFee);

  try {
    const asset = new Asset(params.assetCode, params.assetIssuer);

    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset,
          ...(params.limit !== undefined && { limit: params.limit }),
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();
    if (params.autoFetchSequence === true && params.sequenceNumber === undefined) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("trustline", cause),
      cause,
    );
  }
}

/**
 * Build a payment transaction with trustline setup.
 * Establishes trust for the asset before sending payment.
 */
export async function buildPaymentWithTrustline(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: PaymentWithTrustlineParams,
): Promise<SorokitResult<string>> {
  const memoResult = validateMemoParams(params.payment);
  if (memoResult.status === "error") return memoResult;

  // Resolve source account (offline if sequenceNumber is provided on trustline or payment)
  const sequenceNumber = params.trustline.sequenceNumber ?? params.payment.sequenceNumber;
  const estimatedFee = params.trustline.estimatedFee ?? params.payment.estimatedFee;
  const sourceResult = await resolveSourceAccount(
    horizonUrl,
    sourcePublicKey,
    sequenceNumber,
    params.trustline.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const sourceAccount = sourceResult.data;
  const fee = resolveFee(estimatedFee);

  try {
    const trustlineAssetResult = resolveAsset(
      params.trustline.assetCode,
      params.trustline.assetIssuer,
    );
    if (trustlineAssetResult.status === "error") return trustlineAssetResult;

    const paymentAssetResult = resolveAsset(
      params.payment.assetCode,
      params.payment.assetIssuer,
    );
    if (paymentAssetResult.status === "error") return paymentAssetResult;

    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset: trustlineAssetResult.data,
          ...(params.trustline.limit !== undefined && {
            limit: params.trustline.limit,
          }),
        }),
      )
      .addOperation(
        Operation.payment({
          destination: params.payment.destination,
          asset: paymentAssetResult.data,
          amount: params.payment.amount,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    return ok(builder.build().toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("payment with trustline", cause),
      cause,
    );
  }
}

/**
 * Build a swap transaction with two payments.
 * Used for atomic swaps where two payments must succeed together.
 */
export async function buildSwapTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: SwapTransactionParams,
): Promise<SorokitResult<string>> {
  const memoResult = validateMemoParams(params.paymentA);
  if (memoResult.status === "error") return memoResult;

  const assetAResult = resolveAsset(
    params.paymentA.assetCode,
    params.paymentA.assetIssuer,
  );
  if (assetAResult.status === "error") return assetAResult;

  const assetBResult = resolveAsset(
    params.paymentB.assetCode,
    params.paymentB.assetIssuer,
  );
  if (assetBResult.status === "error") return assetBResult;

  // Resolve source account (offline if sequenceNumber is provided on paymentA or paymentB)
  const sequenceNumber = params.paymentA.sequenceNumber ?? params.paymentB.sequenceNumber;
  const estimatedFee = params.paymentA.estimatedFee ?? params.paymentB.estimatedFee;
  const sourceResult = await resolveSourceAccount(
    horizonUrl,
    sourcePublicKey,
    sequenceNumber,
    params.paymentA.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const sourceAccount = sourceResult.data;
  const fee = resolveFee(estimatedFee);

  try {
    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: params.paymentA.destination,
          asset: assetAResult.data,
          amount: params.paymentA.amount,
        }),
      )
      .addOperation(
        Operation.payment({
          destination: params.paymentB.destination,
          asset: assetBResult.data,
          amount: params.paymentB.amount,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    return ok(builder.build().toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("swap", cause),
      cause,
    );
  }
}

/**
 * Build a reverse transaction XDR for the given original transaction XDR.
 * Supports reversing: payments, trustlines (removes the trust), and account creations (merges the account).
 * Returns the unsigned reverse XDR ready for signing.
 */
export async function buildReverseTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  originalXdr: string,
  params?: ReverseTransactionParams,
): Promise<SorokitResult<string>> {
  if (isXdrInvalidError(originalXdr)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Cannot build reverse transaction: the provided XDR is malformed.",
      originalXdr,
    );
  }

  try {
    const originalTx = TransactionBuilder.fromXDR(
      originalXdr,
      networkConfig.networkPassphrase,
    );

    const operations = originalTx.operations;
    if (operations.length === 0) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Original transaction has no operations to reverse",
      );
    }

    // Resolve source account (offline if sequenceNumber is provided)
    const sourceResult = await resolveSourceAccount(
      horizonUrl,
      sourcePublicKey,
      params?.sequenceNumber,
    );
    if (sourceResult.status === "error") return sourceResult;
    const sourceAccount = sourceResult.data;
    const fee = params?.estimatedFee ?? params?.fee ?? resolveFee();

    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    for (const op of operations) {
      switch (op.type) {
        case "payment": {
          const payOp = op as Operation.Payment;
          builder.addOperation(
            Operation.payment({
              destination: payOp.source ?? sourcePublicKey,
              asset: payOp.asset,
              amount: payOp.amount,
              source: payOp.destination,
            }),
          );
          break;
        }
        case "changeTrust": {
          const trustOp = op as Operation.ChangeTrust;
          builder.addOperation(
            Operation.changeTrust({
              asset: trustOp.line as Asset,
              limit: "0",
            }),
          );
          break;
        }
        case "createAccount": {
          const createOp = op as Operation.CreateAccount;
          builder.addOperation(
            Operation.accountMerge({
              destination: createOp.source ?? sourcePublicKey,
              source: createOp.destination,
            }),
          );
          break;
        }
        default:
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            `Cannot reverse operation type: ${op.type}`,
          );
      }
    }

    const tx = builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS).build();
    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("reverse", cause),
      cause,
    );
  }
}

function resolvePathAssets(
  path?: PathPaymentParams["path"],
): SorokitResult<Asset[]> {
  const assets: Asset[] = [];
  for (const hop of path ?? []) {
    const result = resolveAsset(hop.assetCode, hop.assetIssuer);
    if (result.status === "error") return result;
    assets.push(result.data);
  }
  return ok(assets);
}

/**
 * Build a path payment transaction XDR.
 * Use mode "strict-send" to send an exact amount, or "strict-receive" to receive an exact amount.
 * Returns the unsigned XDR ready for signing.
 */
export async function buildPathPayment(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: PathPaymentParams,
  trustedIssuers?: string[] | null,
): Promise<SorokitResult<string>> {
  const sendAssetResult = resolveAsset(
    params.sendAssetCode,
    params.sendAssetIssuer,
  );
  if (sendAssetResult.status === "error") return sendAssetResult;

  const destAssetResult = resolveAsset(
    params.destAssetCode,
    params.destAssetIssuer,
  );
  if (destAssetResult.status === "error") return destAssetResult;

  if (
    trustedIssuers !== null &&
    trustedIssuers !== undefined &&
    trustedIssuers.length > 0
  ) {
    try {
      if (
        params.sendAssetCode &&
        params.sendAssetCode.toUpperCase() !== "XLM" &&
        params.sendAssetIssuer
      ) {
        validateIssuer(params.sendAssetIssuer, trustedIssuers);
      }
      if (
        params.destAssetCode &&
        params.destAssetCode.toUpperCase() !== "XLM" &&
        params.destAssetIssuer
      ) {
        validateIssuer(params.destAssetIssuer, trustedIssuers);
      }
      for (const hop of params.path ?? []) {
        if (
          hop.assetCode &&
          hop.assetCode.toUpperCase() !== "XLM" &&
          hop.assetIssuer
        ) {
          validateIssuer(hop.assetIssuer, trustedIssuers);
        }
      }
    } catch (cause: unknown) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        (cause as Error)?.message || String(cause),
        cause,
      );
    }
  }

  try {
    const server = createHorizonServer(horizonUrl);

    let finalPath = params.path;
    let finalSlippageAmount = params.slippageAmount;

    if (!finalPath || finalPath.length === 0 || !finalSlippageAmount) {
      if (params.mode === "strict-send") {
        const response = await server
          .strictSendPaths(sendAssetResult.data, params.amount, [
            destAssetResult.data,
          ])
          .call();
        if (response.records.length === 0) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            "No path found for strict-send payment.",
          );
        }
        const bestPath = response.records.reduce((prev, curr) =>
          Number(curr.destination_amount) > Number(prev.destination_amount)
            ? curr
            : prev,
        );
        if (!finalPath || finalPath.length === 0) {
          finalPath = bestPath.path.map((a) => ({
            assetCode: a.asset_code,
            assetIssuer: a.asset_issuer,
          }));
        }
        if (!finalSlippageAmount) {
          finalSlippageAmount = bestPath.destination_amount;
        }
      } else {
        const response = await server
          .strictReceivePaths(
            [sendAssetResult.data],
            destAssetResult.data,
            params.amount,
          )
          .call();
        if (response.records.length === 0) {
          return err(
            SorokitErrorCode.TX_BUILD_FAILED,
            "No path found for strict-receive payment.",
          );
        }
        const bestPath = response.records.reduce((prev, curr) =>
          Number(curr.source_amount) < Number(prev.source_amount) ? curr : prev,
        );
        if (!finalPath || finalPath.length === 0) {
          finalPath = bestPath.path.map((a) => ({
            assetCode: a.asset_code,
            assetIssuer: a.asset_issuer,
          }));
        }
        if (!finalSlippageAmount) {
          finalSlippageAmount = bestPath.source_amount;
        }
      }
    }

    const pathResult = resolvePathAssets(finalPath);
    if (pathResult.status === "error") return pathResult;

    // Resolve source account (offline if sequenceNumber is provided)
    const sourceResult = await resolveSourceAccount(
      horizonUrl,
      sourcePublicKey,
      params.sequenceNumber,
      params.autoFetchSequence,
    );
    if (sourceResult.status === "error") return sourceResult;
    const sourceAccount = sourceResult.data;
    const fee = resolveFee(params.estimatedFee);

    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    if (params.mode === "strict-send") {
      builder.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: sendAssetResult.data,
          sendAmount: params.amount,
          destination: params.destination,
          destAsset: destAssetResult.data,
          destMin: finalSlippageAmount,
          path: pathResult.data,
        }),
      );
    } else {
      builder.addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: sendAssetResult.data,
          sendMax: finalSlippageAmount,
          destination: params.destination,
          destAsset: destAssetResult.data,
          destAmount: params.amount,
          path: pathResult.data,
        }),
      );
    }

    builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    const memoResult = validateMemoParams(params);
    if (memoResult.status === "error") return memoResult;
    if (memoResult.status === "ok" && memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();
    if (params.autoFetchSequence === true && params.sequenceNumber === undefined) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("path payment", cause),
      cause,
    );
  }
}

/**
 * Build an atomic swap transaction XDR containing two path payment legs.
 * Both legs execute atomically — if either fails, neither applies.
 * Returns the unsigned XDR ready for signing.
 */
export async function buildAtomicSwap(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: AtomicSwapParams,
): Promise<SorokitResult<string>> {
  const sendAssetAResult = resolveAsset(
    params.legA.sendAssetCode,
    params.legA.sendAssetIssuer,
  );
  if (sendAssetAResult.status === "error") return sendAssetAResult;

  const destAssetAResult = resolveAsset(
    params.legA.destAssetCode,
    params.legA.destAssetIssuer,
  );
  if (destAssetAResult.status === "error") return destAssetAResult;

  const pathAResult = resolvePathAssets(params.legA.path);
  if (pathAResult.status === "error") return pathAResult;

  const sendAssetBResult = resolveAsset(
    params.legB.sendAssetCode,
    params.legB.sendAssetIssuer,
  );
  if (sendAssetBResult.status === "error") return sendAssetBResult;

  const destAssetBResult = resolveAsset(
    params.legB.destAssetCode,
    params.legB.destAssetIssuer,
  );
  if (destAssetBResult.status === "error") return destAssetBResult;

  const pathBResult = resolvePathAssets(params.legB.path);
  if (pathBResult.status === "error") return pathBResult;

  const slippageA = params.legA.slippageAmount;
  const slippageB = params.legB.slippageAmount;

  if (!slippageA || !slippageB) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "slippageAmount is required for both legs of an atomic swap.",
    );
  }

  try {
    // Resolve source account (offline if sequenceNumber is provided)
    const sourceResult = await resolveSourceAccount(
      horizonUrl,
      sourcePublicKey,
      params.sequenceNumber,
    );
    if (sourceResult.status === "error") return sourceResult;
    const sourceAccount = sourceResult.data;
    const fee = resolveFee(params.estimatedFee);

    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    if (params.legA.mode === "strict-send") {
      builder.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: sendAssetAResult.data,
          sendAmount: params.legA.amount,
          destination: params.legA.destination,
          destAsset: destAssetAResult.data,
          destMin: slippageA,
          path: pathAResult.data,
        }),
      );
    } else {
      builder.addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: sendAssetAResult.data,
          sendMax: slippageA,
          destination: params.legA.destination,
          destAsset: destAssetAResult.data,
          destAmount: params.legA.amount,
          path: pathAResult.data,
        }),
      );
    }

    if (params.legB.mode === "strict-send") {
      builder.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: sendAssetBResult.data,
          sendAmount: params.legB.amount,
          destination: params.legB.destination,
          destAsset: destAssetBResult.data,
          destMin: slippageB,
          path: pathBResult.data,
        }),
      );
    } else {
      builder.addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: sendAssetBResult.data,
          sendMax: slippageB,
          destination: params.legB.destination,
          destAsset: destAssetBResult.data,
          destAmount: params.legB.amount,
          path: pathBResult.data,
        }),
      );
    }

    builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    const memoResult = validateMemoParams(params);
    if (memoResult.status === "error") return memoResult;
    if (memoResult.status === "ok" && memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    return ok(builder.build().toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("atomic swap", cause),
      cause,
    );
  }
}


export async function checkTrustlines(
  horizonUrl: string,
  publicKey: string,
  assetCodes: string[],
): Promise<SorokitResult<string[]>> {
  try {
    const server = createHorizonServer(horizonUrl);
    const account = await server.loadAccount(publicKey);

    const codeSet = new Set(assetCodes);
    const trusted: string[] = [];

    for (const balance of account.balances) {
      if (balance.asset_type !== "native") {
        const code = (balance as Horizon.HorizonApi.BalanceLineAsset).asset_code;
        if (codeSet.has(code)) {
          trusted.push(code);
        }
      }
    }

    return ok(trusted);
  } catch (cause: unknown) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("check trustlines", cause),
      cause,
    );
  }
}

export async function buildBulkTrustlines(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  assets: Asset[],
  autoFetchSequence?: boolean,
  sequenceNumber?: string,
  estimatedFee?: string,
): Promise<SorokitResult<string>> {
  // Resolve source account (offline if sequenceNumber is provided)
  const sourceResult = await resolveSourceAccount(
    horizonUrl,
    sourcePublicKey,
    sequenceNumber,
    autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const sourceAccount = sourceResult.data;
  const fee = resolveFee(estimatedFee);

  try {
    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    for (const asset of assets) {
      builder.addOperation(Operation.changeTrust({ asset }));
    }

    const transaction = builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS).build();

    if (autoFetchSequence === true && sequenceNumber === undefined) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(transaction.toXDR());
  } catch (cause: unknown) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("bulk trustlines", cause),
      cause,
    );
  }
}

// ─── High-level trustline management utilities (#402) ────────────────────────

/**
 * State of a single asset's trustline for an account, as returned by
 * {@link validateTrustline} and {@link getBulkTrustlines}.
 */
export interface TrustlineState {
  /** Asset code, e.g. "USDC" */
  assetCode: string;
  /** Asset issuer G-address (null for the native asset, which never needs a trustline) */
  assetIssuer: string | null;
  /** Whether the account currently holds a trustline for this asset */
  exists: boolean;
  /** Current balance on the trustline, or null if no trustline exists */
  balance: string | null;
  /** Trust limit on the trustline, or null if no trustline exists */
  limit: string | null;
}

/**
 * Check whether an account holds a trustline for a single asset.
 *
 * The native asset (XLM) is always considered trusted since it needs no
 * trustline — `exists` is `true` and `balance`/`limit` reflect the account's
 * native balance (native trustlines have no configurable limit, so `limit`
 * is `null`).
 *
 * @param horizonUrl Base URL of Horizon server
 * @param publicKey  G-address of the account to inspect
 * @param asset      Asset to check (code + issuer; issuer required for non-native)
 * @returns `ok(TrustlineState)` describing the trustline, or an error.
 *
 * @example
 * const result = await validateTrustline(horizonUrl, publicKey, {
 *   code: "USDC",
 *   issuer: "GA5ZS...",
 * });
 * if (result.status === "ok" && result.data.exists) { ... }
 */
export async function validateTrustline(
  horizonUrl: string,
  publicKey: string,
  asset: { code: string; issuer: string | null },
): Promise<SorokitResult<TrustlineState>> {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${publicKey}`);
  }
  const assetValidation = resolveAsset(
    asset.code,
    asset.issuer ?? undefined,
  );
  if (assetValidation.status === "error") return assetValidation;

  try {
    const server = createHorizonServer(horizonUrl);
    const account = await server.loadAccount(publicKey);
    const isNative = !asset.issuer || asset.code.toUpperCase() === "XLM";

    for (const balance of account.balances) {
      if (isNative) {
        if (balance.asset_type === "native") {
          return ok({
            assetCode: "XLM",
            assetIssuer: null,
            exists: true,
            balance: balance.balance,
            limit: null,
          });
        }
        continue;
      }

      if (balance.asset_type !== "native") {
        const line = balance as Horizon.HorizonApi.BalanceLineAsset;
        if (line.asset_code === asset.code && line.asset_issuer === asset.issuer) {
          return ok({
            assetCode: asset.code,
            assetIssuer: asset.issuer,
            exists: true,
            balance: line.balance,
            limit: line.limit,
          });
        }
      }
    }

    return ok({
      assetCode: isNative ? "XLM" : asset.code,
      assetIssuer: isNative ? null : asset.issuer,
      exists: false,
      balance: null,
      limit: null,
    });
  } catch (cause: unknown) {
    return err(
      isNotFoundError(cause) ? SorokitErrorCode.ACCOUNT_NOT_FOUND : SorokitErrorCode.TX_BUILD_FAILED,
      isNotFoundError(cause)
        ? `Account not found: ${publicKey}`
        : describeTransactionBuildFailure("validate trustline", cause),
      cause,
    );
  }
}

/**
 * Look up trustline state for multiple assets on a single account, running
 * the lookups concurrently against a single loaded account (one Horizon
 * `loadAccount` call, not one per asset).
 *
 * Unlike {@link validateTrustline}, this never fails per-asset — every asset
 * in `assets` gets a `TrustlineState` entry in the returned array, in the
 * same order. The outer result only fails for account-level errors (invalid
 * address, account not found, network failure).
 *
 * @param horizonUrl Base URL of Horizon server
 * @param publicKey  G-address of the account to inspect
 * @param assets     Assets to check (duplicates are preserved positionally)
 * @returns `ok(TrustlineState[])` — one entry per input asset, or an error.
 *
 * @example
 * const result = await getBulkTrustlines(horizonUrl, publicKey, [
 *   { code: "USDC", issuer: usdcIssuer },
 *   { code: "EURC", issuer: eurcIssuer },
 * ]);
 */
export async function getBulkTrustlines(
  horizonUrl: string,
  publicKey: string,
  assets: Array<{ code: string; issuer: string | null }>,
): Promise<SorokitResult<TrustlineState[]>> {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${publicKey}`);
  }
  if (!Array.isArray(assets) || assets.length === 0) {
    return ok([]);
  }
  for (const asset of assets) {
    const assetValidation = resolveAsset(asset.code, asset.issuer ?? undefined);
    if (assetValidation.status === "error") return assetValidation;
  }

  try {
    const server = createHorizonServer(horizonUrl);
    const account = await server.loadAccount(publicKey);

    // Index existing balances once, then resolve every requested asset
    // against that index concurrently (no further network calls needed —
    // "concurrently" here means no asset lookup blocks another).
    const nonNativeByKey = new Map<string, Horizon.HorizonApi.BalanceLineAsset>();
    let nativeBalance: string | null = null;
    for (const balance of account.balances) {
      if (balance.asset_type === "native") {
        nativeBalance = balance.balance;
      } else {
        const line = balance as Horizon.HorizonApi.BalanceLineAsset;
        nonNativeByKey.set(`${line.asset_code}:${line.asset_issuer}`, line);
      }
    }

    const results = await Promise.all(
      assets.map(async (asset): Promise<TrustlineState> => {
        const isNative = !asset.issuer || asset.code.toUpperCase() === "XLM";
        if (isNative) {
          return {
            assetCode: "XLM",
            assetIssuer: null,
            exists: nativeBalance !== null,
            balance: nativeBalance,
            limit: null,
          };
        }
        const line = nonNativeByKey.get(`${asset.code}:${asset.issuer}`);
        return {
          assetCode: asset.code,
          assetIssuer: asset.issuer,
          exists: line !== undefined,
          balance: line?.balance ?? null,
          limit: line?.limit ?? null,
        };
      }),
    );

    return ok(results);
  } catch (cause: unknown) {
    return err(
      isNotFoundError(cause) ? SorokitErrorCode.ACCOUNT_NOT_FOUND : SorokitErrorCode.TX_BUILD_FAILED,
      isNotFoundError(cause)
        ? `Account not found: ${publicKey}`
        : describeTransactionBuildFailure("bulk trustline lookup", cause),
      cause,
    );
  }
}

/**
 * Build an unsigned transaction containing multiple `changeTrust` operations
 * — one per requested asset — so several trustlines can be established (or
 * removed, via `limit: "0"`) in a single atomic transaction.
 *
 * Validates every asset before building anything, de-duplicates identical
 * asset+limit requests, and rejects the request outright if the number of
 * resulting operations would exceed {@link MAX_OPERATIONS_PER_TRANSACTION} —
 * callers must split large batches into multiple transactions themselves.
 *
 * @param horizonUrl       Base URL of the Horizon server.
 * @param networkConfig    Resolved network configuration.
 * @param sourcePublicKey  G-address of the account establishing the trustlines.
 * @param assets           Assets to trust, each with an optional per-asset limit
 *                          (omit for max limit, or pass `"0"` to remove trust).
 * @param options          Offline sequence/fee overrides, matching other builders.
 * @returns `ok(xdr)` — unsigned transaction XDR, or an error.
 *
 * @example
 * const result = await buildBulkTrustlineTransaction(horizonUrl, networkConfig, sourceKey, [
 *   { code: "USDC", issuer: usdcIssuer },
 *   { code: "EURC", issuer: eurcIssuer, limit: "1000" },
 * ]);
 */
export async function buildBulkTrustlineTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  assets: Array<{ code: string; issuer: string; limit?: string }>,
  options?: {
    autoFetchSequence?: boolean;
    sequenceNumber?: string;
    estimatedFee?: string;
  },
): Promise<SorokitResult<string>> {
  if (!StrKey.isValidEd25519PublicKey(sourcePublicKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${sourcePublicKey}`);
  }
  if (!Array.isArray(assets) || assets.length === 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "buildBulkTrustlineTransaction: at least one asset is required.",
    );
  }

  // De-duplicate identical (code, issuer, limit) requests — a duplicate
  // trustline operation is redundant, not an error, so we collapse rather
  // than reject.
  const seen = new Set<string>();
  const deduped: Array<{ code: string; issuer: string; limit?: string }> = [];
  for (const asset of assets) {
    const assetValidation = resolveAsset(asset.code, asset.issuer);
    if (assetValidation.status === "error") return assetValidation;
    if (!asset.issuer) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `buildBulkTrustlineTransaction: asset issuer is required for ${asset.code} (trustlines cannot target the native asset).`,
      );
    }
    const key = `${asset.code}:${asset.issuer}:${asset.limit ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(asset);
  }

  if (deduped.length > MAX_OPERATIONS_PER_TRANSACTION) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `buildBulkTrustlineTransaction: ${deduped.length} trustline operations requested but a transaction supports at most ${MAX_OPERATIONS_PER_TRANSACTION}. Split the assets into multiple transactions.`,
    );
  }

  const sourceResult = await resolveSourceAccount(
    horizonUrl,
    sourcePublicKey,
    options?.sequenceNumber,
    options?.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const sourceAccount = sourceResult.data;
  const fee = resolveFee(options?.estimatedFee);

  try {
    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    for (const asset of deduped) {
      builder.addOperation(
        Operation.changeTrust({
          asset: new Asset(asset.code, asset.issuer),
          ...(asset.limit !== undefined && { limit: asset.limit }),
        }),
      );
    }

    const transaction = builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS).build();

    if (options?.autoFetchSequence === true && options?.sequenceNumber === undefined) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(transaction.toXDR());
  } catch (cause: unknown) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("bulk trustline transaction", cause),
      cause,
    );
  }
}

export interface AccountMergeOptions extends MemoParams {
  autoFetchSequence?: boolean;
  checkExists?: boolean;
  /**
   * Pre-fetched sequence number for the source account.
   * When provided, no Horizon `loadAccount` call is made.
   */
  sequenceNumber?: string;
  /**
   * Pre-fetched fee in stroops.
   * When provided, this value is used instead of BASE_FEE.
   */
  estimatedFee?: string;
}

/**
 * Build an unsigned account merge transaction XDR.
 *
 * Merges the source account into the destination account. The source account
 * will be deleted from the ledger, and all its remaining XLM will be transferred
 * to the destination account.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param networkConfig - Resolved network configuration.
 * @param sourcePublicKey - G-address of the account to be merged (deleted).
 * @param destinationPublicKey - G-address of the account to receive the remaining XLM.
 * @param options - Optional parameters: memo, autoFetchSequence, checkExists.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error`.
 */
export async function buildAccountMerge(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  destinationPublicKey: string,
  options?: AccountMergeOptions,
): Promise<SorokitResult<string>> {
  if (options?.checkExists) {
    try {
      const server = createHorizonServer(horizonUrl);
      await retryWithBackoff(() => server.loadAccount(destinationPublicKey));
    } catch (cause) {
      if (isNotFoundError(cause)) {
        return err(
          SorokitErrorCode.ACCOUNT_NOT_FOUND,
          `Destination account ${destinationPublicKey} does not exist.`,
          cause,
        );
      }
      return err(
        SorokitErrorCode.ACCOUNT_FETCH_FAILED,
        `Failed to verify destination account existence: ${toMessage(cause)}`,
        cause,
      );
    }
  }

  const memoResult = options ? validateMemoParams(options) : ok(undefined);
  if (memoResult.status === "error") return memoResult;

  // Resolve source account (offline if sequenceNumber is provided)
  const sourceResult = await resolveSourceAccount(
    horizonUrl,
    sourcePublicKey,
    options?.sequenceNumber,
    options?.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const sourceAccount = sourceResult.data;
  const fee = resolveFee(options?.estimatedFee);

  try {
    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.accountMerge({
          destination: destinationPublicKey,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();
    if (options?.autoFetchSequence === true && options?.sequenceNumber === undefined) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("account merge", cause),
      cause,
    );
  }
}

