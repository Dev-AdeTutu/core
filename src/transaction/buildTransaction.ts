import {
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  BASE_FEE,
  Account,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

import { validateIssuer } from "../shared/validateIssuer";

import {
  isNetworkConnectivityError,
  isTimeoutError,
  isXdrInvalidError,
  toMessage,
} from "../shared";
import { isValidPublicKey } from "../shared/utils";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import type {
  MemoParams,
  PaymentParams,
  TrustlineParams,
  AccountCreateParams,
  PaymentWithTrustlineParams,
  SwapTransactionParams,
  ReverseTransactionParams,
  PathPaymentParams,
  AtomicSwapParams,
  ManageOfferParams,
  ClawbackParams,
  LiquidityPoolDepositParams,
  LiquidityPoolWithdrawParams,
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

/**
 * Resolve an asset from code + optional issuer.
 * Returns SorokitResult<Asset> — never throws.
 */
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

function validateMemoParams(
  params: MemoParams,
): SorokitResult<Memo | undefined> {
  if (!params.memo) {
    if (params.requireMemo) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Memo is required for this transaction",
      );
    }
    return ok(undefined);
  }

  if (params.memoValidator) {
    const validationResult = params.memoValidator(params.memo);
    if (validationResult.status === "error") {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        validationResult.error.message,
        validationResult.error.cause,
      );
    }
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

  try {
    const useCache = params.autoFetchSequence === true;
    let sourceAccount:
      | Account
      | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        const server = new Horizon.Server(horizonUrl);
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      const server = new Horizon.Server(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
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
    if (useCache) {
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

  try {
    const useCache = params.autoFetchSequence === true;
    let sourceAccount:
      | Account
      | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        const server = new Horizon.Server(horizonUrl);
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      const server = new Horizon.Server(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
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
    if (useCache) {
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

  try {
    const useCache = params.autoFetchSequence === true;
    let sourceAccount:
      | Account
      | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        const server = new Horizon.Server(horizonUrl);
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      const server = new Horizon.Server(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const asset = new Asset(params.assetCode, params.assetIssuer);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
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
    if (useCache) {
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
  try {
    const server = new Horizon.Server(horizonUrl);
    const sourceAccount = await server.loadAccount(sourcePublicKey);

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
      fee: BASE_FEE,
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

    if (params.payment.memo) {
      builder.addMemo(Memo.text(params.payment.memo));
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

  try {
    const server = new Horizon.Server(horizonUrl);
    const sourceAccount = await server.loadAccount(sourcePublicKey);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
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

    if (params.paymentA.memo) {
      builder.addMemo(Memo.text(params.paymentA.memo));
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

    const server = new Horizon.Server(horizonUrl);
    const sourceAccount = await server.loadAccount(sourcePublicKey);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: params?.fee ?? BASE_FEE,
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
    const server = new Horizon.Server(horizonUrl);

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

    const useCache = params.autoFetchSequence === true;
    let sourceAccount:
      | Account
      | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
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
    if (useCache) {
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
    const server = new Horizon.Server(horizonUrl);
    const sourceAccount = await server.loadAccount(sourcePublicKey);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
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
    const server = new Horizon.Server(horizonUrl);
    const account = await server.loadAccount(publicKey);

    const codeSet = new Set(assetCodes);
    const trusted: string[] = [];

    for (const balance of account.balances) {
      if (balance.asset_type !== "native") {
        const code = (balance as any).asset_code;
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
      const server = new Horizon.Server(horizonUrl);
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

  try {

    const useCache = autoFetchSequence === true;
    let sourceAccount:
      | Account
      | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        const server = new Horizon.Server(horizonUrl);
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      const server = new Horizon.Server(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
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
    for (const asset of assets) {
      builder.addOperation(Operation.changeTrust({ asset }));
    }

    const transaction = builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS).build();

    if (useCache) {
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


// ─── Manage Offer ─────────────────────────────────────────────────────────────

/**
 * Validate an offer amount string.
 * Must be a non-negative decimal with at most 7 decimal places.
 */
function validateOfferAmount(amount: string): SorokitResult<void> {
  if (typeof amount !== "string" || amount.trim() === "") {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "Offer amount is required.");
  }

  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum < 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Offer amount must be a non-negative number, got: "${amount}".`,
    );
  }

  const decimalMatch = amount.match(/^(\d+)\.?(\d*)$/);
  if (!decimalMatch) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Offer amount has an invalid format: "${amount}". Expected a non-negative decimal number.`,
    );
  }

  const decimalPlaces = decimalMatch[2]?.length ?? 0;
  if (decimalPlaces > 7) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Offer amount exceeds maximum precision of 7 decimal places: "${amount}".`,
    );
  }

  return ok(undefined);
}

/**
 * Validate an offer price value.
 * String prices must be positive with at most 7 decimal places.
 * Rational prices ({ n, d }) must have positive integer numerator and denominator.
 */
function validateOfferPrice(
  price: string | { n: number; d: number },
): SorokitResult<void> {
  if (typeof price === "object") {
    if (!Number.isInteger(price.n) || !Number.isInteger(price.d)) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Offer price numerator and denominator must be integers.",
      );
    }
    if (price.n <= 0 || price.d <= 0) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Offer price numerator and denominator must both be positive.",
      );
    }
    return ok(undefined);
  }

  if (typeof price !== "string" || price.trim() === "") {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "Offer price is required.");
  }

  const priceNum = parseFloat(price);
  if (isNaN(priceNum) || priceNum <= 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Offer price must be a positive number, got: "${price}".`,
    );
  }

  const decimalMatch = price.match(/^(\d+)\.?(\d*)$/);
  if (!decimalMatch) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Offer price has an invalid format: "${price}". Expected a positive decimal number.`,
    );
  }

  const decimalPlaces = decimalMatch[2]?.length ?? 0;
  if (decimalPlaces > 7) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Offer price exceeds maximum precision of 7 decimal places: "${price}".`,
    );
  }

  return ok(undefined);
}

/**
 * Validate the offer ID string.
 * Must be a non-negative integer string (e.g. "0", "12345").
 */
function validateOfferId(offerId: string): SorokitResult<void> {
  if (!/^\d+$/.test(offerId)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `offerId must be a non-negative integer string, got: "${offerId}".`,
    );
  }
  return ok(undefined);
}

/**
 * Build an unsigned manage sell offer transaction XDR.
 *
 * Supports three offer operations via a single function:
 *
 * - **Create** (`offerId` omitted or `"0"`, `amount > 0`):
 *   Posts a new DEX sell offer.
 * - **Update** (`offerId` is a non-zero existing offer ID, `amount > 0`):
 *   Replaces the price and/or amount of an existing offer.
 * - **Cancel** (`offerId` is a non-zero existing offer ID, `amount = "0"`):
 *   Removes an existing offer from the order book.
 *
 * @param horizonUrl      - Base URL of the Horizon server.
 * @param networkConfig   - Resolved network configuration (passphrase, URLs).
 * @param sourcePublicKey - G-address of the account that owns the offer.
 * @param params          - Offer parameters: selling/buying assets, amount, price, offerId.
 * @param trustedIssuers  - Optional whitelist of trusted issuer G-addresses.
 * @returns `ok(xdr)` — unsigned transaction XDR ready for signing,
 *          or `error(TX_BUILD_FAILED)` on any validation or build error.
 *
 * @example
 * // Post a new offer: sell 100 XLM at a price of 1.5 EURC per XLM
 * const result = await buildManageOfferTransaction(horizonUrl, networkConfig, trader, {
 *   sellingAssetCode: "XLM",
 *   buyingAssetCode: "EURC",
 *   buyingAssetIssuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
 *   amount: "100",
 *   price: "1.5",
 * });
 *
 * @example
 * // Cancel offer 12345
 * const cancel = await buildManageOfferTransaction(horizonUrl, networkConfig, trader, {
 *   sellingAssetCode: "XLM",
 *   buyingAssetCode: "EURC",
 *   buyingAssetIssuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
 *   amount: "0",
 *   price: "1",
 *   offerId: "12345",
 * });
 */
export async function buildManageOfferTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: ManageOfferParams,
  trustedIssuers?: string[] | null,
): Promise<SorokitResult<string>> {
  // ── Resolve assets ────────────────────────────────────────────────────────
  const sellingResult = resolveAsset(
    params.sellingAssetCode,
    params.sellingAssetIssuer,
  );
  if (sellingResult.status === "error") return sellingResult;

  const buyingResult = resolveAsset(
    params.buyingAssetCode,
    params.buyingAssetIssuer,
  );
  if (buyingResult.status === "error") return buyingResult;

  // ── Selling and buying must differ ────────────────────────────────────────
  if (sellingResult.data.equals(buyingResult.data)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Selling and buying assets must be different.",
    );
  }

  // ── Issuer whitelist ──────────────────────────────────────────────────────
  if (
    trustedIssuers !== null &&
    trustedIssuers !== undefined &&
    trustedIssuers.length > 0
  ) {
    try {
      if (
        params.sellingAssetCode &&
        params.sellingAssetCode.toUpperCase() !== "XLM" &&
        params.sellingAssetIssuer
      ) {
        validateIssuer(params.sellingAssetIssuer, trustedIssuers);
      }
      if (
        params.buyingAssetCode &&
        params.buyingAssetCode.toUpperCase() !== "XLM" &&
        params.buyingAssetIssuer
      ) {
        validateIssuer(params.buyingAssetIssuer, trustedIssuers);
      }
    } catch (cause: unknown) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        (cause as Error)?.message || String(cause),
        cause,
      );
    }
  }

  // ── Validate amount, offerId, price ───────────────────────────────────────
  const amountResult = validateOfferAmount(params.amount);
  if (amountResult.status === "error") return amountResult;

  const offerId = params.offerId ?? "0";
  const offerIdResult = validateOfferId(offerId);
  if (offerIdResult.status === "error") return offerIdResult;

  // Cancellation requires a non-zero offer ID
  if (parseFloat(params.amount) === 0 && offerId === "0") {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      'Cannot cancel an offer without a non-zero offerId. Provide the ID of the offer to cancel and set amount to "0".',
    );
  }

  const priceResult = validateOfferPrice(params.price);
  if (priceResult.status === "error") return priceResult;

  // ── Memo ──────────────────────────────────────────────────────────────────
  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

  // ── Build transaction ─────────────────────────────────────────────────────
  try {
    const useCache = params.autoFetchSequence === true;
    let sourceAccount:
      | Account
      | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        const server = new Horizon.Server(horizonUrl);
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      const server = new Horizon.Server(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.manageSellOffer({
          selling: sellingResult.data,
          buying: buyingResult.data,
          amount: params.amount,
          price: params.price,
          offerId,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();

    if (useCache) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("manage offer", cause),
      cause,
    );
  }
}

// ─── Clawback ─────────────────────────────────────────────────────────────────

/**
 * Validate the asset code for a clawback operation.
 * Must be 1–12 alphanumeric characters (non-native assets only).
 */
function validateClawbackAssetCode(code: string): SorokitResult<void> {
  if (typeof code !== "string" || code.trim() === "") {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Asset code is required for a clawback operation.",
    );
  }
  if (code.toUpperCase() === "XLM") {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Clawback is not supported for the native XLM asset.",
    );
  }
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Asset code must be 1–12 alphanumeric characters, got: "${code}".`,
    );
  }
  return ok(undefined);
}

/**
 * Validate an amount for clawback.
 * Must be a positive decimal string with at most 7 decimal places.
 */
function validateClawbackAmount(amount: string): SorokitResult<void> {
  if (typeof amount !== "string" || amount.trim() === "") {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Clawback amount is required.",
    );
  }

  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Clawback amount must be a positive number, got: "${amount}".`,
    );
  }

  const decimalMatch = amount.match(/^(\d+)\.?(\d*)$/);
  if (!decimalMatch) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Clawback amount has an invalid format: "${amount}". Expected a positive decimal number.`,
    );
  }

  const decimalPlaces = decimalMatch[2]?.length ?? 0;
  if (decimalPlaces > 7) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Clawback amount exceeds maximum precision of 7 decimal places: "${amount}".`,
    );
  }

  return ok(undefined);
}

/**
 * Build an unsigned clawback transaction XDR.
 *
 * The clawback operation removes a specified amount of an issued asset from a
 * holder's account and returns it to the issuer. The transaction source account
 * must be the asset issuer, and the asset must have clawback enabled.
 *
 * Clawback is used for regulatory compliance (e.g. freezing funds on a
 * sanctioned address) or error recovery (e.g. recalling mis-sent tokens).
 *
 * @param horizonUrl      - Base URL of the Horizon server.
 * @param networkConfig   - Resolved network configuration (passphrase, URLs).
 * @param sourcePublicKey - G-address of the issuer account (must match `assetIssuer`).
 * @param params          - Clawback parameters: assetCode, assetIssuer, from, amount.
 * @returns `ok(xdr)` — unsigned transaction XDR ready for signing,
 *          or `error(TX_BUILD_FAILED)` on any validation or build error.
 *
 * @example
 * const result = await buildClawbackTransaction(horizonUrl, networkConfig, issuer, {
 *   assetCode: "USDC",
 *   assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
 *   from: "GUSER...",
 *   amount: "1000",
 * });
 * if (result.status === "ok") {
 *   const signed = await signTransaction(adapter, { transactionXdr: result.data, networkPassphrase });
 * }
 */
export async function buildClawbackTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: ClawbackParams,
): Promise<SorokitResult<string>> {
  // ── Validate asset code ───────────────────────────────────────────────────
  const assetCodeResult = validateClawbackAssetCode(params.assetCode);
  if (assetCodeResult.status === "error") return assetCodeResult;

  // ── Validate asset issuer address ─────────────────────────────────────────
  if (!params.assetIssuer || !isValidPublicKey(params.assetIssuer)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Asset issuer must be a valid Stellar G-address, got: "${params.assetIssuer ?? ""}".`,
    );
  }

  // ── Source must be the asset issuer ───────────────────────────────────────
  if (sourcePublicKey !== params.assetIssuer) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "The transaction source account must be the asset issuer to perform a clawback.",
    );
  }

  // ── Validate from address ─────────────────────────────────────────────────
  if (!params.from || !isValidPublicKey(params.from)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `"from" must be a valid Stellar G-address, got: "${params.from ?? ""}".`,
    );
  }

  // ── Validate amount ───────────────────────────────────────────────────────
  const amountResult = validateClawbackAmount(params.amount);
  if (amountResult.status === "error") return amountResult;

  // ── Memo ──────────────────────────────────────────────────────────────────
  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

  // ── Build transaction ─────────────────────────────────────────────────────
  try {
    const useCache = params.autoFetchSequence === true;
    let sourceAccount:
      | Account
      | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        const server = new Horizon.Server(horizonUrl);
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      const server = new Horizon.Server(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const asset = new Asset(params.assetCode, params.assetIssuer);

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.clawback({
          asset,
          from: params.from,
          amount: params.amount,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();

    if (useCache) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("clawback", cause),
      cause,
    );
  }
}

// ─── Liquidity Pool ───────────────────────────────────────────────────────────

/** 64 lowercase hex characters — the pool ID format Stellar uses. */
const POOL_ID_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Validate a liquidity pool ID.
 * Must be a 64-character hex string.
 */
function validatePoolId(poolId: string): SorokitResult<void> {
  if (typeof poolId !== "string" || poolId.trim() === "") {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "liquidityPoolId is required.",
    );
  }
  if (!POOL_ID_PATTERN.test(poolId)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `liquidityPoolId must be a 64-character hex string, got: "${poolId}".`,
    );
  }
  return ok(undefined);
}

/**
 * Validate a positive decimal amount with at most 7 decimal places.
 * Used for pool amounts and share counts.
 */
function validatePoolAmount(label: string, amount: string): SorokitResult<void> {
  if (typeof amount !== "string" || amount.trim() === "") {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${label} is required.`,
    );
  }
  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${label} must be a positive number, got: "${amount}".`,
    );
  }
  const match = amount.match(/^(\d+)\.?(\d*)$/);
  if (!match) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${label} has an invalid format: "${amount}". Expected a positive decimal number.`,
    );
  }
  const decimals = match[2]?.length ?? 0;
  if (decimals > 7) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${label} exceeds maximum precision of 7 decimal places: "${amount}".`,
    );
  }
  return ok(undefined);
}

/**
 * Validate a price value used as a pool price bound.
 * String: positive decimal, ≤7 decimal places.
 * Rational { n, d }: both positive integers.
 */
function validatePoolPrice(
  label: string,
  price: string | { n: number; d: number },
): SorokitResult<void> {
  if (typeof price === "object") {
    if (!Number.isInteger(price.n) || !Number.isInteger(price.d)) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `${label} numerator and denominator must be integers.`,
      );
    }
    if (price.n <= 0 || price.d <= 0) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `${label} numerator and denominator must both be positive.`,
      );
    }
    return ok(undefined);
  }
  if (typeof price !== "string" || price.trim() === "") {
    return err(SorokitErrorCode.TX_BUILD_FAILED, `${label} is required.`);
  }
  const num = parseFloat(price);
  if (isNaN(num) || num <= 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${label} must be a positive number, got: "${price}".`,
    );
  }
  const match = price.match(/^(\d+)\.?(\d*)$/);
  if (!match) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${label} has an invalid format: "${price}". Expected a positive decimal number.`,
    );
  }
  const decimals = match[2]?.length ?? 0;
  if (decimals > 7) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `${label} exceeds maximum precision of 7 decimal places: "${price}".`,
    );
  }
  return ok(undefined);
}

/** Convert a price to a comparable float for bound checking. */
function priceToFloat(price: string | { n: number; d: number }): number {
  if (typeof price === "object") return price.n / price.d;
  return parseFloat(price);
}

/**
 * Build an unsigned liquidity pool deposit transaction XDR.
 *
 * Deposits asset A and asset B into the specified constant-product liquidity
 * pool. The actual amounts deposited are determined by the current pool ratio
 * and will not exceed `maxAmountA` / `maxAmountB`. The operation fails on-chain
 * if the pool's current price falls outside the [`minPrice`, `maxPrice`] range.
 *
 * @param horizonUrl      - Base URL of the Horizon server.
 * @param networkConfig   - Resolved network configuration (passphrase, URLs).
 * @param sourcePublicKey - G-address of the account making the deposit.
 * @param params          - Deposit parameters: pool ID, max amounts, price bounds.
 * @returns `ok(xdr)` — unsigned transaction XDR ready for signing,
 *          or `error(TX_BUILD_FAILED)` on any validation or build error.
 *
 * @example
 * const result = await buildLiquidityPoolDepositTransaction(horizonUrl, networkConfig, lp, {
 *   liquidityPoolId: "abc123...64hexchars",
 *   maxAmountA: "1000",
 *   maxAmountB: "500",
 *   minPrice: "0.4",
 *   maxPrice: "0.6",
 * });
 */
export async function buildLiquidityPoolDepositTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: LiquidityPoolDepositParams,
): Promise<SorokitResult<string>> {
  // ── Pool ID ───────────────────────────────────────────────────────────────
  const poolIdResult = validatePoolId(params.liquidityPoolId);
  if (poolIdResult.status === "error") return poolIdResult;

  // ── Amounts ───────────────────────────────────────────────────────────────
  const maxAResult = validatePoolAmount("maxAmountA", params.maxAmountA);
  if (maxAResult.status === "error") return maxAResult;

  const maxBResult = validatePoolAmount("maxAmountB", params.maxAmountB);
  if (maxBResult.status === "error") return maxBResult;

  // ── Price bounds ──────────────────────────────────────────────────────────
  const minPriceResult = validatePoolPrice("minPrice", params.minPrice);
  if (minPriceResult.status === "error") return minPriceResult;

  const maxPriceResult = validatePoolPrice("maxPrice", params.maxPrice);
  if (maxPriceResult.status === "error") return maxPriceResult;

  if (priceToFloat(params.minPrice) >= priceToFloat(params.maxPrice)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "minPrice must be less than maxPrice.",
    );
  }

  // ── Memo ──────────────────────────────────────────────────────────────────
  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

  // ── Build transaction ─────────────────────────────────────────────────────
  try {
    const useCache = params.autoFetchSequence === true;
    let sourceAccount:
      | Account
      | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        const server = new Horizon.Server(horizonUrl);
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      const server = new Horizon.Server(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.liquidityPoolDeposit({
          liquidityPoolId: params.liquidityPoolId,
          maxAmountA: params.maxAmountA,
          maxAmountB: params.maxAmountB,
          minPrice: params.minPrice,
          maxPrice: params.maxPrice,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();

    if (useCache) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("liquidity pool deposit", cause),
      cause,
    );
  }
}

/**
 * Build an unsigned liquidity pool withdraw transaction XDR.
 *
 * Redeems a specified number of pool shares from the given liquidity pool.
 * The operation fails on-chain if the amounts received for asset A or asset B
 * fall below `minAmountA` / `minAmountB`.
 *
 * @param horizonUrl      - Base URL of the Horizon server.
 * @param networkConfig   - Resolved network configuration (passphrase, URLs).
 * @param sourcePublicKey - G-address of the account performing the withdrawal.
 * @param params          - Withdraw parameters: pool ID, shares amount, min amounts.
 * @returns `ok(xdr)` — unsigned transaction XDR ready for signing,
 *          or `error(TX_BUILD_FAILED)` on any validation or build error.
 *
 * @example
 * const result = await buildLiquidityPoolWithdrawTransaction(horizonUrl, networkConfig, lp, {
 *   liquidityPoolId: "abc123...64hexchars",
 *   amount: "100",
 *   minAmountA: "400",
 *   minAmountB: "200",
 * });
 */
export async function buildLiquidityPoolWithdrawTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: LiquidityPoolWithdrawParams,
): Promise<SorokitResult<string>> {
  // ── Pool ID ───────────────────────────────────────────────────────────────
  const poolIdResult = validatePoolId(params.liquidityPoolId);
  if (poolIdResult.status === "error") return poolIdResult;

  // ── Shares amount ─────────────────────────────────────────────────────────
  const sharesResult = validatePoolAmount("amount", params.amount);
  if (sharesResult.status === "error") return sharesResult;

  // ── Min receive amounts ───────────────────────────────────────────────────
  const minAResult = validatePoolAmount("minAmountA", params.minAmountA);
  if (minAResult.status === "error") return minAResult;

  const minBResult = validatePoolAmount("minAmountB", params.minAmountB);
  if (minBResult.status === "error") return minBResult;

  // ── Memo ──────────────────────────────────────────────────────────────────
  const memoResult = validateMemoParams(params);
  if (memoResult.status === "error") return memoResult;

  // ── Build transaction ─────────────────────────────────────────────────────
  try {
    const useCache = params.autoFetchSequence === true;
    let sourceAccount:
      | Account
      | Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

    if (useCache) {
      const cached = getSequenceCacheEntry(sourcePublicKey);
      if (cached) {
        sourceAccount = cached;
      } else {
        const server = new Horizon.Server(horizonUrl);
        sourceAccount = await server.loadAccount(sourcePublicKey);
      }
    } else {
      const server = new Horizon.Server(horizonUrl);
      sourceAccount = await server.loadAccount(sourcePublicKey);
    }

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        Operation.liquidityPoolWithdraw({
          liquidityPoolId: params.liquidityPoolId,
          amount: params.amount,
          minAmountA: params.minAmountA,
          minAmountB: params.minAmountB,
        }),
      )
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();

    if (useCache) {
      updateSequenceCache(sourcePublicKey, sourceAccount.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeTransactionBuildFailure("liquidity pool withdraw", cause),
      cause,
    );
  }
}
