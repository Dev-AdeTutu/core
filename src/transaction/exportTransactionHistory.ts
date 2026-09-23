import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isNotFoundError, toMessage } from "../shared";
import { createHorizonServer } from "../shared/serverFactory";

export type ExportFormat = "csv" | "json" | "CSV" | "JSON";

export interface ExportedTransaction {
  hash: string;
  date: string;
  ledger: number;
  status: "success" | "failed";
  type: string;
  sourceAccount: string;
  destination: string;
  asset: string;
  amount: string;
  fee: string;
  memo: string;
  costBasis?: string;
  proceeds?: string;
  gainLoss?: string;
}

export interface CostBasisLot {
  asset: string;
  quantity: number | string;
  unitCost: number | string;
}

export interface CostBasisOptions {
  /** Static unit price by asset code or CODE:ISSUER. */
  unitCostByAsset?: Record<string, number | string>;
  /** FIFO lots used before falling back to unitCostByAsset. */
  lots?: CostBasisLot[];
  /** Static proceeds unit price by asset code or CODE:ISSUER. */
  proceedsUnitByAsset?: Record<string, number | string>;
  /** Decimal places for exported derived values. Default: 7. */
  precision?: number;
}

export interface ExportTransactionHistoryOptions {
  /** Format to export: "csv" or "json". Default: "csv". */
  format?: ExportFormat;
  /** Start date / after date filter (ISO string or Date). */
  fromDate?: string | Date;
  /** Alias for fromDate. */
  startDate?: string | Date;
  /** Alias for fromDate. */
  afterDate?: string | Date;
  /** End date / before date filter (ISO string or Date). */
  toDate?: string | Date;
  /** Alias for toDate. */
  endDate?: string | Date;
  /** Alias for toDate. */
  beforeDate?: string | Date;
  /** Filter by operation type (e.g. "payment", "create_account", "change_trust", etc.). */
  type?: string | string[];
  /** Alias for type. */
  types?: string[];
  /** Filter by asset (code, "XLM", "native", or "CODE:ISSUER"). */
  asset?: string | string[];
  /** Alias for asset. */
  assets?: string[];
  /** Minimum operation amount. */
  minAmount?: number | string;
  /** Maximum operation amount. */
  maxAmount?: number | string;
  /** Amount range filter object. */
  amountRange?: {
    min?: number | string;
    max?: number | string;
  };
  /** Optional status filter: "success" | "failed". */
  status?: "success" | "failed";
  /** Maximum number of exported records to return. */
  limit?: number;
  /** Horizon fetch order: "asc" | "desc". Default: "desc". */
  order?: "asc" | "desc";
  /** Network passphrase for parsing envelope XDR. */
  networkPassphrase?: string;
  /** Optional cost-basis settings for taxable history exports. */
  costBasis?: CostBasisOptions;
}

export const FALLBACK_PASSPHRASE = "Test SDF Network ; September 2015";
export const HORIZON_PAGE_LIMIT = 200;

export function parseTimestamp(value: string | Date | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const ts = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ts) ? ts : undefined;
}

