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

    addOperation(...args: any[]) {
      mockAddOperation(...args);
      return this;
    }

    setTimeout(...args: any[]) {
      mockSetTimeout(...args);
      return this;
    }

    addMemo(...args: any[]) {
      mockAddMemo(...args);
      return this;
    }

    build() {
      return { toXDR: () => MOCK_XDR };
    }
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

// ─── Subject under test ───────────────────────────────────────────────────────

import { buildClawbackTransaction } from "../transaction/buildTransaction";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

/** The asset issuer — also the transaction source for clawback */
const ISSUER = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
/** A holder whose tokens will be clawed back */
const HOLDER = "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R";
/** A different valid G-address (not the issuer) used to test issuer mismatch */
const OTHER = "GAPUEDT4TZGUN64L4SAN4YE5JDGIYTEDQZXLJMYS4VTHOAT5OBLNCIFK";

const mockAccount = {
  accountId: () => ISSUER,
  sequenceNumber: () => "1",
  incrementSequenceNumber: () => {},
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildClawbackTransaction (#553)", () => {
  beforeEach(() => {
    mockLoadAccount.mockResolvedValue(mockAccount);
    mockAddOperation.mockReset();
    mockSetTimeout.mockReset();
    mockAddMemo.mockReset();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe("valid clawback", () => {
    it("builds a clawback XDR and returns ok", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "1000",
        },
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(MOCK_XDR);
      }
      expect(mockAddOperation).toHaveBeenCalledOnce();
      expect(mockSetTimeout).toHaveBeenCalledOnce();
    });

    it("passes the correct asset, from, and amount to Operation.clawback", async () => {
      await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "EURC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "500.5",
        },
      );

      expect(mockAddOperation).toHaveBeenCalledOnce();
      const op = mockAddOperation.mock.calls[0]?.[0];
      expect(op).toBeDefined();
    });

    it("accepts amount with exactly 7 decimal places", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "0.1234567",
        },
      );

      expect(result.status).toBe("ok");
    });

    it("attaches a text memo when provided", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "100",
          memo: "clawback-ref-001",
          memoType: "text",
        },
      );

      expect(result.status).toBe("ok");
      expect(mockAddMemo).toHaveBeenCalledOnce();
    });

    it("does not attach a memo when none is provided", async () => {
      await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "100",
        },
      );

      expect(mockAddMemo).not.toHaveBeenCalled();
    });
  });

  // ── Asset validation ────────────────────────────────────────────────────────

  describe("asset validation", () => {
    it("returns error for XLM (native asset cannot be clawed back)", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "XLM",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "100",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("native");
      }
    });

    it("returns error for asset code longer than 12 characters", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "TOOLONGASSETCODE",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "100",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("1–12");
      }
    });

    it("returns error for an empty asset code", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "100",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("required");
      }
    });

    it("returns error when asset issuer is not a valid G-address", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: "not-a-valid-address",
          from: HOLDER,
          amount: "100",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("G-address");
      }
    });

    it("accepts asset codes up to 12 characters", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "ABCDEFGHIJKL", // exactly 12 chars
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "1",
        },
      );

      expect(result.status).toBe("ok");
    });
  });

  // ── Source / issuer validation ──────────────────────────────────────────────

  describe("source must be asset issuer", () => {
    it("returns error when source account does not match asset issuer", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        OTHER, // source is NOT the issuer
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "100",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("issuer");
      }
    });
  });

  // ── From address validation ─────────────────────────────────────────────────

  describe("from address validation", () => {
    it("returns error when from is not a valid G-address", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: "invalid-address",
          amount: "100",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("G-address");
      }
    });

    it("returns error when from is an empty string", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: "",
          amount: "100",
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
    it("returns error for amount of zero", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "0",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("positive");
      }
    });

    it("returns error for a negative amount", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "-50",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("positive");
      }
    });

    it("returns error for amount with more than 7 decimal places", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "1.12345678", // 8 decimal places
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("precision");
      }
    });

    it("returns error for a non-numeric amount", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "not-a-number",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      }
    });

    it("returns error for an empty amount", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("required");
      }
    });
  });

  // ── Memo validation ─────────────────────────────────────────────────────────

  describe("memo validation", () => {
    it("returns error when requireMemo is true but no memo is provided", async () => {
      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "100",
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

  // ── Horizon error handling ──────────────────────────────────────────────────

  describe("Horizon error handling", () => {
    it("returns TX_BUILD_FAILED when loadAccount throws", async () => {
      mockLoadAccount.mockRejectedValue(new Error("Network error"));

      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "100",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
        expect(result.error.message).toContain("clawback");
      }
    });

    it("surfaces connectivity context when Horizon is unreachable", async () => {
      const connError = new Error("ECONNREFUSED");
      (connError as any).code = "ECONNREFUSED";
      mockLoadAccount.mockRejectedValue(connError);

      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "100",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("connectivity");
      }
    });

    it("surfaces timeout context when Horizon times out", async () => {
      const timeoutError = new Error("Request timed out");
      (timeoutError as any).code = "ETIMEDOUT";
      mockLoadAccount.mockRejectedValue(timeoutError);

      const result = await buildClawbackTransaction(
        networkConfig.horizonUrl,
        networkConfig,
        ISSUER,
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          from: HOLDER,
          amount: "100",
        },
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.message).toContain("timed out");
      }
    });
  });
});
