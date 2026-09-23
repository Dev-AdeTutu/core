/**
 * Claimable balance operations (#543).
 *
 * Builders for the `CreateClaimableBalance` and `ClaimClaimableBalance`
 * Stellar operations:
 *
 * - `buildCreateClaimableBalanceOperation()` — builds just the XDR operation.
 * - `buildClaimClaimableBalanceOperation()` — builds just the XDR operation.
 * - `buildCreateClaimableBalance()` — builds a full unsigned transaction XDR.
 * - `buildClaimClaimableBalance()` — builds a full unsigned transaction XDR.
 *
 * All predicate types are supported: unconditional, absolute/relative time
 * predicates, and `and` / `or` / `not` compositions. Amount precision,
 * claimant address (Stellar or muxed), balance ID, and predicate time bounds
 * are validated before anything is returned. Every public function returns a
 * `SorokitResult` and never throws.
 */

import {
  Claimant,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import {
  resolveAssetInput,
  resolveFee,
  resolveMemo,
  resolveSourceAccount,
  updateSequenceCache,
} from "./buildHelpers";
import { validateIssuer } from "../shared/validateIssuer";
import type {
  ClaimClaimableBalanceParams,
  ClaimPredicateInput,
  CreateClaimableBalanceParams,
} from "./types";

const UINT64_MAX = 18_446_744_073_709_551_615n;
/** 8-byte discriminant + 32-byte hash, hex encoded. */
const CLAIMABLE_BALANCE_ID_PATTERN = /^[0-9a-fA-F]{72}$/;
/** Positive decimal, at most 7 decimal places. */
const AMOUNT_PATTERN = /^\d+(\.\d{1,7})?$/;

function describeBuildFailure(action: string, cause: unknown): string {
  return `Failed to build ${action}: ${toMessage(cause)}`;
}

/**
 * Validate a claimable balance amount: positive and at most 7 decimal places.
 */
export function validateClaimableAmount(
  amount: string,
): SorokitResult<void> {
  if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid claimable balance amount: "${String(
        amount,
      )}" must be a positive decimal with at most 7 decimal places.`,
    );
  }
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid claimable balance amount: "${String(
        amount,
      )}" must be greater than zero.`,
    );
  }
  return ok(undefined);
}

/**
 * Validate a claimant address: Stellar (G...) or muxed (M...) and normalize it.
 *
 * Muxed addresses are decoded to their underlying ed25519 account key because
 * claimable balance claimants are stored as `AccountID` in the protocol.
 *
 * @returns `ok(G-address)` or `error(TX_BUILD_FAILED)`.
 */
export function validateClaimantAddress(
  claimant: string,
): SorokitResult<string> {
  if (typeof claimant !== "string" || claimant.length === 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Claimable balance requires a claimant address.",
    );
  }
  if (StrKey.isValidEd25519PublicKey(claimant)) {
    return ok(claimant);
  }
  if (StrKey.isValidMed25519PublicKey(claimant)) {
    try {
      const decoded = StrKey.decodeMed25519PublicKey(claimant);
      const ed25519 = decoded.subarray(0, 32);
      return ok(StrKey.encodeEd25519PublicKey(ed25519));
    } catch (cause) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Invalid muxed claimant address: "${String(claimant)}".`,
        cause,
      );
    }
  }
  return err(
    SorokitErrorCode.TX_BUILD_FAILED,
    `Invalid claimant address: "${String(
      claimant,
    )}" must be a valid Stellar (G...) or muxed (M...) address.`,
  );
}

/**
 * Validate a claimable balance ID: `0x00000000` discriminant followed by a
 * 32-byte hash, hex encoded (72 hexadecimal characters).
 */
export function validateClaimableBalanceId(
  balanceId: string,
): SorokitResult<void> {
  if (
    typeof balanceId !== "string" ||
    !CLAIMABLE_BALANCE_ID_PATTERN.test(balanceId)
  ) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid claimable balance id "${String(
        balanceId,
      )}": must be a claimable balance id (72 hexadecimal characters: 8-byte discriminant + 32-byte hash).`,
    );
  }
  return ok(undefined);
}

