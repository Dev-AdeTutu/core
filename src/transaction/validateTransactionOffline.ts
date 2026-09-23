 import { TransactionBuilder, StrKey, Memo } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";

// ─── Constants ────────────────────────────────────────────────────────────────

const FALLBACK_PARSE_PASSPHRASE = "Test SDF Network ; September 2015";
const DEFAULT_MIN_FEE_STROOPS = 100;
const DEFAULT_MAX_FEE_STROOPS = 100_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OfflineValidationIssue {
  field: string;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface OfflineValidationReport {
  valid: boolean;
  issues: OfflineValidationIssue[];
  operationCount: number;
  fee: string | null;
  networkPassphrase: string;
  hasSignatures: boolean;
  signatureCount: number;
}

export interface OfflineValidationOptions {
  /**
   * Expected network passphrase. Used to decode the XDR.
   * If omitted, a fallback testnet passphrase is used for parsing only —
   * the actual passphrase from parsing is returned in the report.
   */
  networkPassphrase?: string;
  /** Minimum acceptable fee in stroops. Default: 100. */
  minFee?: number;
  /** Maximum acceptable fee in stroops. Default: 100_000. */
  maxFee?: number;
  /** If true, require at least one signature to be present. Default: false. */
  requireSignatures?: boolean;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Validate a transaction XDR entirely offline.
 *
 * Performs structural validation without any network calls:
 * - Parses the XDR envelope
 * - Checks fee sanity (min/max bounds)
 * - Validates operation structure (destinations, amounts)
 * - Checks for the presence of signatures
 *
 * @param xdr     - The transaction envelope XDR string to validate.
 * @param options - Optional validation rules (fee bounds, passphrase, etc.).
 * @returns `ok(OfflineValidationReport)` with findings,
 *          or `error(TX_BUILD_FAILED)` if the XDR cannot be parsed.
 *
 * @example
 * const result = validateTransactionOffline(xdr);
 * if (result.status === "ok") {
 *   console.log(result.data.valid); // true if no errors
 *   console.log(result.data.issues); // detailed findings
 * }
 *
 * @example
 * // With custom options
 * const result = validateTransactionOffline(xdr, {
 *   networkPassphrase: "Public Global Stellar Network ; September 2015",
 *   minFee: 1000,
 *   requireSignatures: true,
 * });
 */
export function validateTransactionOffline(
  xdr: string,
  options?: OfflineValidationOptions,
): SorokitResult<OfflineValidationReport> {
  // ── Validate input type ─────────────────────────────────────────────────────
  if (typeof xdr !== "string" || xdr.trim().length === 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Transaction XDR must be a non-empty string.",
    );
  }

  // ── Parse XDR ───────────────────────────────────────────────────────────────
  const parsePassphrase = options?.networkPassphrase ?? FALLBACK_PARSE_PASSPHRASE;

  let transaction: Transaction;
  let detectedPassphrase: string;

  try {
    const parsed = TransactionBuilder.fromXDR(xdr.trim(), parsePassphrase);
    // Handle fee-bump transactions by unwrapping to inner
    if (isFeeBump(parsed)) {
      transaction = parsed.innerTransaction as Transaction;
      detectedPassphrase = (parsed as any).networkPassphrase ?? parsePassphrase;
    } else {
      transaction = parsed as Transaction;
      detectedPassphrase = (parsed as any).networkPassphrase ?? parsePassphrase;
    }
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to parse transaction XDR: ${toMessage(cause)}`,
      cause,
    );
  }

  const issues: OfflineValidationIssue[] = [];

  // ── Network passphrase consistency ──────────────────────────────────────────
  if (options?.networkPassphrase !== undefined && detectedPassphrase !== options.networkPassphrase) {
    issues.push({
      field: "networkPassphrase",
      message: `XDR was built for "${detectedPassphrase}" but expected "${options.networkPassphrase}"`,
      severity: "warning",
    });
  }

  // ── Fee sanity ──────────────────────────────────────────────────────────────
  const feeStroops = Number(transaction.fee);
  const minFee = options?.minFee ?? DEFAULT_MIN_FEE_STROOPS;
  const maxFee = options?.maxFee ?? DEFAULT_MAX_FEE_STROOPS;

  if (isNaN(feeStroops) || feeStroops < minFee) {
    issues.push({
      field: "fee",
      message: `Fee ${transaction.fee} stroops is below the minimum of ${minFee} stroops`,
      severity: "error",
    });
  } else if (feeStroops > maxFee) {
    issues.push({
      field: "fee",
      message: `Fee ${transaction.fee} stroops exceeds the sanity limit of ${maxFee} stroops`,
      severity: "warning",
    });
  }

  // ── Operation count ─────────────────────────────────────────────────────────
  const operations = transaction.operations;
  if (operations.length === 0) {
    issues.push({
      field: "operations",
      message: "Transaction contains no operations",
      severity: "error",
    });
  }

  // ── Per-operation structure validation ──────────────────────────────────────
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!op) continue;

    // Receiver validation — applies to payment, createAccount, pathPayment, etc.
    if ("destination" in op && typeof op.destination === "string") {
      if (!StrKey.isValidEd25519PublicKey(op.destination)) {
        issues.push({
          field: `operations[${i}].destination`,
          message: `Invalid destination public key: "${op.destination}"`,
          severity: "error",
        });
      }
    }

    // Amount must be positive for payment operations
    if ("amount" in op && typeof op.amount === "string") {
      const amountFloat = parseFloat(op.amount);
      if (isNaN(amountFloat) || amountFloat <= 0) {
        issues.push({
          field: `operations[${i}].amount`,
          message: `Amount must be positive, got: "${op.amount}"`,
          severity: "error",
        });
      }
    }

    // Starting balance for createAccount operations
    if ("startingBalance" in op && typeof op.startingBalance === "string") {
      const balanceFloat = parseFloat(op.startingBalance);
      if (isNaN(balanceFloat) || balanceFloat <= 0) {
        issues.push({
          field: `operations[${i}].startingBalance`,
          message: `Starting balance must be positive, got: "${op.startingBalance}"`,
          severity: "error",
        });
      }
    }
  }

  // ── Signature check ─────────────────────────────────────────────────────────
  const signatureCount = (transaction.signatures ?? []).length;
  const hasSignatures = signatureCount > 0;

  if (options?.requireSignatures && !hasSignatures) {
    issues.push({
      field: "signatures",
      message: "Transaction has no signatures but requireSignatures is enabled",
      severity: "error",
    });
  }

  if (signatureCount > 0) {
    issues.push({
      field: "signatures",
      message: `Transaction has ${signatureCount} signature(s) attached`,
      severity: "info",
    });
  }

  // ── Memo validation (structural only) ───────────────────────────────────────
  if (transaction.memo && transaction.memo.type !== Memo.none().type) {
    issues.push({
      field: "memo",
      message: `Transaction includes a ${transaction.memo.type} memo`,
      severity: "info",
    });
  }

  // ── Time bounds check ───────────────────────────────────────────────────────
  const timeBounds = (transaction as any).timeBounds;
  if (timeBounds) {
    const now = Math.floor(Date.now() / 1000);
    if (timeBounds.maxTime > 0 && now > timeBounds.maxTime) {
      issues.push({
        field: "timeBounds",
        message: `Transaction time bounds have expired (maxTime: ${timeBounds.maxTime}, current: ${now})`,
        severity: "error",
      });
    }
  }

  // ── Compile report ──────────────────────────────────────────────────────────
  const hasErrors = issues.some((issue) => issue.severity === "error");

  return ok({
    valid: !hasErrors,
    issues,
    operationCount: operations.length,
    fee: String(transaction.fee),
    networkPassphrase: detectedPassphrase,
    hasSignatures,
    signatureCount,
  });
}

/**
 * Type guard to detect fee-bump transactions.
 */
function isFeeBump(tx: unknown): tx is { innerTransaction: Transaction } {
  return (
    tx !== null &&
    typeof tx === "object" &&
    "innerTransaction" in tx
  );
}

