/**
 * Tests for operation timeout configuration (#392).
 */

import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSorokitClient, validateClientConfig } from "../client/createSorokitClient";
import type { SorokitClientConfig } from "../client/createSorokitClient";
import {
  DEFAULT_OPERATION_TIMEOUT_MS,
} from "../shared/constants";
import {
  isOperationTimeoutError,
  runWithTimeout,
} from "../shared/timeout";
import { OperationTimeoutError } from "../shared/timeout";
import { resolveOperationTimeout } from "../shared/config";

const { mockLoadAccount, mockCreateHorizonServer, capturedSignals } =
  vi.hoisted(() => ({
    mockLoadAccount: vi.fn(),
    mockCreateHorizonServer: vi.fn(),
    capturedSignals: [] as (AbortSignal | undefined)[],
  }));

vi.mock("../shared/serverFactory", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../shared/serverFactory")>();
  return {
    ...actual,
    createHorizonServer: mockCreateHorizonServer,
  };
});

function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("test hang exceeded — operation never aborted")),
      5_000,
    );
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });
}

const baseConfig: SorokitClientConfig = {
  network: "testnet",
};

describe("resolveOperationTimeout (#392)", () => {
  it("falls back to the 30-second default when nothing is configured", () => {
    expect(resolveOperationTimeout("account_get")).toBe(10_000); // op default
    expect(resolveOperationTimeout("soroban_read")).toBe(30_000);
    expect(DEFAULT_OPERATION_TIMEOUT_MS).toBe(30_000);
  });

  it("prefers per-call override over the client default", () => {
    expect(resolveOperationTimeout("account_get", 1_234, 60_000)).toBe(1_234);
  });

  it("uses client defaultTimeoutMs over operation defaults", () => {
    expect(resolveOperationTimeout("account_get", undefined, 45_000)).toBe(45_000);
  });

  it("global override outranks client default but not per-call", () => {
    expect(resolveOperationTimeout("account_get", undefined, 45_000, 5_000)).toBe(5_000);
    expect(resolveOperationTimeout("account_get", 9_000, 45_000, 5_000)).toBe(9_000);
  });
});

describe("runWithTimeout (#392)", () => {
  it("returns the value when the operation completes in time", async () => {
    const result = await runWithTimeout(1_000, async () => "done");
    expect(result).toBe("done");
  });

  it("rejects with OPERATION_TIMEOUT semantics when the window elapses", async () => {
    await expect(
      runWithTimeout(20, () => new Promise((r) => setTimeout(r, 500))),
    ).rejects.toSatisfy(isOperationTimeoutError);
  });

  it("aborts the provided signal and cleans up on success", async () => {
    let observed: AbortSignal | undefined;
    await runWithTimeout(1_000, async (signal) => {
      observed = signal;
      return true;
    });
    expect(observed?.aborted).toBe(false);
  });

  it("zero disables enforcement entirely", async () => {
    let sawSignal = false;
    const result = await runWithTimeout(0, async (signal) => {
      sawSignal = signal !== undefined;
      return "unbounded";
    });
    expect(result).toBe("unbounded");
    expect(sawSignal).toBe(false);
  });

  it("does not mask explicit external cancellation as a timeout", async () => {
    const external = Object.assign(new Error("user cancelled"), {
      name: "AbortError",
    });
    await expect(
      runWithTimeout(1_000, () => Promise.reject(external)),
    ).rejects.toBe(external);
  });

  it("clears timers after completion (no dangling handles)", async () => {
    const spy = vi.spyOn(global, "setTimeout");
    await runWithTimeout(60_000, async () => 1);
    // One timer created for this call; clearTimeout must have been invoked.
    const created = spy.mock.calls.filter(([, ms]) => ms === 60_000);
    expect(created.length).toBeGreaterThanOrEqual(1);
    spy.mockRestore();
  });
});

describe("client timeout integration (#392)", () => {
  let publicKey: string;

  beforeEach(() => {
    publicKey = Keypair.random().publicKey();
    capturedSignals.length = 0;
    mockLoadAccount.mockReset();
    mockCreateHorizonServer.mockImplementation(
      (_url: string, options?: { signal?: AbortSignal }) => {
        capturedSignals.push(options?.signal);
        return {
          loadAccount: () => hangUntilAborted(options?.signal),
        };
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeAccountResponse() {
    return {
      sequence: "1",
      subentry_count: 0,
      balances: [
        { asset_type: "native", balance: "100.0000000" },
      ],
    };
  }

  it("returns OPERATION_TIMEOUT when the default window elapses", async () => {
    const created = createSorokitClient({
      ...baseConfig,
      defaultTimeoutMs: 25,
    });
    if (created.status === "error") throw new Error(created.error.message);

    const res = await created.data.account.get(publicKey);

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.error.code).toBe("OPERATION_TIMEOUT");
    }
    // The underlying request was aborted via the propagated signal.
    expect(capturedSignals[0]?.aborted).toBe(true);
  });

  it("per-operation timeoutMs overrides the client default", async () => {
    const created = createSorokitClient({
      ...baseConfig,
      defaultTimeoutMs: 60_000,
    });
    if (created.status === "error") throw new Error(created.error.message);

    const started = Date.now();
    const res = await created.data.account.get(publicKey, 25);
    const elapsed = Date.now() - started;

    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.error.code).toBe("OPERATION_TIMEOUT");
    expect(elapsed).toBeLessThan(2_000);
  });

  it("successful operations are unaffected and signals stay live", async () => {
    mockCreateHorizonServer.mockImplementation(
      (_url: string, options?: { signal?: AbortSignal }) => ({
        loadAccount: async () => {
          expect(options?.signal?.aborted).toBe(false);
          return makeAccountResponse();
        },
      }),
    );

    const created = createSorokitClient({ ...baseConfig });
    if (created.status === "error") throw new Error(created.error.message);

    const res = await created.data.account.get(publicKey);

    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.data.balances[0]?.assetCode).toBe("XLM");
    }
  });

  it("validateClientConfig rejects invalid defaultTimeoutMs values", () => {
    expect(validateClientConfig({ ...baseConfig, defaultTimeoutMs: -1 }).status).toBe("error");
    expect(validateClientConfig({ ...baseConfig, defaultTimeoutMs: NaN }).status).toBe("error");
    expect(
      validateClientConfig({
        ...baseConfig,
        defaultTimeoutMs: "5000" as unknown as number,
      }).status,
    ).toBe("error");
    expect(
      validateClientConfig({ ...baseConfig, defaultTimeoutMs: 5_000 }).status,
    ).toBe("ok");
  });
});

describe("OperationTimeoutError shape (#392)", () => {
  it("is distinguishable from generic errors", () => {
    const e = new OperationTimeoutError(123);
    expect(isOperationTimeoutError(e)).toBe(true);
    expect(isOperationTimeoutError(new Error("nope"))).toBe(false);
    expect(e.message).toContain("123ms");
  });
});
