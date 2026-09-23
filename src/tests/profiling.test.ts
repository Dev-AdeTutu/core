/**
 * Tests for the optional performance profiling layer (#397).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  configureProfiling,
  isProfilingEnabled,
  profileOperation,
  getPerformanceMetrics,
  exportPerformanceMetrics,
  resetPerformanceMetrics,
  DEFAULT_MAX_METRIC_ENTRIES,
  metricsCollector,
} from "../shared/metrics";
import { ok, err, SorokitErrorCode } from "../shared/response";

describe("performance profiling (#397)", () => {
  beforeEach(() => {
    resetPerformanceMetrics();
    configureProfiling({ enabled: false });
  });

  afterEach(() => {
    resetPerformanceMetrics();
    configureProfiling({
      enabled: false,
      maxEntries: DEFAULT_MAX_METRIC_ENTRIES,
    });
  });

  describe("configuration", () => {
    it("is disabled by default", () => {
      expect(isProfilingEnabled()).toBe(false);
    });

    it("can be enabled and disabled", () => {
      configureProfiling({ enabled: true });
      expect(isProfilingEnabled()).toBe(true);
      configureProfiling({ enabled: false });
      expect(isProfilingEnabled()).toBe(false);
    });
  });

  describe("disabled mode", () => {
    it("calls through without recording anything", async () => {
      const result = await profileOperation("test.op", async () => 42);
      expect(result).toBe(42);
      expect(getPerformanceMetrics().totalSamples).toBe(0);
      expect(getPerformanceMetrics().operations).toEqual([]);
    });

    it("propagates errors without recording", async () => {
      await expect(
        profileOperation("test.op", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(getPerformanceMetrics().totalSamples).toBe(0);
    });
  });

  describe("collection", () => {
    beforeEach(() => {
      configureProfiling({ enabled: true });
    });

    it("records operation name, latency, and success", async () => {
      await profileOperation("test.op", async () => ok("done"));

      const report = getPerformanceMetrics();
      expect(report.enabled).toBe(true);
      expect(report.totalSamples).toBe(1);
      expect(report.operations).toHaveLength(1);
      const stats = report.operations[0];
      expect(stats?.operation).toBe("test.op");
      expect(stats?.count).toBe(1);
      expect(stats?.successCount).toBe(1);
      expect(stats?.failureCount).toBe(0);
      expect(stats?.p50).toBeGreaterThanOrEqual(0);
    });

    it("records a thrown error as a failure and rethrows", async () => {
      await expect(
        profileOperation("test.op", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const stats = getPerformanceMetrics().operations[0];
      expect(stats?.failureCount).toBe(1);
      expect(stats?.successCount).toBe(0);
    });

    it("records a SorokitResult error value as a failure", async () => {
      const result = await profileOperation("test.op", async () =>
        err(SorokitErrorCode.NETWORK_ERROR, "down"),
      );
      expect(result.status).toBe("error");

      const stats = getPerformanceMetrics().operations[0];
      expect(stats?.failureCount).toBe(1);
    });

    it("supports synchronous functions", async () => {
      const value = await profileOperation("test.sync", () => "sync-value");
      expect(value).toBe("sync-value");
      expect(getPerformanceMetrics().totalSamples).toBe(1);
    });
  });

  describe("aggregation", () => {
    it("computes p50, p95, and p99 from recorded samples", () => {
      configureProfiling({ enabled: true });
      // Record 100 samples with latencies 1..100ms directly
      for (let i = 1; i <= 100; i++) {
        metricsCollector.record({
          operation: "agg.op",
          durationMs: i,
          success: true,
          timestamp: Date.now(),
        });
      }

      const stats = getPerformanceMetrics().operations.find(
        (s) => s.operation === "agg.op",
      );
      expect(stats?.count).toBe(100);
      expect(stats?.min).toBe(1);
      expect(stats?.max).toBe(100);
      expect(stats?.p50).toBe(51);
      expect(stats?.p95).toBe(96);
      expect(stats?.p99).toBe(100);
    });

    it("aggregates multiple operations independently", async () => {
      configureProfiling({ enabled: true });
      await profileOperation("op.a", async () => ok(1));
      await profileOperation("op.b", async () => ok(2));
      await profileOperation("op.a", async () => ok(3));

      const report = getPerformanceMetrics();
      const a = report.operations.find((s) => s.operation === "op.a");
      const b = report.operations.find((s) => s.operation === "op.b");
      expect(a?.count).toBe(2);
      expect(b?.count).toBe(1);
    });
  });

  describe("bounded memory", () => {
    it("discards the oldest samples beyond maxEntries", () => {
      configureProfiling({ enabled: true, maxEntries: 10 });
      for (let i = 0; i < 25; i++) {
        metricsCollector.record({
          operation: "bounded.op",
          durationMs: i,
          success: true,
          timestamp: Date.now(),
        });
      }

      const report = getPerformanceMetrics();
      expect(report.totalSamples).toBe(10);
      const stats = report.operations.find(
        (s) => s.operation === "bounded.op",
      );
      // Only the newest 10 samples (durations 15..24) remain
      expect(stats?.min).toBe(15);
      expect(stats?.max).toBe(24);
    });
  });

  describe("JSON export", () => {
    it("exports the aggregated report as parseable JSON", async () => {
      configureProfiling({ enabled: true });
      await profileOperation("export.op", async () => ok("x"));

      const json = exportPerformanceMetrics();
      const parsed = JSON.parse(json) as {
        enabled: boolean;
        totalSamples: number;
        operations: Array<{ operation: string; p50: number; p95: number; p99: number }>;
      };
      expect(parsed.enabled).toBe(true);
      expect(parsed.totalSamples).toBe(1);
      expect(parsed.operations[0]?.operation).toBe("export.op");
      expect(typeof parsed.operations[0]?.p50).toBe("number");
    });
  });
});
