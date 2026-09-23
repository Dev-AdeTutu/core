/**
 * Lightweight in-memory metrics collector for SDK operation latency tracking.
 * All collection is optional — no metrics are recorded unless explicitly called.
 */

export interface MetricEntry {
  /** Name of the operation (e.g. "account.get", "transaction.submit") */
  operation: string;
  /** Wall-clock duration of the operation in milliseconds */
  durationMs: number;
  /** Whether the operation succeeded */
  success: boolean;
  /** Unix epoch ms at which the operation completed */
  timestamp: number;
}

export interface MetricSummary {
  /** Operation name */
  operation: string;
  /** Total number of recorded calls */
  count: number;
  /** Number of successful calls */
  successCount: number;
  /** Number of failed calls */
  failureCount: number;
  /** Minimum recorded duration in ms */
  min: number;
  /** Maximum recorded duration in ms */
  max: number;
  /** Mean duration in ms */
  avg: number;
  /** 50th-percentile (median) duration in ms */
  p50: number;
  /** 95th-percentile duration in ms */
  p95: number;
  /** 99th-percentile duration in ms */
  p99: number;
}

export interface MetricsFilter {
  /** Restrict summary to a single operation name */
  operation?: string;
  /** Include only entries recorded at or after this timestamp (ms epoch) */
  since?: number;
}

/**
 * Maximum number of entries kept in memory. When the bound is reached the
 * oldest entries are discarded, keeping metrics state at a fixed footprint
 * for long-running processes.
 */
export const DEFAULT_MAX_METRIC_ENTRIES = 5000;

class MetricsCollector {
  private readonly entries: MetricEntry[] = [];
  private maxEntries = DEFAULT_MAX_METRIC_ENTRIES;

