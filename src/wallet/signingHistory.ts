import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface SigningRecord {
  txHash: string;
  signer: string;
  timestamp: string;
  status: "success" | "failure";
  error?: string;
}

export interface SigningHistoryFilter {
  signer?: string;
  status?: "success" | "failure";
  /** ISO-8601 lower bound (inclusive) */
  from?: string;
  /** ISO-8601 upper bound (inclusive) */
  to?: string;
}

export interface SigningHistoryStore {
  record(entry: SigningRecord): void;
  query(filter?: SigningHistoryFilter): SigningRecord[];
  clear(): void;
}

export class InMemorySigningHistoryStore implements SigningHistoryStore {
  private entries: SigningRecord[] = [];

  record(entry: SigningRecord): void {
    this.entries.push({ ...entry });
  }

  query(filter?: SigningHistoryFilter): SigningRecord[] {
    let results = [...this.entries];
    if (filter?.signer !== undefined) {
      const { signer } = filter;
      results = results.filter((r) => r.signer === signer);
    }
    if (filter?.status !== undefined) {
      const { status } = filter;
      results = results.filter((r) => r.status === status);
    }
    if (filter?.from !== undefined) {
      const { from } = filter;
      results = results.filter((r) => r.timestamp >= from);
    }
    if (filter?.to !== undefined) {
      const { to } = filter;
      results = results.filter((r) => r.timestamp <= to);
    }
    return results;
  }

  clear(): void {
    this.entries = [];
  }
}

/**
 * Query the signing history from a store, optionally filtered.
 *
 * @param store - The signing history store to query.
 * @param filter - Optional filter criteria.
 * @returns All matching signing records.
 *
 * @example
 * const store = new InMemorySigningHistoryStore();
 * const result = getSigningHistory(store, { status: "failure" });
 * if (result.status === "ok") console.log(result.data);
 */
export function getSigningHistory(
  store: SigningHistoryStore,
  filter?: SigningHistoryFilter,
): SorokitResult<SigningRecord[]> {
  return ok(store.query(filter));
}

/**
 * Export signing history records as JSON or CSV with optional filtering.
 *
 * @param store - The signing history store to query.
 * @param format - Output format: `"json"` or `"csv"`.
 * @param filter - Optional filter criteria (date range, signer, status).
 * @returns Formatted string with filtered records.
 *
 * @example
 * const exported = exportSigningHistory(store, "csv", { status: "failure" });
 */
export function exportSigningHistory(
  store: SigningHistoryStore,
  format: "json" | "csv",
  filter?: SigningHistoryFilter,
): SorokitResult<string> {
  const records = store.query(filter);
  
  if (format === "json") {
    return ok(JSON.stringify(records, null, 2));
  }
  
  const header = "txHash,signer,timestamp,status,error";
  const rows = records.map((r) =>
    [r.txHash, r.signer, r.timestamp, r.status, r.error ?? ""].join(","),
  );
  return ok([header, ...rows].join("\n"));
}