function normalizePredicateTime(
  value: string | number | undefined,
  label: string,
): SorokitResult<string> {
  if (value === undefined || value === null) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Claim predicate "${label}" requires a time value.`,
    );
  }
  const str = String(value);
  if (!/^\d+$/.test(str)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Claim predicate "${label}" time "${str}" must be a non-negative integer (seconds).`,
    );
  }
  try {
    if (BigInt(str) > UINT64_MAX) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Claim predicate "${label}" time "${str}" exceeds the uint64 maximum.`,
      );
    }
  } catch {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Claim predicate "${label}" time "${str}" must be a non-negative integer (seconds).`,
    );
  }
  return ok(str);
}

/**
 * Convert a `ClaimPredicateInput` into the SDK's `xdr.ClaimPredicate`.
 *
 * The protocol no longer exposes dedicated `after` variants in this SDK, so
 * after-time predicates are expressed as `not(before-absolute/relative)`, which
 * has equivalent semantics.
 */
function toClaimPredicate(
  predicate: ClaimPredicateInput,
): SorokitResult<xdr.ClaimPredicate> {
  switch (predicate.type) {
    case "unconditional":
      return ok(Claimant.predicateUnconditional());

    case "beforeAbsoluteTime": {
      const time = normalizePredicateTime(
        predicate.timestamp,
        "beforeAbsoluteTime",
      );
      if (time.status === "error") return time;
      return ok(Claimant.predicateBeforeAbsoluteTime(time.data));
    }

    case "afterAbsoluteTime": {
      const time = normalizePredicateTime(
        predicate.timestamp,
        "afterAbsoluteTime",
      );
      if (time.status === "error") return time;
      return ok(
        Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(time.data)),
      );
    }

    case "beforeRelativeTime": {
      const seconds = normalizePredicateTime(
        predicate.seconds,
        "beforeRelativeTime",
      );
      if (seconds.status === "error") return seconds;
      return ok(Claimant.predicateBeforeRelativeTime(seconds.data));
    }

    case "afterRelativeTime": {
      const seconds = normalizePredicateTime(
        predicate.seconds,
        "afterRelativeTime",
      );
      if (seconds.status === "error") return seconds;
      return ok(
        Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(seconds.data)),
      );
    }

    case "and": {
      if (
        !Array.isArray(predicate.predicates) ||
        predicate.predicates.length < 2
      ) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          'Claim predicate "and" requires at least two child predicates.',
        );
      }
      let acc: xdr.ClaimPredicate | null = null;
      for (const child of predicate.predicates) {
        const childResult = toClaimPredicate(child);
        if (childResult.status === "error") return childResult;
        acc = acc ? Claimant.predicateAnd(acc, childResult.data) : childResult.data;
      }
      return ok(acc as xdr.ClaimPredicate);
    }

    case "or": {
      if (
        !Array.isArray(predicate.predicates) ||
        predicate.predicates.length < 2
      ) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          'Claim predicate "or" requires at least two child predicates.',
        );
      }
      let acc: xdr.ClaimPredicate | null = null;
      for (const child of predicate.predicates) {
        const childResult = toClaimPredicate(child);
        if (childResult.status === "error") return childResult;
        acc = acc ? Claimant.predicateOr(acc, childResult.data) : childResult.data;
      }
      return ok(acc as xdr.ClaimPredicate);
    }

    case "not": {
      if (!predicate.predicate) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          'Claim predicate "not" requires a single child predicate.',
        );
      }
      const childResult = toClaimPredicate(predicate.predicate);
      if (childResult.status === "error") return childResult;
      return ok(Claimant.predicateNot(childResult.data));
    }

    default:
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Unsupported claim predicate type: "${
          (predicate as { type: string }).type
        }".`,
      );
  }
}

function isAfterBound(predicate: ClaimPredicateInput): boolean {
  return (
    predicate.type === "afterAbsoluteTime" ||
    predicate.type === "afterRelativeTime"
  );
}

function isBeforeBound(predicate: ClaimPredicateInput): boolean {
  return (
    predicate.type === "beforeAbsoluteTime" ||
    predicate.type === "beforeRelativeTime"
  );
}

/**
 * Collect the widest time window implied by a compound predicate.
 * Returns `{ start?, end? }` where `start` is the latest after-bound and `end`
 * is the earliest before-bound among the direct children.
 */
