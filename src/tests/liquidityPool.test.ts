import { describe, it, expect, vi, beforeEach } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";

// ─── Hoisted spy refs ─────────────────────────────────────────────────────────

const { mockLoadAccount, mockAddOperation, mockSetTimeout, mockAddMemo } =
  vi.hoisted(() => ({
    mockLoadAccount: vi.fn(),
    mockAddOperation: vi.fn(),
    mockSetTimeout: vi.fn(),
    mockAddMemo: vi.fn(),
  }));

const MOCK_XDR = "AAAAAQAAAAA=";

// ─── Stellar SDK mock ─────────────────────────────────────────────────────────

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockTransactionBuilder {
    static fromXDR = vi.fn();
    constructor(_sourceAccount: unknown, _options: unknown) {}
    addOperation(...args: any[]) { mockAddOperation(...args); return this; }
    setTimeout(...args: any[]) { mockSetTimeout(...args); return this; }
    addMemo(...args: any[]) { mockAddMemo(...args); return this; }
    build() { return { toXDR: () => MOCK_XDR }; }
  }

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
    TransactionBuilder: MockTransactionBuilder,
  };
});

// ─── Subjects under test ──────────────────────────────────────────────────────

import {
  buildLiquidityPoolDepositTransaction,
  buildLiquidityPoolWithdrawTransaction,
} from "../transaction/buildTransaction";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const SOURCE = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";

/** Valid 64-character hex pool ID */
const POOL_ID =
  "a516b3f68c836cfd9cbc86c0a64e5e927893dcb95c66fffdbbf62d68bc1badf1";

