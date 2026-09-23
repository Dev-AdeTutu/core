/**
 * Tests for discoverPaymentPaths (#400).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { SorokitErrorCode } from "../shared/response";

const mockStrictReceivePathsCall = vi.hoisted(() => vi.fn());
const mockStrictReceivePaths = vi.hoisted(() => vi.fn(() => ({ call: mockStrictReceivePathsCall })));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        strictReceivePaths: mockStrictReceivePaths,
      })),
    },
  };
});

import {
  discoverPaymentPaths,
  clearPathDiscoveryCache,
  DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS,
} from "../transaction/pathPayment";

const HORIZON_URL = "https://horizon-testnet.stellar.org";

const usdcIssuer = Keypair.random().publicKey();

function pathRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    source_amount: "100",
    source_asset_type: "native",
    source_asset_code: "",
    source_asset_issuer: "",
    destination_amount: "50",
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: "USDC",
    destination_asset_issuer: usdcIssuer,
    path: [],
    ...overrides,
  };
}

describe("discoverPaymentPaths (#400)", () => {
  let source: string;
  let destination: string;

  beforeEach(() => {
    vi.clearAllMocks();
    clearPathDiscoveryCache();
    source = Keypair.random().publicKey();
    destination = Keypair.random().publicKey();
  });

  it("rejects an invalid source address", async () => {
    const result = await discoverPaymentPaths(
      HORIZON_URL,
      "not-valid",
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "100",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    }
  });

  it("rejects an invalid destination address", async () => {
    const result = await discoverPaymentPaths(
      HORIZON_URL,
      source,
      "not-valid",
      { code: "USDC", issuer: usdcIssuer },
      "100",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
    }
  });

  it("rejects a non-positive destAmount", async () => {
    const result = await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "0",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ROUTER_INVALID_PATH);
    }
  });

  it("rejects a non-numeric destAmount", async () => {
    const result = await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "abc",
    );
    expect(result.status).toBe("error");
  });

  it("rejects a non-native destination asset with no issuer", async () => {
    const result = await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: null },
      "100",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toMatch(/issuer is required/i);
    }
  });

  it("returns an empty paths array (not an error) when Horizon finds no path", async () => {
    mockStrictReceivePathsCall.mockResolvedValueOnce({ records: [] });
    const result = await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "100",
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.paths).toEqual([]);
      expect(result.data.fromCache).toBe(false);
    }
  });

  it("ranks discovered paths ascending by required source amount and caps at 3", async () => {
    mockStrictReceivePathsCall.mockResolvedValueOnce({
      records: [
        pathRecord({ source_amount: "200" }),
        pathRecord({ source_amount: "50" }),
        pathRecord({ source_amount: "150" }),
        pathRecord({ source_amount: "75" }),
      ],
    });

    const result = await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "50",
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.paths).toHaveLength(3);
    expect(result.data.paths.map((p) => p.sourceAmount)).toEqual(["50", "75", "150"]);
  });

  it("maps native source/path hops to XLM with a null issuer", async () => {
    mockStrictReceivePathsCall.mockResolvedValueOnce({
      records: [
        pathRecord({
          path: [{ asset_type: "native", asset_code: "", asset_issuer: "" }],
        }),
      ],
    });

    const result = await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "50",
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.data.paths[0]?.sourceAsset).toEqual({ code: "XLM", issuer: null });
    expect(result.data.paths[0]?.path).toEqual([{ code: "XLM", issuer: null }]);
    expect(result.data.paths[0]?.hops).toBe(1);
  });

  it("serves a cached result on a repeat query within the TTL without calling Horizon again", async () => {
    mockStrictReceivePathsCall.mockResolvedValueOnce({ records: [pathRecord()] });

    const first = await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "50",
    );
    expect(first.status).toBe("ok");
    if (first.status === "ok") expect(first.data.fromCache).toBe(false);

    const second = await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "50",
    );
    expect(second.status).toBe("ok");
    if (second.status === "ok") expect(second.data.fromCache).toBe(true);

    expect(mockStrictReceivePathsCall).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache when skipCache is set", async () => {
    mockStrictReceivePathsCall.mockResolvedValue({ records: [pathRecord()] });

    await discoverPaymentPaths(HORIZON_URL, source, destination, { code: "USDC", issuer: usdcIssuer }, "50");
    await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "50",
      { skipCache: true },
    );

    expect(mockStrictReceivePathsCall).toHaveBeenCalledTimes(2);
  });

  it("expires cache entries after the configured TTL", async () => {
    vi.useFakeTimers();
    mockStrictReceivePathsCall.mockResolvedValue({ records: [pathRecord()] });

    await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "50",
      { cacheTtlMs: 1000 },
    );
    vi.advanceTimersByTime(1500);
    const second = await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "50",
      { cacheTtlMs: 1000 },
    );

    expect(second.status).toBe("ok");
    if (second.status === "ok") expect(second.data.fromCache).toBe(false);
    expect(mockStrictReceivePathsCall).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("uses the default 5-minute TTL constant", () => {
    expect(DEFAULT_PATH_DISCOVERY_CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it("surfaces a Horizon failure as ROUTER_INVALID_PATH", async () => {
    mockStrictReceivePathsCall.mockRejectedValueOnce(new Error("network down"));
    const result = await discoverPaymentPaths(
      HORIZON_URL,
      source,
      destination,
      { code: "USDC", issuer: usdcIssuer },
      "50",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ROUTER_INVALID_PATH);
    }
  });
});
