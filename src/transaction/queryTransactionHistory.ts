import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";
import { createHorizonServer } from "../shared/serverFactory";
import type { ExportedTransaction } from "./exportTransactionHistory";
import {
  parseTimestamp,
  normalizeTypeString,
  formatAssetString,
  extractOperationsFromXdr,
  HORIZON_PAGE_LIMIT,
  FALLBACK_PASSPHRASE,
} from "./exportTransactionHistory";

export type TransactionHistorySortField =
  | "date"
  | "ledger"
  | "type"
  | "amount"
  | "fee"
  | "status"
  | "destination"
  | "sourceAccount";

export interface TransactionHistorySort {
  by: TransactionHistorySortField;
  order: "asc" | "desc";
}

export interface TransactionHistoryQuery {
  type?: string | string[];
  fromDate?: string | Date;
  toDate?: string | Date;
  minAmount?: number | string;
  maxAmount?: number | string;
  status?: "success" | "failed";
  asset?: string | string[];
  sort?: TransactionHistorySort;
  page?: number;
  perPage?: number;
  networkPassphrase?: string;
}

export interface TransactionHistoryResult {
  transactions: ExportedTransaction[];
  page: number;
  perPage: number;
  total: number;
  hasMore: boolean;
  nextCursor?: string | null;
}

function sortTransactions(
  transactions: ExportedTransaction[],
  sort: TransactionHistorySort,
): ExportedTransaction[] {
  const { by, order } = sort;
  const multiplier = order === "asc" ? 1 : -1;

  return [...transactions].sort((a, b) => {
    switch (by) {
      case "date":
        return multiplier * (new Date(a.date).getTime() - new Date(b.date).getTime());
      case "ledger":
        return multiplier * (a.ledger - b.ledger);
      case "type":
        return multiplier * a.type.localeCompare(b.type);
      case "amount":
        return multiplier * (parseFloat(a.amount) - parseFloat(b.amount));
      case "fee":
        return multiplier * (parseFloat(a.fee) - parseFloat(b.fee));
      case "status": {
        const sa = a.status === "success" ? 1 : 0;
        const sb = b.status === "success" ? 1 : 0;
        return multiplier * (sa - sb);
      }
      case "destination":
        return multiplier * a.destination.localeCompare(b.destination);
      case "sourceAccount":
        return multiplier * a.sourceAccount.localeCompare(b.sourceAccount);
      default:
        return 0;
    }
  });
}

function matchesTypeFilter(
  opType: string,
  typeFilterSet: Set<string> | null,
): boolean {
  if (typeFilterSet === null) return true;
  return typeFilterSet.has(normalizeTypeString(opType));
}

function matchesAssetFilter(
  opAsset: string,
  assetFilterSet: Set<string> | null,
): boolean {
  if (assetFilterSet === null) return true;
  const opAssetUpper = opAsset.toUpperCase();
  const opAssetCodeUpper = opAsset.split(":")[0]?.toUpperCase() || opAssetUpper;
  let match = assetFilterSet.has(opAssetUpper) || assetFilterSet.has(opAssetCodeUpper);
  if (!match && (opAssetUpper === "XLM" || opAssetUpper === "NATIVE")) {
    match = assetFilterSet.has("XLM") || assetFilterSet.has("NATIVE");
  }
  return match;
}

function matchesAmountRange(
  opAmount: string,
  minAmount: number | undefined,
  maxAmount: number | undefined,
): boolean {
  const numAmount = parseFloat(opAmount);
  if (!Number.isFinite(numAmount)) return true;
  if (minAmount !== undefined && numAmount < minAmount) return false;
  if (maxAmount !== undefined && numAmount > maxAmount) return false;
  return true;
}

function matchesStatusFilter(
  txStatus: "success" | "failed",
  statusFilter: "success" | "failed" | undefined,
): boolean {
  if (statusFilter === undefined) return true;
  return txStatus === statusFilter;
}

function matchesDateRange(
  txTimestamp: number | undefined,
  fromTimestamp: number | undefined,
  toTimestamp: number | undefined,
): boolean {
  if (txTimestamp === undefined || !Number.isFinite(txTimestamp)) return false;
  if (fromTimestamp !== undefined && txTimestamp < fromTimestamp) return false;
  if (toTimestamp !== undefined && txTimestamp > toTimestamp) return false;
  return true;
}

export function resolveSort(
  sort?: TransactionHistorySort,
): TransactionHistorySort {
  if (sort) return sort;
  return { by: "date", order: "desc" };
}

