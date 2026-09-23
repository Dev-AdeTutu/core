/**
 * Tests for null/undefined edge paths hardened as part of the strict null
 * checking audit (#396). Each case exercises a code path that previously
 * relied on a non-null assertion and now uses an explicit guard.
 */

import { describe, it, expect } from "vitest";
import { calculateMedian } from "../transaction/feeSurge";
import { analyzeFeeHistory } from "../transaction/feeAnalytics";
import { createTransactionBuilder } from "../transaction/transactionBuilder";
import { normalizePairId } from "../shared/validateToken";
import type { TransactionResult } from "../transaction/types";

describe("strict null paths (#396)", () => {
  describe("calculateMedian", () => {
    it("returns 0 for an empty array", () => {
      expect(calculateMedian([])).toBe(0);
    });

    it("returns the single element for a one-element array", () => {
      expect(calculateMedian([42])).toBe(42);
    });

    it("averages the middle pair for even-length arrays", () => {
      expect(calculateMedian([1, 2, 3, 4])).toBe(2.5);
    });
  });

  describe("analyzeFeeHistory", () => {
    it("returns null for an empty window", () => {
      expect(analyzeFeeHistory([])).toBeNull();
    });

    it("returns null when every fee is non-numeric", () => {
      const txs: TransactionResult[] = [
        { hash: "a", status: "success", fee: "not-a-number" },
      ];
      expect(analyzeFeeHistory(txs)).toBeNull();
    });

    it("computes stats for a single transaction", () => {
      const txs: TransactionResult[] = [
        { hash: "a", status: "success", fee: "100" },
      ];
      const analytics = analyzeFeeHistory(txs);
      expect(analytics).not.toBeNull();
      expect(analytics?.min).toBe("100");
      expect(analytics?.max).toBe("100");
      expect(analytics?.median).toBe("100");
    });
  });

  describe("createTransactionBuilder undo/redo", () => {
    it("undo returns undefined on an empty history", () => {
      const builder = createTransactionBuilder();
      expect(builder.undo()).toBeUndefined();
    });

    it("redo returns undefined with an empty redo stack", () => {
      const builder = createTransactionBuilder();
      expect(builder.redo()).toBeUndefined();
    });

    it("undo then redo round-trips the operation", () => {
      const builder = createTransactionBuilder();
      builder.addOperation({ type: "payment", params: { amount: "1" } });
      const undone = builder.undo();
      expect(undone?.type).toBe("payment");
      const redone = builder.redo();
      expect(redone?.type).toBe("payment");
    });
  });

  describe("normalizePairId", () => {
    const usdc = { code: "USDC", issuer: "GISSUER1" };
    const xlm = { code: "XLM", issuer: null };

    it("orders pairs consistently regardless of argument order", () => {
      expect(normalizePairId(usdc, xlm)).toBe("USDC/XLM");
      expect(normalizePairId(xlm, usdc)).toBe("USDC/XLM");
    });

    it("keeps first-argument order for equal codes", () => {
      expect(normalizePairId(xlm, { code: "XLM", issuer: "GISSUER2" })).toBe(
        "XLM/XLM",
      );
    });
  });
});
