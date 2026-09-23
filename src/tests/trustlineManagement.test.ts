/**
 * Tests for validateTrustline, getBulkTrustlines, and
 * buildBulkTrustlineTransaction (#402).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, Networks, TransactionBuilder, Operation } from "@stellar/stellar-sdk";
import { SorokitErrorCode } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";

const mockLoadAccount = vi.hoisted(() => vi.fn());

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
  };
});

import {
  validateTrustline,
  getBulkTrustlines,
  buildBulkTrustlineTransaction,
} from "../transaction/buildTransaction";
import { MAX_OPERATIONS_PER_TRANSACTION } from "../transaction/validateTransaction";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK_CONFIG: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: HORIZON_URL,
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
};

function fakeHorizonAccount(
  publicKey: string,
  balances: Array<Record<string, unknown>>,
  sequence = "100",
) {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => sequence,
    balances,
    incrementSequenceNumber: () => {},
  };
}

describe("validateTrustline (#402)", () => {
  let publicKey: string;
  const usdcIssuer = Keypair.random().publicKey();

  beforeEach(() => {
    vi.clearAllMocks();
    publicKey = Keypair.random().publicKey();
  });

  it("rejects an invalid account address", async () => {
    const result = await validateTrustline(HORIZON_URL, "bad-key", { code: "USDC", issuer: usdcIssuer });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
  });

  it("treats the native asset as always trusted", async () => {
    mockLoadAccount.mockResolvedValueOnce(
      fakeHorizonAccount(publicKey, [{ asset_type: "native", balance: "50.0000000" }]),
    );
    const result = await validateTrustline(HORIZON_URL, publicKey, { code: "XLM", issuer: null });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.exists).toBe(true);
      expect(result.data.balance).toBe("50.0000000");
      expect(result.data.limit).toBeNull();
    }
  });

  it("reports exists: true with balance/limit when the trustline is present", async () => {
    mockLoadAccount.mockResolvedValueOnce(
      fakeHorizonAccount(publicKey, [
        { asset_type: "native", balance: "10.0000000" },
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: usdcIssuer,
          balance: "25.0000000",
          limit: "1000.0000000",
        },
      ]),
    );
    const result = await validateTrustline(HORIZON_URL, publicKey, { code: "USDC", issuer: usdcIssuer });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.exists).toBe(true);
      expect(result.data.balance).toBe("25.0000000");
      expect(result.data.limit).toBe("1000.0000000");
    }
  });

  it("reports exists: false when no trustline for the asset exists", async () => {
    mockLoadAccount.mockResolvedValueOnce(
      fakeHorizonAccount(publicKey, [{ asset_type: "native", balance: "10.0000000" }]),
    );
    const result = await validateTrustline(HORIZON_URL, publicKey, { code: "USDC", issuer: usdcIssuer });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.exists).toBe(false);
      expect(result.data.balance).toBeNull();
      expect(result.data.limit).toBeNull();
    }
  });

  it("rejects a non-native asset with no issuer", async () => {
    const result = await validateTrustline(HORIZON_URL, publicKey, { code: "USDC", issuer: null });
    expect(result.status).toBe("error");
  });

  it("maps a Horizon 404 to ACCOUNT_NOT_FOUND", async () => {
    const notFound = Object.assign(new Error("Not Found"), { response: { status: 404 } });
    mockLoadAccount.mockRejectedValueOnce(notFound);
    const result = await validateTrustline(HORIZON_URL, publicKey, { code: "USDC", issuer: usdcIssuer });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
  });
});

describe("getBulkTrustlines (#402)", () => {
  let publicKey: string;
  const usdcIssuer = Keypair.random().publicKey();
  const eurcIssuer = Keypair.random().publicKey();

  beforeEach(() => {
    vi.clearAllMocks();
    publicKey = Keypair.random().publicKey();
  });

  it("rejects an invalid account address", async () => {
    const result = await getBulkTrustlines(HORIZON_URL, "bad-key", [{ code: "USDC", issuer: usdcIssuer }]);
    expect(result.status).toBe("error");
  });

  it("returns an empty array for an empty asset list without calling Horizon", async () => {
    const result = await getBulkTrustlines(HORIZON_URL, publicKey, []);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data).toEqual([]);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("resolves every requested asset from a single loadAccount call", async () => {
    mockLoadAccount.mockResolvedValueOnce(
      fakeHorizonAccount(publicKey, [
        { asset_type: "native", balance: "10.0000000" },
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: usdcIssuer,
          balance: "25.0000000",
          limit: "1000.0000000",
        },
      ]),
    );

    const result = await getBulkTrustlines(HORIZON_URL, publicKey, [
      { code: "XLM", issuer: null },
      { code: "USDC", issuer: usdcIssuer },
      { code: "EURC", issuer: eurcIssuer },
    ]);

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data).toHaveLength(3);
    expect(result.data[0]).toMatchObject({ assetCode: "XLM", exists: true, balance: "10.0000000" });
    expect(result.data[1]).toMatchObject({ assetCode: "USDC", exists: true, balance: "25.0000000" });
    expect(result.data[2]).toMatchObject({ assetCode: "EURC", exists: false, balance: null });
  });

  it("propagates an account-not-found error", async () => {
    const notFound = Object.assign(new Error("Not Found"), { response: { status: 404 } });
    mockLoadAccount.mockRejectedValueOnce(notFound);
    const result = await getBulkTrustlines(HORIZON_URL, publicKey, [{ code: "USDC", issuer: usdcIssuer }]);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
  });
});

describe("buildBulkTrustlineTransaction (#402)", () => {
  let publicKey: string;
  const usdcIssuer = Keypair.random().publicKey();
  const eurcIssuer = Keypair.random().publicKey();

  beforeEach(() => {
    vi.clearAllMocks();
    publicKey = Keypair.random().publicKey();
    mockLoadAccount.mockResolvedValue(fakeHorizonAccount(publicKey, [], "100"));
  });

  it("rejects an invalid source address", async () => {
    const result = await buildBulkTrustlineTransaction(HORIZON_URL, NETWORK_CONFIG, "bad-key", [
      { code: "USDC", issuer: usdcIssuer },
    ]);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
  });

  it("rejects an empty asset list", async () => {
    const result = await buildBulkTrustlineTransaction(HORIZON_URL, NETWORK_CONFIG, publicKey, []);
    expect(result.status).toBe("error");
  });

  it("rejects an asset with no issuer", async () => {
    const result = await buildBulkTrustlineTransaction(HORIZON_URL, NETWORK_CONFIG, publicKey, [
      { code: "USDC", issuer: "" },
    ]);
    expect(result.status).toBe("error");
  });

  it("builds a transaction with one changeTrust operation per unique asset", async () => {
    const result = await buildBulkTrustlineTransaction(HORIZON_URL, NETWORK_CONFIG, publicKey, [
      { code: "USDC", issuer: usdcIssuer },
      { code: "EURC", issuer: eurcIssuer, limit: "500" },
    ]);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const tx = TransactionBuilder.fromXDR(result.data, NETWORK_CONFIG.networkPassphrase);
    const ops = ("operations" in tx ? tx.operations : []) as Operation.ChangeTrust[];
    expect(ops).toHaveLength(2);
    expect(ops[0]?.type).toBe("changeTrust");
    expect(ops[0]?.line.getCode()).toBe("USDC");
    expect(ops[1]?.limit).toBe("500.0000000");
  });

  it("de-duplicates identical (code, issuer, limit) requests", async () => {
    const result = await buildBulkTrustlineTransaction(HORIZON_URL, NETWORK_CONFIG, publicKey, [
      { code: "USDC", issuer: usdcIssuer },
      { code: "USDC", issuer: usdcIssuer },
    ]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const tx = TransactionBuilder.fromXDR(result.data, NETWORK_CONFIG.networkPassphrase);
    const ops = "operations" in tx ? tx.operations : [];
    expect(ops).toHaveLength(1);
  });

  it("rejects a batch that would exceed MAX_OPERATIONS_PER_TRANSACTION", async () => {
    const tooMany = Array.from({ length: MAX_OPERATIONS_PER_TRANSACTION + 1 }, (_, i) => ({
      code: `AST${i}`,
      issuer: Keypair.random().publicKey(),
    }));
    const result = await buildBulkTrustlineTransaction(HORIZON_URL, NETWORK_CONFIG, publicKey, tooMany);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/at most/i);
    }
  });

  it("supports building offline via a pre-fetched sequence number", async () => {
    const result = await buildBulkTrustlineTransaction(HORIZON_URL, NETWORK_CONFIG, publicKey, [
      { code: "USDC", issuer: usdcIssuer },
    ], { sequenceNumber: "42" });

    expect(result.status).toBe("ok");
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });
});