export async function queryTransactionHistory(
  horizonUrl: string,
  publicKey: string,
  query?: TransactionHistoryQuery,
): Promise<SorokitResult<TransactionHistoryResult>> {
  const order = (query?.sort?.order ?? "desc") as "asc" | "desc";
  const horizonOrder = order;
  const perPage = Math.max(1, Math.min(200, query?.perPage ?? 20));
  const page = Math.max(1, query?.page ?? 1);
  const passphrase = query?.networkPassphrase;

  const fromTimestamp =
    parseTimestamp(query?.fromDate);
  const toTimestamp =
    parseTimestamp(query?.toDate);

  const rawTypes = query?.type
    ? (Array.isArray(query.type) ? query.type : [query.type])
    : [];
  const typeFilterSet =
    rawTypes.length > 0 ? new Set(rawTypes.map(normalizeTypeString)) : null;

  const rawAssets = query?.asset
    ? (Array.isArray(query.asset) ? query.asset : [query.asset])
    : [];
  const assetFilterSet =
    rawAssets.length > 0
      ? new Set(
          rawAssets.map((a) => (a === "native" ? "XLM" : a.toUpperCase())),
        )
      : null;

  const minAmount =
    query?.minAmount !== undefined ? Number(query.minAmount) : undefined;
  const maxAmount =
    query?.maxAmount !== undefined ? Number(query.maxAmount) : undefined;
  const statusFilter = query?.status;
  const sortConfig = resolveSort(query?.sort);

  const allTransactions: ExportedTransaction[] = [];

  try {
    const server = createHorizonServer(horizonUrl);
    let cursor: string | undefined;
    let keepFetching = true;
    let hasMoreRecords = false;

    const recordsNeeded = page * perPage;

    while (keepFetching && allTransactions.length < recordsNeeded) {
      let builder = server
        .transactions()
        .forAccount(publicKey)
        .limit(HORIZON_PAGE_LIMIT)
        .order(horizonOrder);

      if (cursor !== undefined) {
        builder = builder.cursor(cursor);
      }

      const horizonPage = await builder.call();

      if (!horizonPage.records || horizonPage.records.length === 0) {
        break;
      }

      const pageFull = horizonPage.records.length >= HORIZON_PAGE_LIMIT;
      let earlyExit = false;

      for (const tx of horizonPage.records) {
        if (allTransactions.length >= recordsNeeded) {
          keepFetching = false;
          hasMoreRecords = true;
          earlyExit = true;
          break;
        }

        const createdAt = tx.created_at;
        const txTimestamp = createdAt ? Date.parse(createdAt) : undefined;

        if (!matchesDateRange(txTimestamp, fromTimestamp, toTimestamp)) {
          continue;
        }

        const txStatus: "success" | "failed" = tx.successful
          ? "success"
          : "failed";
        if (!matchesStatusFilter(txStatus, statusFilter)) {
          continue;
        }

        const operations = extractOperationsFromXdr(
          tx.envelope_xdr,
          tx.source_account,
          passphrase,
        );

        for (const op of operations) {
          if (!matchesTypeFilter(op.type, typeFilterSet)) continue;
          if (!matchesAssetFilter(op.asset, assetFilterSet)) continue;
          if (!matchesAmountRange(op.amount, minAmount, maxAmount)) continue;

          allTransactions.push({
            hash: tx.hash,
            date: createdAt || "",
            ledger: tx.ledger_attr,
            status: txStatus,
            type: op.type,
            sourceAccount: op.sourceAccount,
            destination: op.destination,
            asset: op.asset,
            amount: op.amount,
            fee: String(tx.fee_charged),
            memo: tx.memo || "",
          });
        }
      }

      if (earlyExit) {
        const lastRecord = horizonPage.records[horizonPage.records.length - 1];
        cursor = lastRecord?.paging_token ?? cursor;
        break;
      }

      const lastRecord = horizonPage.records[horizonPage.records.length - 1];
      if (!lastRecord || !lastRecord.paging_token) {
        break;
      }
      if (!pageFull) {
        break;
      }
      hasMoreRecords = true;
      cursor = lastRecord.paging_token;
    }

    const sorted = sortTransactions(allTransactions, sortConfig);

    const total = sorted.length;
    const startIndex = (page - 1) * perPage;
    const pageTransactions = sorted.slice(startIndex, startIndex + perPage);
    const hasMore = startIndex + perPage < total || hasMoreRecords;

    const result: TransactionHistoryResult = {
      transactions: pageTransactions,
      page,
      perPage,
      total,
      hasMore,
      nextCursor: hasMore ? (cursor ?? null) : null,
    };

    return ok(result);
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return err(
        SorokitErrorCode.ACCOUNT_NOT_FOUND,
        `Account not found while querying transaction history: ${publicKey}`,
        cause,
      );
    }
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      `Failed to query transaction history: ${toMessage(cause)}`,
      cause,
    );
  }
}
