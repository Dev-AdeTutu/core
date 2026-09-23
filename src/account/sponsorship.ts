import { Operation, xdr } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isValidPublicKey } from "../shared/utils";

/**
 * Result of building account sponsorship operations.
 */
export interface SponsorshipResult {
  /** Target account address */
  account: string;
  /** Sponsor address (if set) */
  sponsor?: string;
  /** Sequence of Stellar operations required for sponsorship */
  operations: xdr.Operation[];
  /** Signer public keys required to sign the transaction containing these operations */
  requiredSigners: string[];
}

/**
 * Build sponsorship operations to set a sponsor for an account.
 *
 * Sponsoring requires two operations executed in sequence:
 * 1. `beginSponsoringFutureReserves` signed by the `sponsor`
 * 2. `endSponsoringFutureReserves` signed by the `account`
 *
 * @param account - Stellar G-address of the account to be sponsored.
 * @param sponsor - Stellar G-address of the account paying for reserves.
 * @returns `ok(SponsorshipResult)` on success, or an `error` SorokitResult on failure.
 *
 * @example
 * const result = setSponsor("GACCOUNT...", "GSPONSOR...");
 * if (result.status === "ok") {
 *   console.log(result.data.operations);
 * }
 */
export function setSponsor(
  account: string,
  sponsor: string,
): SorokitResult<SponsorshipResult> {
  if (!account || !isValidPublicKey(account)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid account address: ${account}`,
    );
  }

  if (!sponsor || !isValidPublicKey(sponsor)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid sponsor address: ${sponsor}`,
    );
  }

  if (account === sponsor) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Account and sponsor cannot be the same address",
    );
  }

  try {
    const beginOp = Operation.beginSponsoringFutureReserves({
      sponsoredId: account,
      source: sponsor,
    });

    const endOp = Operation.endSponsoringFutureReserves({
      source: account,
    });

    return ok({
      account,
      sponsor,
      operations: [beginOp, endOp],
      requiredSigners: [sponsor, account],
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build sponsorship operations: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/**
 * Build operations to remove sponsorship from an account.
 *
 * Revokes account sponsorship using `revokeAccountSponsorship`.
 *
 * @param account - Stellar G-address of the account to remove sponsorship from.
 * @returns `ok(SponsorshipResult)` on success, or an `error` SorokitResult on failure.
 *
 * @example
 * const result = removeSponsor("GACCOUNT...");
 * if (result.status === "ok") {
 *   console.log(result.data.operations);
 * }
 */
export function removeSponsor(
  account: string,
): SorokitResult<SponsorshipResult> {
  if (!account || !isValidPublicKey(account)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      `Invalid account address: ${account}`,
    );
  }

  try {
    const revokeOp = Operation.revokeAccountSponsorship({
      account,
      source: account,
    });

    return ok({
      account,
      operations: [revokeOp],
      requiredSigners: [account],
    });
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build remove sponsor operation: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}