function collectTimeWindow(
  children: ClaimPredicateInput[],
): { start?: bigint; end?: bigint } {
  let start: bigint | undefined;
  let end: bigint | undefined;

  for (const child of children) {
    if (isAfterBound(child)) {
      const raw = child.timestamp ?? child.seconds;
      if (raw === undefined) continue;
      const value = BigInt(String(raw));
      if (start === undefined || value > start) start = value;
    }
    if (isBeforeBound(child)) {
      const raw = child.timestamp ?? child.seconds;
      if (raw === undefined) continue;
      const value = BigInt(String(raw));
      if (end === undefined || value < end) end = value;
    }
  }

  return {
    ...(start !== undefined && { start }),
    ...(end !== undefined && { end }),
  };
}

/**
 * Validate predicate structure and time bounds (end > start) recursively.
 */
export function validateClaimPredicate(
  predicate: ClaimPredicateInput,
): SorokitResult<void> {
  if (!predicate || typeof predicate !== "object") {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "A claim predicate is required.",
    );
  }

  switch (predicate.type) {
    case "unconditional":
      return ok(undefined);

    case "beforeAbsoluteTime":
    case "afterAbsoluteTime": {
      const time = normalizePredicateTime(
        predicate.timestamp,
        predicate.type,
      );
      return time.status === "error" ? time : ok(undefined);
    }

    case "beforeRelativeTime":
    case "afterRelativeTime": {
      const seconds = normalizePredicateTime(predicate.seconds, predicate.type);
      return seconds.status === "error" ? seconds : ok(undefined);
    }

    case "and":
    case "or": {
      if (
        !Array.isArray(predicate.predicates) ||
        predicate.predicates.length < 2
      ) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          `Claim predicate "${predicate.type}" requires at least two child predicates.`,
        );
      }
      for (const child of predicate.predicates) {
        const childResult = validateClaimPredicate(child);
        if (childResult.status === "error") return childResult;
      }

      const { start, end } = collectTimeWindow(predicate.predicates);
      if (start !== undefined && end !== undefined && end <= start) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          `Invalid claim predicate time bounds in "${predicate.type}": end must be greater than start.`,
        );
      }
      return ok(undefined);
    }

    case "not": {
      if (!predicate.predicate) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          'Claim predicate "not" requires a single child predicate.',
        );
      }
      return validateClaimPredicate(predicate.predicate);
    }

    default:
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Unsupported claim predicate type: "${
          (predicate as { type: string }).type
        }".`,
      );
  }
}

/**
 * Validate full `CreateClaimableBalanceParams`: amount precision, claimant
 * address, predicate structure, and predicate time bounds.
 */
export function validateCreateClaimableBalanceParams(
  params: CreateClaimableBalanceParams,
): SorokitResult<void> {
  const amountResult = validateClaimableAmount(params.amount);
  if (amountResult.status === "error") return amountResult;

  const claimantResult = validateClaimantAddress(params.claimant);
  if (claimantResult.status === "error") return claimantResult;

  if (!params.predicate) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "A claim predicate is required.",
    );
  }
  return validateClaimPredicate(params.predicate);
}

/**
 * Build the `CreateClaimableBalance` XDR operation for the given parameters.
 *
 * @returns `ok(xdr.Operation)` or `error(TX_BUILD_FAILED)`.
 */
export function buildCreateClaimableBalanceOperation(
  params: CreateClaimableBalanceParams,
): SorokitResult<xdr.Operation> {
  const validation = validateCreateClaimableBalanceParams(params);
  if (validation.status === "error") return validation;

  const claimantResult = validateClaimantAddress(params.claimant);
  if (claimantResult.status === "error") return claimantResult;

  const predicateResult = toClaimPredicate(params.predicate);
  if (predicateResult.status === "error") return predicateResult;

  const assetResult = resolveAssetInput(
    params.asset,
    params.assetCode,
    params.assetIssuer,
  );
  if (assetResult.status === "error") return assetResult;

  try {
    const operation = Operation.createClaimableBalance({
      asset: assetResult.data,
      amount: params.amount,
      claimants: [new Claimant(claimantResult.data, predicateResult.data)],
    });
    return ok(operation);
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeBuildFailure("create claimable balance operation", cause),
      cause,
    );
  }
}

/**
 * Build the `ClaimClaimableBalance` XDR operation for the given balance ID.
 *
 * @returns `ok(xdr.Operation)` or `error(TX_BUILD_FAILED)`.
 */
