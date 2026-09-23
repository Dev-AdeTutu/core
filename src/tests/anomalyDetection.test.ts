import { describe, it, expect, vi } from "vitest";
import {
  detectAnomaly,
  createAnomalyDetector,
  type TransactionRecord,
} from "../account/anomalyDetection";

function makeTx(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: `tx_${Math.random().toString(36).slice(2, 8)}`,
    destination: "GDESTINATION1234567890123456789012345678901234567890ABCDEF",
    amount: 100,
    timestamp: new Date().toISOString(),
    assetCode: "XLM",
    ...overrides,
  };
}

function generateHistory(
  count: number,
  baseAmount = 100,
): TransactionRecord[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) =>
    makeTx({
      id: `hist_${i}`,
      amount: baseAmount + Math.sin(i) * 10,
      timestamp: new Date(now - (count - i) * 3_600_000).toISOString(),
    }),
  );
}

describe("anomaly detection", () => {
  describe("detectAnomaly", () => {
    it("returns zero risk with insufficient history", () => {
      const history = generateHistory(5);
      const result = detectAnomaly(history, makeTx());

      expect(result.riskScore).toBe(0);
      expect(result.anomalies).toHaveLength(0);
      expect(result.summary).toContain("Insufficient history");
    });

    it("returns zero risk for normal transactions", () => {
      const history = generateHistory(20, 100);
      const normal = makeTx({ amount: 100, destination: history[0].destination });

      const result = detectAnomaly(history, normal);

      expect(result.riskScore).toBeLessThan(0.5);
    });

    it("detects unusual amounts via z-score", () => {
      const history = generateHistory(20, 100);
      // Amount 10x the mean should trigger
      const anomalous = makeTx({ amount: 1000 });

      const result = detectAnomaly(history, anomalous, {
        amountZScore: 2,
      });

      expect(
        result.anomalies.some((a) => a.type === "unusual_amount"),
      ).toBe(true);
    });

    it("detects unknown destinations", () => {
      const history = generateHistory(20, 100);
      const unknown = makeTx({
        destination: "GUNKNOWN999999999999999999999999999999999999999999ABCDEF",
      });

      const result = detectAnomaly(history, unknown);

      expect(
        result.anomalies.some((a) => a.type === "unusual_destination"),
      ).toBe(true);
    });

    it("respects history window", () => {
      const oldHistory = generateHistory(20, 100).map((r) => ({
        ...r,
        timestamp: new Date(
          Date.now() - 60 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      }));

      const result = detectAnomaly(oldHistory, makeTx(), {
        historyWindowMs: 30 * 24 * 60 * 60 * 1000,
      });

      expect(result.summary).toContain("Insufficient history");
    });
  });

  describe("createAnomalyDetector", () => {
    it("fires alert when risk exceeds threshold", () => {
      const onAlert = vi.fn();
      const detector = createAnomalyDetector(0.1, onAlert, {
        minHistorySize: 5,
      });

      // Add enough history
      for (let i = 0; i < 10; i++) {
        detector.addTransaction(
          makeTx({ id: `h${i}`, amount: 100, destination: "GDEST" }),
        );
      }

      // Evaluate an anomalous transaction
      detector.evaluate(
        makeTx({ amount: 10000, destination: "GUNKNOWN" }),
      );

      expect(onAlert).toHaveBeenCalledOnce();
    });

    it("does not fire alert when risk is below threshold", () => {
      const onAlert = vi.fn();
      const detector = createAnomalyDetector(0.9, onAlert, {
        minHistorySize: 5,
      });

      for (let i = 0; i < 10; i++) {
        detector.addTransaction(
          makeTx({ id: `h${i}`, amount: 100, destination: "GDEST" }),
        );
      }

      detector.evaluate(makeTx({ amount: 100, destination: "GDEST" }));

      expect(onAlert).not.toHaveBeenCalled();
    });

    it("tracks history size", () => {
      const detector = createAnomalyDetector(1, () => {});

      expect(detector.getHistorySize()).toBe(0);
      detector.addTransaction(makeTx());
      expect(detector.getHistorySize()).toBe(1);

      detector.clearHistory();
      expect(detector.getHistorySize()).toBe(0);
    });
  });
});