export function normalizeTypeString(val: string): string {
  return val.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function escapeCsvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const str = String(value);
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Format an array of ExportedTransaction objects as an RFC 4180 compliant CSV string.
 */
export function formatTransactionsToCsv(transactions: ExportedTransaction[]): string {
  const includeCostBasis = transactions.some(
    (tx) => tx.costBasis !== undefined || tx.proceeds !== undefined || tx.gainLoss !== undefined,
  );
  const headers = [
    "Hash",
    "Date",
    "Ledger",
    "Status",
    "Type",
    "Source",
    "Destination",
    "Asset",
    "Amount",
    "Fee",
    "Memo",
  ];
  if (includeCostBasis) {
    headers.push("Cost Basis", "Proceeds", "Gain/Loss");
  }
  const lines: string[] = [headers.join(",")];

  for (const tx of transactions) {
    const row = [
      escapeCsvField(tx.hash),
      escapeCsvField(tx.date),
      escapeCsvField(tx.ledger),
      escapeCsvField(tx.status),
      escapeCsvField(tx.type),
      escapeCsvField(tx.sourceAccount),
      escapeCsvField(tx.destination),
      escapeCsvField(tx.asset),
      escapeCsvField(tx.amount),
      escapeCsvField(tx.fee),
      escapeCsvField(tx.memo),
    ];
    if (includeCostBasis) {
      row.push(
        escapeCsvField(tx.costBasis),
        escapeCsvField(tx.proceeds),
        escapeCsvField(tx.gainLoss),
      );
    }
    lines.push(row.join(","));
  }

  return lines.join("\r\n");
}

/**
 * Format an array of ExportedTransaction objects as a formatted JSON string.
 */
export function formatTransactionsToJson(transactions: ExportedTransaction[]): string {
  return JSON.stringify(transactions, null, 2);
}

interface ExtractedOperation {
  type: string;
  sourceAccount: string;
  destination: string;
  asset: string;
  amount: string;
}

function normalizeAssetKey(asset: string): string {
  return asset === "native" ? "XLM" : asset.toUpperCase();
}

function lookupAssetNumber(
  values: Record<string, number | string> | undefined,
  asset: string,
): number | undefined {
  if (!values) return undefined;
  const exact = values[normalizeAssetKey(asset)];
  const code = values[normalizeAssetKey(asset.split(":")[0] ?? asset)];
  const resolved = exact ?? code;
  if (resolved === undefined) return undefined;
  const parsed = Number(resolved);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function consumeLots(
  lots: CostBasisLot[] | undefined,
  asset: string,
  quantity: number,
): number | undefined {
  if (!lots || quantity <= 0) return undefined;
  let remaining = quantity;
  let basis = 0;

  for (const lot of lots) {
    if (normalizeAssetKey(lot.asset) !== normalizeAssetKey(asset)) continue;
    const lotQuantity = Number(lot.quantity);
    const lotUnitCost = Number(lot.unitCost);
    if (!Number.isFinite(lotQuantity) || !Number.isFinite(lotUnitCost) || lotQuantity <= 0) {
      continue;
    }
    const used = Math.min(remaining, lotQuantity);
    basis += used * lotUnitCost;
    remaining -= used;
    if (remaining <= 0) break;
  }

  return remaining < quantity ? basis : undefined;
}

function applyCostBasis(
  tx: ExportedTransaction,
  options: CostBasisOptions | undefined,
): ExportedTransaction {
  if (!options) return tx;

  const quantity = Number(tx.amount);
  if (!Number.isFinite(quantity)) return tx;

  const precision = options.precision ?? 7;
  const absQuantity = Math.abs(quantity);
  const unitCost = lookupAssetNumber(options.unitCostByAsset, tx.asset);
  const lotBasis = consumeLots(options.lots, tx.asset, absQuantity);
  const costBasis = lotBasis ?? (unitCost !== undefined ? absQuantity * unitCost : undefined);
  const proceedsUnit = lookupAssetNumber(options.proceedsUnitByAsset, tx.asset);
  const proceeds = proceedsUnit !== undefined ? absQuantity * proceedsUnit : undefined;
  const gainLoss =
    costBasis !== undefined && proceeds !== undefined ? proceeds - costBasis : undefined;

  return {
    ...tx,
    ...(costBasis !== undefined ? { costBasis: costBasis.toFixed(precision) } : {}),
    ...(proceeds !== undefined ? { proceeds: proceeds.toFixed(precision) } : {}),
    ...(gainLoss !== undefined ? { gainLoss: gainLoss.toFixed(precision) } : {}),
  };
}

export function formatAssetString(assetObj: any): string {
  if (!assetObj) return "XLM";
  if (typeof assetObj.isNative === "function" && assetObj.isNative()) {
    return "XLM";
  }
  if (assetObj.code && assetObj.issuer) {
    return `${assetObj.code}:${assetObj.issuer}`;
  }
  if (assetObj.code) {
    return assetObj.code;
  }
  return "XLM";
}

export function extractOperationsFromXdr(
  envelopeXdr: string,
  txSourceAccount: string,
  passphrase?: string,
): ExtractedOperation[] {
  try {
    const parsed = TransactionBuilder.fromXDR(
      envelopeXdr,
      passphrase || FALLBACK_PASSPHRASE,
    );
    const transaction: Transaction =
      "innerTransaction" in parsed
        ? (parsed as FeeBumpTransaction).innerTransaction as Transaction
        : (parsed as Transaction);

    if (!transaction.operations || transaction.operations.length === 0) {
      return [
        {
          type: "transaction",
          sourceAccount: txSourceAccount,
          destination: "",
          asset: "XLM",
          amount: "0",
        },
      ];
    }

    return transaction.operations.map((op: any) => {
      const type = op.type || "unknown";
      const sourceAccount = op.source || txSourceAccount;
      let destination = "";
      if (typeof op.destination === "string") {
        destination = op.destination;
      } else if (typeof op.into === "string") {
        destination = op.into;
      } else if (op.line && typeof op.line.issuer === "string") {
        destination = op.line.issuer;
      }

      let asset = "XLM";
      if (op.asset) {
        asset = formatAssetString(op.asset);
      } else if (op.sendAsset) {
        asset = formatAssetString(op.sendAsset);
      } else if (op.destAsset) {
        asset = formatAssetString(op.destAsset);
      } else if (op.line) {
        asset = formatAssetString(op.line);
      } else if (op.buying) {
        asset = formatAssetString(op.buying);
      }

      let amount = "0";
      if (op.amount !== undefined && op.amount !== null) {
        amount = String(op.amount);
      } else if (op.startingBalance !== undefined && op.startingBalance !== null) {
        amount = String(op.startingBalance);
      } else if (op.sendAmount !== undefined && op.sendAmount !== null) {
        amount = String(op.sendAmount);
      } else if (op.destAmount !== undefined && op.destAmount !== null) {
        amount = String(op.destAmount);
      } else if (op.limit !== undefined && op.limit !== null) {
        amount = String(op.limit);
      }

      return {
        type,
        sourceAccount,
        destination,
        asset,
        amount,
      };
    });
  } catch {
    return [
      {
        type: "transaction",
        sourceAccount: txSourceAccount,
        destination: "",
        asset: "XLM",
        amount: "0",
      },
    ];
  }
}

/**
 * Export transaction history for a Stellar account with filtering and format options.
 *
 * Supports filtering by date range, operation type, asset, and amount range.
 * Exports results as RFC 4180 compliant CSV or formatted JSON.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param publicKey  - Stellar G-address of the account.
 * @param options    - Export options including format, filters, limit, and order.
 * @returns `ok(string)` containing formatted CSV or JSON data, or `err(SorokitError)`.
 */
export async function exportTransactionHistory(
  horizonUrl: string,
  publicKey: string,
  options?: ExportTransactionHistoryOptions,
): Promise<SorokitResult<string>> {
  const format = (options?.format ?? "csv").toLowerCase() as "csv" | "json";
  const order = options?.order ?? "desc";
  const limit = options?.limit;
  const passphrase = options?.networkPassphrase;

  // Resolve Date filters
  const fromTimestamp =
    parseTimestamp(options?.fromDate) ??
    parseTimestamp(options?.startDate) ??
    parseTimestamp(options?.afterDate);
  const toTimestamp =
    parseTimestamp(options?.toDate) ??
    parseTimestamp(options?.endDate) ??
    parseTimestamp(options?.beforeDate);

  // Resolve Type filters
  const rawTypes = [
    ...(options?.type ? (Array.isArray(options.type) ? options.type : [options.type]) : []),
    ...(options?.types ? options.types : []),
  ];
  const typeFilterSet =
    rawTypes.length > 0 ? new Set(rawTypes.map(normalizeTypeString)) : null;

  // Resolve Asset filters
  const rawAssets = [
    ...(options?.asset ? (Array.isArray(options.asset) ? options.asset : [options.asset]) : []),
    ...(options?.assets ? options.assets : []),
  ];
  const assetFilterSet =
    rawAssets.length > 0
      ? new Set(
          rawAssets.map((a) => (a === "native" ? "XLM" : a.toUpperCase())),
        )
      : null;

  // Resolve Amount Range filters
  const minAmountVal = options?.minAmount ?? options?.amountRange?.min;
  const maxAmountVal = options?.maxAmount ?? options?.amountRange?.max;
  const minAmount = minAmountVal !== undefined ? Number(minAmountVal) : undefined;
  const maxAmount = maxAmountVal !== undefined ? Number(maxAmountVal) : undefined;

  // Resolve Status filter
  const statusFilter = options?.status;

  const exportedTransactions: ExportedTransaction[] = [];

  try {
    const server = createHorizonServer(horizonUrl);
    let cursor: string | undefined;
    let keepFetching = true;

    while (keepFetching) {
      let builder = server
        .transactions()
        .forAccount(publicKey)
        .limit(HORIZON_PAGE_LIMIT)
        .order(order);

      if (cursor !== undefined) {
        builder = builder.cursor(cursor);
      }

      const page = await builder.call();

      if (!page.records || page.records.length === 0) {
        break;
      }

      for (const tx of page.records) {
        const createdAt = tx.created_at;
        const txTimestamp = createdAt ? Date.parse(createdAt) : undefined;

        // Date range checks
        if (txTimestamp !== undefined && Number.isFinite(txTimestamp)) {
          if (fromTimestamp !== undefined && txTimestamp < fromTimestamp) {
            if (order === "desc") {
              // Out of range (older than fromTimestamp in desc order) — stop fetching
              keepFetching = false;
              break;
            } else {
              // In asc order, skip this record if before fromTimestamp
              continue;
            }
          }
          if (toTimestamp !== undefined && txTimestamp > toTimestamp) {
            if (order === "asc") {
              // Out of range (newer than toTimestamp in asc order) — stop fetching
              keepFetching = false;
              break;
            } else {
              // In desc order, skip this record if after toTimestamp
              continue;
            }
          }
        }

        const status: "success" | "failed" = tx.successful ? "success" : "failed";
        if (statusFilter !== undefined && status !== statusFilter) {
          continue;
        }

        const operations = extractOperationsFromXdr(
          tx.envelope_xdr,
          tx.source_account,
          passphrase,
        );

        for (const op of operations) {
          // Type filter check
          if (typeFilterSet !== null) {
            const normOpType = normalizeTypeString(op.type);
            if (!typeFilterSet.has(normOpType)) {
              continue;
            }
          }

          // Asset filter check
          if (assetFilterSet !== null) {
            const opAssetUpper = op.asset.toUpperCase();
            const opAssetCodeUpper = op.asset.split(":")[0]?.toUpperCase() || opAssetUpper;
            let match = assetFilterSet.has(opAssetUpper) || assetFilterSet.has(opAssetCodeUpper);
            if (!match && (opAssetUpper === "XLM" || opAssetUpper === "NATIVE")) {
              match = assetFilterSet.has("XLM") || assetFilterSet.has("NATIVE");
            }
            if (!match) {
              continue;
            }
          }

          // Amount range check
          const numAmount = parseFloat(op.amount);
          if (Number.isFinite(numAmount)) {
            if (minAmount !== undefined && numAmount < minAmount) {
              continue;
            }
            if (maxAmount !== undefined && numAmount > maxAmount) {
              continue;
            }
          }

          exportedTransactions.push(applyCostBasis({
            hash: tx.hash,
            date: createdAt || "",
            ledger: tx.ledger_attr,
            status,
            type: op.type,
            sourceAccount: op.sourceAccount,
            destination: op.destination,
            asset: op.asset,
            amount: op.amount,
            fee: String(tx.fee_charged),
            memo: tx.memo || "",
          }, options?.costBasis));

          if (limit !== undefined && exportedTransactions.length >= limit) {
            keepFetching = false;
            break;
          }
        }

        if (!keepFetching) break;
      }

      const lastRecord = page.records[page.records.length - 1];
      if (!lastRecord || !lastRecord.paging_token || page.records.length < HORIZON_PAGE_LIMIT) {
        break;
      }
      cursor = lastRecord.paging_token;
    }

    if (format === "json") {
      return ok(formatTransactionsToJson(exportedTransactions));
    } else {
      return ok(formatTransactionsToCsv(exportedTransactions));
    }
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return err(
        SorokitErrorCode.ACCOUNT_NOT_FOUND,
        `Account not found while exporting transactions: ${publicKey}`,
        cause,
      );
    }
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      `Failed to export transaction history: ${toMessage(cause)}`,
      cause,
    );
  }
}