export function buildClaimClaimableBalanceOperation(
  balanceId: string,
): SorokitResult<xdr.Operation> {
  const validation = validateClaimableBalanceId(balanceId);
  if (validation.status === "error") return validation;

  try {
    return ok(Operation.claimClaimableBalance({ balanceId }));
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeBuildFailure("claim claimable balance operation", cause),
      cause,
    );
  }
}

/**
 * Build an unsigned `CreateClaimableBalance` transaction XDR.
 *
 * Maximum XLM reserve for a claimable balance is observed, but no network
 * round-trips are performed beyond loading the source account sequence (unless
 * `sequenceNumber` is provided, in which case the build is fully offline).
 *
 * @param horizonUrl       - Base URL of the Horizon server.
 * @param networkConfig    - Resolved network configuration.
 * @param sourcePublicKey  - G-address of the account creating the balance.
 * @param params           - Asset, amount, claimant, predicate, optional memo.
 * @param trustedIssuers   - Optional whitelist of trusted issuer G-addresses.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error(TX_BUILD_FAILED)`.
 *
 * @example
 * const result = await buildCreateClaimableBalance(horizonUrl, networkConfig, issuer, {
 *   asset: usdcAsset(),
 *   amount: "1000",
 *   claimant: "GCLAIMANT...",
 *   predicate: { type: "unconditional" },
 * });
 */
export async function buildCreateClaimableBalance(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: CreateClaimableBalanceParams,
  trustedIssuers?: string[] | null,
): Promise<SorokitResult<string>> {
  // Validate issuer against whitelist when configured and asset is non-native.
  if (
    trustedIssuers !== null &&
    trustedIssuers !== undefined &&
    trustedIssuers.length > 0
  ) {
    const assetCode =
      params.asset?.getCode() ?? params.assetCode ?? "XLM";
    const assetIssuer = params.asset?.getIssuer() ?? params.assetIssuer;
    if (assetCode.toUpperCase() !== "XLM" && assetIssuer) {
      try {
        validateIssuer(assetIssuer, trustedIssuers);
      } catch (cause: unknown) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          (cause as Error)?.message || String(cause),
          cause,
        );
      }
    }
  }

  const operationResult = buildCreateClaimableBalanceOperation(params);
  if (operationResult.status === "error") return operationResult;

  const memoResult = resolveMemo(params);
  if (memoResult.status === "error") return memoResult;

  const sourceResult = await resolveSourceAccount(
    horizonUrl,
    sourcePublicKey,
    params.sequenceNumber,
    params.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const fee = resolveFee(params.estimatedFee);

  try {
    const builder = new TransactionBuilder(sourceResult.data, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(operationResult.data)
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();
    if (params.autoFetchSequence === true && params.sequenceNumber === undefined) {
      updateSequenceCache(sourcePublicKey, sourceResult.data.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeBuildFailure("create claimable balance transaction", cause),
      cause,
    );
  }
}

/**
 * Build an unsigned `ClaimClaimableBalance` transaction XDR.
 *
 * @param horizonUrl       - Base URL of the Horizon server.
 * @param networkConfig    - Resolved network configuration.
 * @param sourcePublicKey  - G-address of the account claiming the balance.
 * @param params           - Claimable balance ID and optional memo.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error(TX_BUILD_FAILED)`.
 *
 * @example
 * const result = await buildClaimClaimableBalance(horizonUrl, networkConfig, claimant, {
 *   balanceId: "000000007f18e80...",
 * });
 */
export async function buildClaimClaimableBalance(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: ClaimClaimableBalanceParams,
): Promise<SorokitResult<string>> {
  const operationResult = buildClaimClaimableBalanceOperation(
    params.balanceId,
  );
  if (operationResult.status === "error") return operationResult;

  const memoResult = resolveMemo(params);
  if (memoResult.status === "error") return memoResult;

  const sourceResult = await resolveSourceAccount(
    horizonUrl,
    sourcePublicKey,
    params.sequenceNumber,
    params.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const fee = resolveFee(params.estimatedFee);

  try {
    const builder = new TransactionBuilder(sourceResult.data, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(operationResult.data)
      .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    if (memoResult.data) {
      builder.addMemo(memoResult.data);
    }

    const tx = builder.build();
    if (params.autoFetchSequence === true && params.sequenceNumber === undefined) {
      updateSequenceCache(sourcePublicKey, sourceResult.data.sequenceNumber());
    }

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      describeBuildFailure("claim claimable balance transaction", cause),
      cause,
    );
  }
}