  record(entry: MetricEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  setMaxEntries(max: number): void {
    this.maxEntries = Math.max(1, Math.floor(max));
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  get size(): number {
    return this.entries.length;
  }

  getMetrics(filter?: MetricsFilter): MetricSummary[] {
    let filtered = this.entries;

    if (filter?.operation !== undefined) {
      filtered = filtered.filter((e) => e.operation === filter.operation);
    }
    if (filter?.since !== undefined) {
      const since = filter.since;
      filtered = filtered.filter((e) => e.timestamp >= since);
    }

    const groups = new Map<string, MetricEntry[]>();
    for (const entry of filtered) {
      const group = groups.get(entry.operation) ?? [];
      group.push(entry);
      groups.set(entry.operation, group);
    }

    return Array.from(groups.entries()).map(([operation, entries]) => {
      const durations = entries.map((e) => e.durationMs).sort((a, b) => a - b);
      const sum = durations.reduce((acc, d) => acc + d, 0);
      const percentile = (p: number): number => {
        const idx = Math.min(
          Math.floor(p * durations.length),
          durations.length - 1,
        );
        return durations[idx] ?? 0;
      };

      return {
        operation,
        count: entries.length,
        successCount: entries.filter((e) => e.success).length,
        failureCount: entries.filter((e) => !e.success).length,
        min: durations[0] ?? 0,
        max: durations[durations.length - 1] ?? 0,
        avg: entries.length > 0 ? sum / entries.length : 0,
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
      };
    });
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/** Module-level singleton. All `recordMetric` / `getMetrics` calls target this. */
export const metricsCollector = new MetricsCollector();

/**
 * Record a completed operation into the global metrics store.
 *
 * @param operation  Human-readable name (e.g. "account.get")
 * @param durationMs Duration measured with `performance.now()` or `Date.now()`
 * @param success    Whether the operation returned a success result
 */
export function recordMetric(
  operation: string,
  durationMs: number,
  success: boolean,
): void {
  metricsCollector.record({
    operation,
    durationMs,
    success,
    timestamp: Date.now(),
  });
}

/**
 * Return aggregated metric summaries from the global store.
 *
 * @param filter  Optional — restrict by operation name and/or start time
 */
export function getMetrics(filter?: MetricsFilter): MetricSummary[] {
  return metricsCollector.getMetrics(filter);
}

/**
 * Remove all recorded entries from the global store.
 * Useful between tests or when resetting a monitoring session.
 */
export function clearMetrics(): void {
  metricsCollector.clear();
}

/**
 * Wrap an async operation with automatic metric recording.
 * Uses `performance.now()` for high-resolution timing.
 *
 * @param operation  Name to record under
 * @param fn         Async function to time
 */
export async function withMetrics<T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  let success = true;
  try {
    const result = await fn();
    return result;
  } catch (e) {
    success = false;
    throw e;
  } finally {
    const durationMs = performance.now() - start;
    recordMetric(operation, durationMs, success);
  }
}

/* ------------------------------------------------------------------ */
/*  Optional performance profiling layer (#397)                       */
/* ------------------------------------------------------------------ */

/**
 * Profiling configuration. Profiling is disabled by default: when disabled,
 * `profileOperation` invokes the wrapped function directly with no timing
 * work at all, so overhead is a single boolean check.
 */
export interface ProfilingConfig {
  /** Master switch for latency collection */
  enabled: boolean;
  /**
   * Bound on retained samples across all operations
   * (default {@link DEFAULT_MAX_METRIC_ENTRIES}); oldest samples are
   * discarded first.
   */
  maxEntries?: number;
}

/** Aggregated performance report returned by {@link getPerformanceMetrics}. */
export interface PerformanceMetricsReport {
  /** Whether profiling is currently enabled */
  enabled: boolean;
  /** Number of raw samples currently retained */
  totalSamples: number;
  /** Per-operation aggregated latency statistics */
  operations: MetricSummary[];
}

let profilingEnabled = false;

/**
 * Enable or disable performance profiling and optionally adjust the retained
 * sample bound.
 *
 * @example
 * configureProfiling({ enabled: true, maxEntries: 1000 });
 */
export function configureProfiling(config: ProfilingConfig): void {
  profilingEnabled = config.enabled;
  if (config.maxEntries !== undefined) {
    metricsCollector.setMaxEntries(config.maxEntries);
  }
}

/** Whether profiling is currently enabled. */
export function isProfilingEnabled(): boolean {
  return profilingEnabled;
}

/**
 * Detect a failed `SorokitResult` so profiled operations that report errors
 * as values (rather than throwing) are still counted as failures.
 */
function isErrorResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value as { status: unknown }).status === "error"
  );
}

/**
 * Wrap an SDK operation with optional latency profiling.
 *
 * When profiling is disabled this is a direct call-through. When enabled,
 * the operation's wall-clock latency and outcome (throw or `SorokitResult`
 * error → failure) are recorded under `operation`.
 *
 * @param operation Name to record under (e.g. "account.get")
 * @param fn        The operation to execute
 */
export async function profileOperation<T>(
  operation: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!profilingEnabled) {
    return fn();
  }

  const start = performance.now();
  try {
    const result = await fn();
    recordMetric(operation, performance.now() - start, !isErrorResult(result));
    return result;
  } catch (error) {
    recordMetric(operation, performance.now() - start, false);
    throw error;
  }
}

/**
 * Aggregated latency statistics (p50/p95/p99, min/max/avg, success and
 * failure counts) for every profiled operation.
 */
export function getPerformanceMetrics(): PerformanceMetricsReport {
  return {
    enabled: profilingEnabled,
    totalSamples: metricsCollector.size,
    operations: getMetrics(),
  };
}

/**
 * Export the aggregated performance metrics as a JSON string for external
 * monitoring systems.
 */
export function exportPerformanceMetrics(): string {
  return JSON.stringify(getPerformanceMetrics(), null, 2);
}

/**
 * Clear all recorded samples (does not change the enabled state).
 */
export function resetPerformanceMetrics(): void {
  metricsCollector.clear();
}
