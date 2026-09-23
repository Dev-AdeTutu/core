import type { TransactionResult } from "./types";

/**
 * Statistical analytics computed from transaction fee history.
 */
export interface FeeHistoryAnalytics {
  /** Minimum fee observed in the window (stroops) */
  min: string;
  /** Maximum fee observed in the window (stroops) */
  max: string;
  /** Average fee in the window (stroops) */
  avg: string;
  /** Median fee in the window (stroops) */
  median: string;
  /** Standard deviation of fees (stroops) */
  stddev: string;
  /** 25th percentile (Q1) */
  p25: string;
  /** 50th percentile (median, same as above) */
  p50: string;
  /** 75th percentile (Q3) */
  p75: string;
  /** 90th percentile */
  p90: string;
  /** 95th percentile */
  p95: string;
  /** 99th percentile */
  p99: string;
  /** Number of transactions analyzed */
  sampleSize: number;
}

/**
 * Analyze transaction fee history and compute statistical metrics.
 *
 * Computes min, max, average, median, standard deviation, and percentiles
 * (p25, p50, p75, p90, p95, p99) from a set of recent transactions. Useful
 * for determining whether the current fee is high or low relative to history.
 *
 * @param recentTransactions - Array of recent TransactionResult objects
 * @param windowSize         - Maximum number of transactions to analyze (default: all)
 * @returns Statistical analytics or null if insufficient data
 *
 * @example
 * const analytics = analyzeFeeHistory(transactions, 50);
 * if (analytics && Number(currentFee) > Number(analytics.p90)) {
 *   console.warn("Current fee is in the 90th percentile (high)");
 * }
 */
export function analyzeFeeHistory(
  recentTransactions: TransactionResult[],
  windowSize?: number,
): FeeHistoryAnalytics | null {
  const window = windowSize
    ? recentTransactions.slice(0, windowSize)
    : recentTransactions;

  if (window.length === 0) return null;

  // Extract numeric fees
  const fees = window
    .map((tx) => Number(tx.fee))
    .filter((f) => Number.isFinite(f) && f >= 0)
    .sort((a, b) => a - b);

  // Basic stats. The explicit undefined checks (rather than non-null
  // assertions) keep the empty-window case honest under
  // noUncheckedIndexedAccess.
  const min = fees[0];
  const max = fees[fees.length - 1];
  if (min === undefined || max === undefined) return null;

  const sum = fees.reduce((acc, f) => acc + f, 0);
  const avg = sum / fees.length;

  // Median (fees is sorted and non-empty here)
  const medianIndex = Math.floor(fees.length / 2);
  const upper = fees[medianIndex] ?? min;
  const lower = fees[medianIndex - 1] ?? upper;
  const median = fees.length % 2 === 0 ? (lower + upper) / 2 : upper;

  // Standard deviation
  const variance =
    fees.reduce((acc, f) => acc + Math.pow(f - avg, 2), 0) / fees.length;
  const stddev = Math.sqrt(variance);

  // Percentile helper
  const percentile = (p: number): string => {
    const index = Math.min(
      Math.floor((p / 100) * fees.length),
      fees.length - 1,
    );
    return Math.floor(fees[index]!).toString();
  };

  return {
    min: Math.floor(min).toString(),
    max: Math.floor(max).toString(),
    avg: Math.floor(avg).toString(),
    median: Math.floor(median).toString(),
    stddev: Math.floor(stddev).toString(),
    p25: percentile(25),
    p50: percentile(50),
    p75: percentile(75),
    p90: percentile(90),
    p95: percentile(95),
    p99: percentile(99),
    sampleSize: fees.length,
  };
}
