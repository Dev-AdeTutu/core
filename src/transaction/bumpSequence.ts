/**
 * Bump Sequence operation (#554).
 *
 * `buildBumpSequenceTransaction()` builds an unsigned `BumpSequence` transaction
 * XDR that bumps the source account's sequence number forward, preventing old
 * transactions from being replayed and enabling gap management.
 *
 * Validation:
 * - `bumpToSequence` must be a stringified non-negative integer,
 * - be at most `2^64 - 1` (uint64 max), and
 * - be greater than the source account's current sequence number.
 *
 * Every public function returns a `SorokitResult` and never throws.
 */

import { Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import type { ResolvedNetworkConfig } from "../shared/types";
import {
  resolveFee,
  resolveMemo,
  resolveSourceAccount,
  updateSequenceCache,
} from "./buildHelpers";
import type { BumpSequenceParams } from "./types";

const UINT64_MAX = 18_446_744_073_709_551_615n;
const UINT64_PATTERN = /^\d+$/;

/**
 * Validate that a bump sequence target is a stringified integer within the
 * uint64 range. The "greater than current sequence" check is performed by the
 * transaction builder once the source account is resolved.
 */
export function validateBumpSequenceValue(
  bumpToSequence: string,
): SorokitResult<void> {
  if (
    typeof bumpToSequence !== "string" ||
    !UINT64_PATTERN.test(bumpToSequence)
  ) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid bump sequence "${String(
        bumpToSequence,
      )}": must be a stringified non-negative integer.`,
    );
  }
  try {
    if (BigInt(bumpToSequence) > UINT64_MAX) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Invalid bump sequence "${bumpToSequence}": exceeds the uint64 maximum (${UINT64_MAX.toString()}).`,
      );
    }
  } catch {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid bump sequence "${String(
        bumpToSequence,
      )}": must be a stringified non-negative integer.`,
    );
  }
  return ok(undefined);
}

/**
 * Build the `BumpSequence` XDR operation for the given target sequence.
 *
 * @returns `ok(xdr.Operation)` or `error(TX_BUILD_FAILED)`.
 */
export function buildBumpSequenceOperation(
  bumpToSequence: string,
): SorokitResult<ReturnType<typeof Operation.bumpSequence>> {
  const validation = validateBumpSequenceValue(bumpToSequence);
  if (validation.status === "error") return validation;

  try {
    return ok(Operation.bumpSequence({ bumpTo: bumpToSequence }));
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build bump sequence operation: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Build an unsigned `BumpSequence` transaction XDR.
 *
 * Validates that `bumpToSequence` is a stringified uint64 greater than the
 * source account's current sequence before serialising.
 *
 * @param horizonUrl       - Base URL of the Horizon server (used to load the
 *   current sequence unless `sequenceNumber` is provided).
 * @param networkConfig    - Resolved network configuration.
 * @param sourcePublicKey  - G-address of the account whose sequence is bumped.
 * @param params           - Target sequence and optional memo / offline config.
 * @returns `ok(xdr)` — unsigned transaction XDR, or `error(TX_BUILD_FAILED)`.
 *
 * @example
 * const result = await buildBumpSequenceTransaction(horizonUrl, networkConfig, account, {
 *   bumpToSequence: "1000",
 * });
 */
export async function buildBumpSequenceTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  params: BumpSequenceParams,
): Promise<SorokitResult<string>> {
  const valueResult = validateBumpSequenceValue(params.bumpToSequence);
  if (valueResult.status === "error") return valueResult;

  const memoResult = resolveMemo(params);
  if (memoResult.status === "error") return memoResult;

  const sourceResult = await resolveSourceAccount(
    horizonUrl,
    sourcePublicKey,
    params.sequenceNumber,
    params.autoFetchSequence,
  );
  if (sourceResult.status === "error") return sourceResult;
  const sourceAccount = sourceResult.data;
  const fee = resolveFee(params.estimatedFee);

  const currentSequence = sourceAccount.sequenceNumber();
  try {
    if (BigInt(params.bumpToSequence) <= BigInt(currentSequence)) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Invalid bump sequence "${params.bumpToSequence}": must be greater than the source account's current sequence (${currentSequence}).`,
      );
    }
  } catch {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Invalid bump sequence "${String(
        params.bumpToSequence,
      )}": must be a stringified non-negative integer.`,
    );
  }

  try {
    const builder = new TransactionBuilder(sourceAccount, {
      fee,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: params.bumpToSequence }))
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
      `Failed to build bump sequence transaction: ${toMessage(cause)}`,
      cause,
    );
  }
}