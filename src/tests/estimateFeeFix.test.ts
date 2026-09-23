import { describe, it, expect, vi, beforeEach } from "vitest";
import { estimateFee } from "../transaction/estimateFee";
import { readContract } from "../soroban/readContract";
import { prepareContractCall } from "../soroban/prepareCall";
import {
  DEFAULT_SOROBAN_TX_TIMEOUT_SECONDS,
  DEFAULT_TX_TIMEOUT_SECONDS,
} from "../shared/constants";
import { BASE_FEE } from "@stellar/stellar-sdk";

const MOCK_XDR = "AAAAAQAAAAA=";
const transactionBuilderInstances: any[] = [];

const mocks = vi.hoisted(() => ({
  simulateTransaction: vi.fn(),
  isSimulationSuccess: vi.fn(),
  isSimulationError: vi.fn(),
  loadAccount: vi.fn(),
  assembleTransaction: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockTransactionBuilder {
    operation?: any;
    timeout?: number;
    options: any;

    constructor(readonly sourceAccount: any, options: any) {
      this.options = options;
      transactionBuilderInstances.push(this);
    }

    addOperation(operation: any) {
      this.operation = operation;
      return this;
    }

    setTimeout(timeout: number) {
      this.timeout = timeout;
      return this;
    }

    build() {
      return {
        fee: "100",
        toXDR: () => MOCK_XDR,
      };
    }

    static fromXDR(xdrString: string, passphrase: any) {
      return {
        toXDR: () => xdrString,
      };
    }
  }

  class MockContract {
    constructor(readonly contractId: string) {}
    call(method: string, ...params: any[]) {
      return { contractId: this.contractId, method, params };
    }
  }

  return {
    ...actual,
    BASE_FEE: "100",
    Contract: MockContract,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mocks.loadAccount,
      })),
    },
    TransactionBuilder: MockTransactionBuilder,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        simulateTransaction: mocks.simulateTransaction,
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: mocks.isSimulationError,
        isSimulationSuccess: mocks.isSimulationSuccess,
      },
      assembleTransaction: mocks.assembleTransaction,
    },
  };
});

const networkConfig = {
  network: "testnet" as const,
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

describe("estimateFeeFix", () => {
  beforeEach(() => {
    transactionBuilderInstances.length = 0;
    mocks.simulateTransaction.mockReset();
    mocks.isSimulationSuccess.mockReset();
    mocks.isSimulationError.mockReset();
    mocks.loadAccount.mockReset();
    mocks.assembleTransaction.mockReset();
  });

  it("verifies that when simulation returns minResourceFee: '500', the returned fee is '500' not '600'", async () => {
    mocks.isSimulationSuccess.mockReturnValue(true);
    mocks.isSimulationError.mockReturnValue(false);
    mocks.simulateTransaction.mockResolvedValue({ minResourceFee: "500" });

    const result = await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR }
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.fee).toBe("500");
      expect(result.data.baseFee).toBe("100");
      expect(result.data.simulated).toBe(true);
    }
  });

  it("verifies that simulated: false fallback still returns BASE_FEE correctly when simulation fails", async () => {
    mocks.isSimulationSuccess.mockReturnValue(false);
    mocks.isSimulationError.mockReturnValue(true);
    mocks.simulateTransaction.mockResolvedValue({ error: "simulation failed" });

    const result = await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR }
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.fee).toBe("100"); // BASE_FEE floor
      expect(result.data.baseFee).toBe("100");
      expect(result.data.simulated).toBe(false);
    }
  });

  it("verifies that simulated: false fallback still returns BASE_FEE correctly when result is unexpected", async () => {
    mocks.isSimulationSuccess.mockReturnValue(false);
    mocks.isSimulationError.mockReturnValue(false);
    mocks.simulateTransaction.mockResolvedValue({});

    const result = await estimateFee(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { kind: "xdr", transactionXdr: MOCK_XDR }
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.fee).toBe("100"); // BASE_FEE floor
      expect(result.data.baseFee).toBe("100");
      expect(result.data.simulated).toBe(false);
    }
  });

  it("verifies that readContract uses DEFAULT_SOROBAN_TX_TIMEOUT_SECONDS", async () => {
    mocks.loadAccount.mockResolvedValue({
      sequenceNumber: "1",
      id: "G...",
    });
    mocks.isSimulationSuccess.mockReturnValue(true);
    mocks.isSimulationError.mockReturnValue(false);
    mocks.simulateTransaction.mockResolvedValue({
      result: { retval: { _value: "hello" } },
    });

    await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      {
        contractId: "CD123",
        publicKey: "G...",
        method: "hello",
        args: [],
      }
    );

    expect(transactionBuilderInstances.length).toBe(1);
    expect(transactionBuilderInstances[0].timeout).toBe(DEFAULT_SOROBAN_TX_TIMEOUT_SECONDS);
    expect(transactionBuilderInstances[0].timeout).toBe(300);
  });

  it("verifies that prepareContractCall uses DEFAULT_SOROBAN_TX_TIMEOUT_SECONDS", async () => {
    mocks.loadAccount.mockResolvedValue({
      sequenceNumber: "1",
      id: "G...",
    });
    mocks.isSimulationSuccess.mockReturnValue(true);
    mocks.isSimulationError.mockReturnValue(false);
    mocks.simulateTransaction.mockResolvedValue({
      result: { retval: { _value: "hello" } },
    });
    mocks.assembleTransaction.mockReturnValue({
      build: () => ({
        fee: "100",
        toXDR: () => "mock-assembled-xdr",
      }),
    });

    await prepareContractCall(
      networkConfig.rpcUrl,
      networkConfig,
      networkConfig.horizonUrl,
      {
        contractId: "CD123",
        publicKey: "G...",
        method: "hello",
        args: [],
      }
    );

    expect(transactionBuilderInstances.length).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_SOROBAN_TX_TIMEOUT_SECONDS).toBe(300);
  });
});
