/**
 * Transaction anomaly detection and fraud alerting (#454).
 *
 * Analyzes historical transaction patterns to detect unusual amounts,
 * destinations, or frequency. Generates a normalised risk score (0–1) and
 * triggers alerts when behaviour deviates significantly from established
 * patterns.
 *
 * The engine is deterministic and configurable — it never blocks transactions,
 * only reports anomalies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TransactionRecord {
  /** Unique transaction identifier. */
  id: string;
  /** Destination address. */
  destination: string;
  /** Amount in the asset's smallest unit. */
  amount: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Asset code, e.g. "XLM", "USDC". */
  assetCode: string;
}

export interface AnomalyThresholds {
  /** Z-score threshold for amount anomalies (default: 3). */
  amountZScore?: number;
  /** Z-score threshold for frequency anomalies (default: 3). */
  frequencyZScore?: number;
  /** Minimum historical transactions before detection activates (default: 10). */
  minHistorySize?: number;
  /** Maximum age of historical records to consider in ms (default: 30 days). */
  historyWindowMs?: number;
}

export interface AnomalyResult {
  /** Normalised risk score between 0 (no risk) and 1 (maximum risk). */
  riskScore: number;
  /** Individual anomaly flags triggered. */
  anomalies: AnomalyFlag[];
  /** Human-readable summary. */
  summary: string;
}

export interface AnomalyFlag {
  type: "unusual_amount" | "unusual_destination" | "unusual_frequency";
  /** How many standard deviations from the mean. */
  zScore: number;
  /** Description of the anomaly. */
  description: string;
}

export interface AnomalyAlert {
  /** The transaction that triggered the alert. */
  transaction: TransactionRecord;
  /** Risk assessment result. */
  result: AnomalyResult;
  /** ISO-8601 timestamp of the alert. */
  alertedAt: string;
}

export type AnomalyAlertCallback = (alert: AnomalyAlert) => void;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function zScore(value: number, values: number[]): number {
  const sd = stdDev(values);
  if (sd === 0) return 0;
  return (value - mean(values)) / sd;
}

function countByDestination(records: TransactionRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of records) {
    counts.set(r.destination, (counts.get(r.destination) ?? 0) + 1);
  }
  return counts;
}

function bucketByHour(records: TransactionRecord[]): number[] {
  const buckets = new Array(24).fill(0);
  for (const r of records) {
    const hour = new Date(r.timestamp).getHours();
    buckets[hour]++;
  }
  return buckets;
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Analyse a new transaction against historical patterns and return a risk
 * assessment. The detection engine is pure — it does not persist state or
 * block transactions.
 *
 * @param historical - Previous transactions for the account (newest last).
 * @param incoming   - The transaction to evaluate.
 * @param thresholds - Configurable detection thresholds.
 */
export function detectAnomaly(
  historical: TransactionRecord[],
  incoming: TransactionRecord,
  thresholds: AnomalyThresholds = {},
): AnomalyResult {
  const {
    amountZScore: amountThreshold = 3,
    frequencyZScore: frequencyThreshold = 3,
    minHistorySize = 10,
    historyWindowMs = 30 * 24 * 60 * 60 * 1000,
  } = thresholds;

  const now = Date.now();
  const windowRecords = historical.filter(
    (r) => now - new Date(r.timestamp).getTime() <= historyWindowMs,
  );

  const anomalies: AnomalyFlag[] = [];

  // Not enough history — cannot detect anomalies
  if (windowRecords.length < minHistorySize) {
    return {
      riskScore: 0,
      anomalies: [],
      summary: "Insufficient history for anomaly detection",
    };
  }

  // 1. Amount anomaly
  const amounts = windowRecords.map((r) => r.amount);
  const amountZ = zScore(incoming.amount, amounts);
  if (Math.abs(amountZ) > amountThreshold) {
    anomalies.push({
      type: "unusual_amount",
      zScore: amountZ,
      description: `Amount ${incoming.amount} is ${Math.abs(amountZ).toFixed(1)} standard deviations from the mean`,
    });
  }

  // 2. Destination anomaly — is this a new/unusual destination?
  const destCounts = countByDestination(windowRecords);
  const totalTx = windowRecords.length;
  const destFrequency = (destCounts.get(incoming.destination) ?? 0) / totalTx;
  if (destFrequency < 0.01 && !destCounts.has(incoming.destination)) {
    anomalies.push({
      type: "unusual_destination",
      zScore: 0,
      description: `Destination ${incoming.destination} has no prior transaction history`,
    });
  }

  // 3. Frequency anomaly — compare hourly transaction rate
  const hourlyBuckets = bucketByHour(windowRecords);
  const currentHour = new Date(incoming.timestamp).getHours();
  const hourZ = zScore(
    (hourlyBuckets[currentHour] ?? 0) + 1,
    hourlyBuckets,
  );
  if (Math.abs(hourZ) > frequencyThreshold) {
    anomalies.push({
      type: "unusual_frequency",
      zScore: hourZ,
      description: `Transaction frequency at hour ${currentHour} is ${Math.abs(hourZ).toFixed(1)} standard deviations from the hourly average`,
    });
  }

  // Normalise risk score: 0–1 based on anomaly count and severity
  const maxZ = anomalies.reduce(
    (max, a) => Math.max(max, Math.abs(a.zScore)),
    0,
  );
  const riskScore = Math.min(
    1,
    (anomalies.length / 3) * 0.5 + (maxZ / 10) * 0.5,
  );

  const summary =
    anomalies.length === 0
      ? "No anomalies detected"
      : `${anomalies.length} anomal${anomalies.length === 1 ? "y" : "ies"} detected (risk: ${(riskScore * 100).toFixed(0)}%)`;

  return { riskScore, anomalies, summary };
}

/**
 * Create an anomaly detection engine with stateful alerting.
 *
 * Call `evaluate` for each incoming transaction. When the risk score exceeds
 * the configured threshold, the alert callback fires.
 */
export function createAnomalyDetector(
  alertThreshold: number,
  onAlert: AnomalyAlertCallback,
  thresholds: AnomalyThresholds = {},
) {
  const history: TransactionRecord[] = [];

  return {
    /** Add a transaction to the historical record. */
    addTransaction(record: TransactionRecord): void {
      history.push(record);
    },

    /** Evaluate an incoming transaction and optionally trigger an alert. */
    evaluate(incoming: TransactionRecord): AnomalyResult {
      const result = detectAnomaly(history, incoming, thresholds);

      if (result.riskScore >= alertThreshold) {
        onAlert({
          transaction: incoming,
          result,
          alertedAt: new Date().toISOString(),
        });
      }

      return result;
    },

    /** Return the current history size. */
    getHistorySize(): number {
      return history.length;
    },

    /** Clear historical data. */
    clearHistory(): void {
      history.length = 0;
    },
  };
}
