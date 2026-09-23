import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildPathPayment } from "../transaction/buildTransaction";

const issuer = Keypair.random().publicKey();
const source = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();
const network = {
  horizonUrl: "https://example.invalid",
  networkPassphrase: Networks.TESTNET,
  sorobanRpcUrl: "https://example.invalid",
};

const baseParams = {
  destination,
  sendAssetCode: "XLM",
  destAssetCode: "EURC",
  destAssetIssuer: issuer,
  amount: "100",
  sequenceNumber: "1",
  estimatedFee: "100",
  path: [
    { assetCode: "USDC", assetIssuer: issuer },
    { assetCode: "BTC", assetIssuer: issuer },
  ],
  slippageAmount: "95",
} as const;

const mockStrictSendPaths = vi.fn();
const mockStrictReceivePaths = vi.fn();

vi.mock("../shared/serverFactory", () => ({
  createHorizonServer: vi.fn(() => ({
    strictSendPaths: mockStrictSendPaths,
    strictReceivePaths: mockStrictReceivePaths,
    loadAccount: vi.fn(),
  })),
  createSorobanServer: vi.fn(),
  setTracedFetch: vi.fn(),
  getTracedFetch: vi.fn(),
  setSorobanSimulator: vi.fn(),
}));

function firstOperation(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations[0];
}

describe("router multi-hop swap integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a strict-send swap with two intermediate pools and a minimum output", async () => {
    const result = await buildPathPayment(network.horizonUrl, network, source, {
      ...baseParams,
      mode: "strict-send",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const operation = firstOperation(result.data);
      expect(operation.type).toBe("pathPaymentStrictSend");
      if (operation.type === "pathPaymentStrictSend") {
        expect(operation.path.map((asset) => asset.code)).toEqual([
          "USDC",
          "BTC",
        ]);
        expect(operation.sendAmount).toBe("100.0000000");
        expect(operation.destMin).toBe("95.0000000");
      }
    }
  });

  it("builds a strict-receive route with a maximum input slippage bound", async () => {
    const result = await buildPathPayment(network.horizonUrl, network, source, {
      ...baseParams,
      mode: "strict-receive",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const operation = firstOperation(result.data);
      expect(operation.type).toBe("pathPaymentStrictReceive");
      if (operation.type === "pathPaymentStrictReceive") {
        expect(operation.path).toHaveLength(2);
        expect(operation.destAmount).toBe("100.0000000");
        expect(operation.sendMax).toBe("95.0000000");
      }
    }
  });

  it("rejects an invalid intermediate asset before building an XDR", async () => {
    const result = await buildPathPayment(network.horizonUrl, network, source, {
      destination,
      sendAssetCode: "XLM",
      destAssetCode: "EURC",
      destAssetIssuer: issuer,
      amount: "100",
      sequenceNumber: "1",
      estimatedFee: "100",
      mode: "strict-send",
      path: [{ assetCode: "USDC" }], // Missing issuer
      slippageAmount: "95",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.message).toContain("issuer");
    }
  });
});
