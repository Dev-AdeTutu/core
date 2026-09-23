import { Horizon } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";
import type {
  GetOperationsOptions,
  OperationInfo,
  OperationsPage,
} from "./types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

/**
 * Map a raw Horizon operation record to the normalised {@link OperationInfo} shape.
 */
function toOperationInfo(record: Record<string, unknown>): OperationInfo {
  return {
    id: String(record["id"] ?? ""),
    pagingToken: String(record["paging_token"] ?? ""),
    sourceAccount: String(record["source_account"] ?? ""),
    type: record["type"] as OperationInfo["type"],
    createdAt: String(record["created_at"] ?? ""),
    transactionHash: String(record["transaction_hash"] ?? ""),
    transactionSuccessful: Boolean(record["transaction_successful"] ?? true),
    raw: record,
  };
}

/**
 * Fetch a page of operations for a Stellar account from Horizon.
 *
 * Supports filtering by operation type, source account, and date range
 * (all applied client-side after the Horizon response). Pagination is
 * cursor-based: pass `options.cursor` with the `pagingToken` of the last
 * record from a previous page to retrieve the next page.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param publicKey  - Stellar G-address of the account whose operations to fetch.
 * @param options    - Filtering, pagination, and ordering options.
 * @returns `ok(OperationsPage)` on success, or an error SorokitResult on failure.
 *
 * @example
 * // First page of payment operations, newest first
 * const result = await getOperations(horizonUrl, publicKey, {
 *   type: "payment",
 *   limit: 50,
 * });
 * if (result.status === "ok") {
 *   result.data.operations.forEach(op => console.log(op.type, op.id));
 *   // Resume with: { cursor: result.data.nextCursor }
 * }
 */
export async function getOperations(
  horizonUrl: string,
  publicKey: string,
  options: GetOperationsOptions = {},
): Promise<SorokitResult<OperationsPage>> {
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const order = options.order ?? "desc";

  try {
    const server = new Horizon.Server(horizonUrl);

    let builder = server
      .operations()
      .forAccount(publicKey)
      .limit(limit)
      .order(order);

    if (options.cursor) {
      builder = builder.cursor(options.cursor);
    }

    if (options.includeFailed === true) {
      builder = builder.includeFailed(true);
    }

    const page = await builder.call();

    // Map all records to OperationInfo
    let operations: OperationInfo[] = (
      page.records as unknown as Record<string, unknown>[]
    ).map(toOperationInfo);

    // ── Client-side filters ────────────────────────────────────────────────

    if (options.type !== undefined) {
      const filterType = options.type;
      operations = operations.filter((op) => op.type === filterType);
    }

    if (options.sourceAccount !== undefined) {
      const filterSource = options.sourceAccount;
      operations = operations.filter(
        (op) => op.sourceAccount === filterSource,
      );
    }

    if (options.after !== undefined) {
      const afterMs = new Date(options.after).getTime();
      operations = operations.filter(
        (op) => new Date(op.createdAt).getTime() >= afterMs,
      );
    }

    if (options.before !== undefined) {
      const beforeMs = new Date(options.before).getTime();
      operations = operations.filter(
        (op) => new Date(op.createdAt).getTime() < beforeMs,
      );
    }

    const nextCursor =
      operations.length > 0
        ? (operations[operations.length - 1]?.pagingToken ?? null)
        : null;

    return ok({ operations, nextCursor } satisfies OperationsPage);
  } catch (cause) {
    return err(
      isNotFoundError(cause)
        ? SorokitErrorCode.ACCOUNT_NOT_FOUND
        : SorokitErrorCode.ACCOUNT_FETCH_FAILED,
      isNotFoundError(cause)
        ? `Account not found: ${publicKey}`
        : `Failed to fetch operations for ${publicKey}: ${toMessage(cause)}`,
      cause,
    );
  }
}