const mockAccount = {
  accountId: () => SOURCE,
  sequenceNumber: () => "1",
  incrementSequenceNumber: () => {},
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildLiquidityPoolDepositTransaction (#551)", () => {
  beforeEach(() => {
    mockLoadAccount.mockResolvedValue(mockAccount);
    mockAddOperation.mockReset();
    mockSetTimeout.mockReset();
    mockAddMemo.mockReset();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe("valid deposit", () => {
    it("returns ok XDR for a valid deposit", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.data).toBe(MOCK_XDR);
      expect(mockAddOperation).toHaveBeenCalledOnce();
      expect(mockSetTimeout).toHaveBeenCalledOnce();
    });

    it("accepts rational price objects { n, d }", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: { n: 2, d: 5 },
          maxPrice: { n: 3, d: 5 },
        },
      );

      expect(result.status).toBe("ok");
    });

    it("accepts amounts with exactly 7 decimal places", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000.1234567",
          maxAmountB: "500.1234567",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("ok");
    });

    it("attaches a memo when provided", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
          memo: "lp-deposit-1",
          memoType: "text",
        },
      );

      expect(result.status).toBe("ok");
      expect(mockAddMemo).toHaveBeenCalledOnce();
    });

    it("does not attach a memo when none is provided", async () => {
      await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(mockAddMemo).not.toHaveBeenCalled();
    });
  });

  // ── Pool ID validation ──────────────────────────────────────────────────────

  describe("pool ID validation", () => {
    it("returns error for an empty pool ID", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: "",
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("liquidityPoolId");
      }
    });

    it("returns error for a pool ID that is not 64 hex characters", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: "abc123",
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("64-character hex");
      }
    });

    it("returns error for a pool ID with non-hex characters", async () => {
      const badId = "z".repeat(64);
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: badId,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      }
    });
  });

  // ── Amount validation ───────────────────────────────────────────────────────

  describe("amount validation", () => {
    it("returns error when maxAmountA is zero", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "0",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("maxAmountA");
      }
    });

    it("returns error when maxAmountB is negative", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "-1",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("maxAmountB");
      }
    });

    it("returns error when maxAmountA exceeds 7 decimal places", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1.12345678",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("precision");
      }
    });
  });

  // ── Price bound validation ──────────────────────────────────────────────────

  describe("price bound validation", () => {
    it("returns error when minPrice equals maxPrice", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.5",
          maxPrice: "0.5",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("minPrice must be less than maxPrice");
      }
    });

    it("returns error when minPrice is greater than maxPrice", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.8",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("minPrice must be less than maxPrice");
      }
    });

    it("returns error for a zero minPrice", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("positive");
      }
    });

    it("returns error for a negative maxPrice", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "-0.1",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      }
    });

    it("returns error for a price exceeding 7 decimal places", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.12345678",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("precision");
      }
    });

    it("returns error for a rational price with zero denominator", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: { n: 2, d: 0 },
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("positive");
      }
    });
  });

  // ── Memo ────────────────────────────────────────────────────────────────────

  describe("memo validation", () => {
    it("returns error when requireMemo is true but no memo is provided", async () => {
      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
          requireMemo: true,
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("Memo is required");
      }
    });
  });

  // ── Horizon errors ──────────────────────────────────────────────────────────

  describe("Horizon error handling", () => {
    it("returns TX_BUILD_FAILED when loadAccount throws", async () => {
      mockLoadAccount.mockRejectedValue(new Error("Network error"));

      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("liquidity pool deposit");
      }
    });

    it("surfaces connectivity context when Horizon is unreachable", async () => {
      const e = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      mockLoadAccount.mockRejectedValue(e);

      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("connectivity");
      }
    });

    it("surfaces timeout context when Horizon times out", async () => {
      const e = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      mockLoadAccount.mockRejectedValue(e);

      const result = await buildLiquidityPoolDepositTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          maxAmountA: "1000",
          maxAmountB: "500",
          minPrice: "0.4",
          maxPrice: "0.6",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("timed out");
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("buildLiquidityPoolWithdrawTransaction (#551)", () => {
  beforeEach(() => {
    mockLoadAccount.mockResolvedValue(mockAccount);
    mockAddOperation.mockReset();
    mockSetTimeout.mockReset();
    mockAddMemo.mockReset();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe("valid withdraw", () => {
    it("returns ok XDR for a valid withdraw", async () => {
      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "100",
          minAmountA: "400",
          minAmountB: "200",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.data).toBe(MOCK_XDR);
      expect(mockAddOperation).toHaveBeenCalledOnce();
      expect(mockSetTimeout).toHaveBeenCalledOnce();
    });

    it("accepts amounts with exactly 7 decimal places", async () => {
      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "100.1234567",
          minAmountA: "400.1234567",
          minAmountB: "200.1234567",
        },
      );

      expect(result.status).toBe("ok");
    });

    it("attaches a memo when provided", async () => {
      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "100",
          minAmountA: "400",
          minAmountB: "200",
          memo: "lp-withdraw-1",
          memoType: "text",
        },
      );

      expect(result.status).toBe("ok");
      expect(mockAddMemo).toHaveBeenCalledOnce();
    });

    it("does not attach a memo when none is provided", async () => {
      await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "100",
          minAmountA: "400",
          minAmountB: "200",
        },
      );

      expect(mockAddMemo).not.toHaveBeenCalled();
    });
  });

  // ── Pool ID validation ──────────────────────────────────────────────────────

  describe("pool ID validation", () => {
    it("returns error for a pool ID shorter than 64 hex chars", async () => {
      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: "deadbeef",
          amount: "100",
          minAmountA: "400",
          minAmountB: "200",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("64-character hex");
      }
    });

    it("returns error for an empty pool ID", async () => {
      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: "",
          amount: "100",
          minAmountA: "400",
          minAmountB: "200",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("liquidityPoolId");
      }
    });
  });

  // ── Amount validation ───────────────────────────────────────────────────────

  describe("amount validation", () => {
    it("returns error when shares amount is zero", async () => {
      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "0",
          minAmountA: "400",
          minAmountB: "200",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("positive");
      }
    });

    it("returns error when minAmountA is negative", async () => {
      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "100",
          minAmountA: "-1",
          minAmountB: "200",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("minAmountA");
      }
    });

    it("returns error when minAmountB exceeds 7 decimal places", async () => {
      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "100",
          minAmountA: "400",
          minAmountB: "1.12345678",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("precision");
      }
    });

    it("returns error for a non-numeric shares amount", async () => {
      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "not-a-number",
          minAmountA: "400",
          minAmountB: "200",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      }
    });
  });

  // ── Memo ────────────────────────────────────────────────────────────────────

  describe("memo validation", () => {
    it("returns error when requireMemo is true but no memo is provided", async () => {
      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "100",
          minAmountA: "400",
          minAmountB: "200",
          requireMemo: true,
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("Memo is required");
      }
    });
  });

  // ── Horizon errors ──────────────────────────────────────────────────────────

  describe("Horizon error handling", () => {
    it("returns TX_BUILD_FAILED when loadAccount throws", async () => {
      mockLoadAccount.mockRejectedValue(new Error("Network error"));

      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "100",
          minAmountA: "400",
          minAmountB: "200",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("liquidity pool withdraw");
      }
    });

    it("surfaces connectivity context when Horizon is unreachable", async () => {
      const e = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      mockLoadAccount.mockRejectedValue(e);

      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "100",
          minAmountA: "400",
          minAmountB: "200",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("connectivity");
      }
    });

    it("surfaces timeout context when Horizon times out", async () => {
      const e = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      mockLoadAccount.mockRejectedValue(e);

      const result = await buildLiquidityPoolWithdrawTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        SOURCE,
        {
          liquidityPoolId: POOL_ID,
          amount: "100",
          minAmountA: "400",
          minAmountB: "200",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("timed out");
      }
    });
  });
});
