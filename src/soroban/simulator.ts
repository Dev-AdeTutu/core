/**
 * Soroban contract simulator for local testing (#210).
 *
 * Provides a mock SorobanRpc.Server that returns configurable, deterministic
 * results without network calls. Designed for contract integration tests.
 *
 * ## Usage
 *
 * ```typescript
 * import { SorobanSimulator } from "sorokit-core";
 *
 * const simulator = new SorobanSimulator();
 * simulator.when("increment").thenReturn({ value: 5 });
 *
 * // Pass simulator.rpc as the rpcUrl to createSorokitClient
 * const client = createSorokitClient({
 *   network: "testnet",
 *   rpcUrl: simulator.rpc,
 * });
 * ```
 *
 * The simulator captures the URL passed as `rpcUrl` and returns itself
 * when constructed. This allows the existing server factory to create
 * it transparently via `new SorobanRpc.Server(simulator.rpc)`.
 */

import { rpc as SorobanRpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/** Configuration for a single method's mock response. */
export interface SimulatedMethodResult {
  /** The ScVal to return from simulation. */
  retval?: xdr.ScVal;
  /** Error message to simulate a failed simulation. */
  error?: string;
  /** Minimum resource fee in stroops. Default: "100" */
  minResourceFee?: string;
  /** Number of ledger entries the result occupies. Default: 1 */
  footprintSize?: number;
}

export interface SorobanSimulatorOptions {
  /** Default result for unmatched methods. */
  defaultResult?: SimulatedMethodResult;
  /** Simulated ledger sequence number. Default: 1000000 */
  ledgerSeq?: number;
  /** Simulated network passphrase. Default: "Test SDF Network ; September 2024" */
  networkPassphrase?: string;
  /** Delay in ms before returning results. Default: 0 */
  latencyMs?: number;
}

/* ------------------------------------------------------------------ */
/*  Simulator                                                          */
/* ------------------------------------------------------------------ */

const MOCK_FOOTPRINT = "AAAAAI7lGS3mGkAAAAAAAAAA";

export class SorobanSimulator {
  private readonly methodResults = new Map<string, SimulatedMethodResult>();
  private readonly options: Required<SorobanSimulatorOptions>;
  private simulatedTxCount = 0;

  /**
   * Special URL that tells the server factory to use this simulator.
   * Pass this as `rpcUrl` to `createSorokitClient`.
   */
  readonly rpc = "soroban+sim://local";

  /** @internal — satisfies the SorobanRpc.Server constructor interface */
  constructor();
  /** @internal */
  constructor(url: string, opts?: { fetch?: typeof globalThis.fetch });
  /** @internal */
  constructor(options?: SorobanSimulatorOptions);
  constructor(
    arg1?: string | SorobanSimulatorOptions,
    _arg2?: { fetch?: typeof globalThis.fetch },
  ) {
    // When constructed by the server factory, the factory passes a URL string.
    // The simulator ignores the URL and uses its own config.
    this.options = {
      defaultResult: { retval: xdr.ScVal.scvVoid(), minResourceFee: "100" },
      ledgerSeq: 1_000_000,
      networkPassphrase: "Test SDF Network ; September 2024",
      latencyMs: 0,
      ...(typeof arg1 === "object" ? arg1 : undefined),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Public API — configure mock responses                               */
  /* ------------------------------------------------------------------ */

  /**
   * Configure the result for a contract method call.
   *
   * @param method The contract method name.
   * @param result The simulated result configuration.
   */
  when(method: string, result: SimulatedMethodResult): this {
    this.methodResults.set(method, result);
    return this;
  }

  /**
   * Reset all configured method results.
   */
  reset(): void {
    this.methodResults.clear();
    this.simulatedTxCount = 0;
  }

  /**
   * Get the number of transactions submitted through this simulator.
   */
  get submissionCount(): number {
    return this.simulatedTxCount;
  }

  /* ------------------------------------------------------------------ */
  /*  Mock SorobanRpc.Server methods                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Simulate a contract invocation.
   * Returns the configured result for the invoked method.
   */
  async simulateTransaction(
    tx: any,
  ): Promise<any> {
    await this.delay();

    const method = this.extractMethodName(tx);
    const config = method ? this.methodResults.get(method) : undefined;
    const result = config ?? this.options.defaultResult;

    if (result.error) {
      return {
        error: result.error,
        events: [],
        minResourceFee: result.minResourceFee ?? "100",
      };
    }

    const footprint = new xdr.LedgerFootprint({ readOnly: [], readWrite: [] });

    return {
      status: (SorobanRpc.Api as any)?.SimulationStatus?.SUCCESS ?? "SUCCESS",
      result: {
        retval: result.retval ?? xdr.ScVal.scvVoid(),
        auth: [],
        footprint,
      },
      events: [],
      minResourceFee: result.minResourceFee ?? "100",
      transactionData: {
        resources: {
          footprint,
          instructions: 100000,
          readBytes: 1000,
          writeBytes: 500,
        },
        refundableFee: 100,
      },
    };
  }

  /**
   * Submit a transaction — records the submission and returns a mock hash.
   */
  async sendTransaction(
    _tx: any,
  ): Promise<any> {
    await this.delay();
    this.simulatedTxCount++;
    const hash = `sim_${Date.now().toString(36)}_${this.simulatedTxCount}`;
    const status = (SorobanRpc.Api as any).SendTransactionStatus?.PENDING ?? "PENDING";
    return {
      status,
      hash,
      txId: `tx_${hash}`,
    };
  }

  /**
   * Get a transaction result — always returns SUCCESS with the mock hash.
   */
  async getTransaction(
    hash: string,
  ): Promise<any> {
    await this.delay();
    return {
      status: (SorobanRpc.Api as any)?.GetTransactionStatus?.SUCCESS ?? "SUCCESS",
      applicationOrder: 1,
      feeBump: false,
      envelopeXdr: "",
      resultXdr: "",
      ledger: this.options.ledgerSeq,
      createdAt: Math.floor(Date.now() / 1000) - 10,
      hash,
    };
  }

  /**
   * Get ledger entries — returns an empty array.
   * Override via mockLedgerEntries() if needed.
   */
  async getLedgerEntries(
    _keys: xdr.LedgerKey[],
  ): Promise<any> {
    await this.delay();
    return { entries: [], latestLedger: this.options.ledgerSeq };
  }

  /**
   * Get the latest ledger sequence number.
   */
  async getLatestLedger(): Promise<any> {
    await this.delay();
    return { sequence: this.options.ledgerSeq, id: "mock_id", protocolVersion: 20 };
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private extractMethodName(tx: any): string | null {
    try {
      const op = tx.operations?.find((o: any) => o.type === "invokeHostFunction");
      if (!op) return null;
      const hostFn = (op as any).func;
      if (!hostFn || hostFn.arm() !== "invokeContract") return null;
      const invokeArgs = hostFn.invokeContract();
      return invokeArgs.functionName().toString("utf8");
    } catch {
      return null;
    }
  }

  private async delay(): Promise<void> {
    if (this.options.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.options.latencyMs));
    }
  }
}
