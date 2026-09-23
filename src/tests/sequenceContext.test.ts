/**
 * Tests for the sequence-aware transaction context (#394).
 *
 * Uses the real TransactionBuilder/Account (offline) — only the Horizon
 * account loader is mocked, so built XDR can be decoded to assert sequences.
 */

import {
  Keypair,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTransactionContext } from "../transaction/transactionContext";
import type { ResolvedNetworkConfig } from "../shared/types";
import { SorokitErrorCode } from "../shared/response";

const { mockLoadAccount, networkSequences } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  // Mutable on-ledger sequence per public key, read by loadAccount.
  networkSequences: new Map<string, string>(),
}));

vi.mock("../shared/serverFactory", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../shared/serverFactory")>();
  return {
    ...actual,
    createHorizonServer: () => ({
      loadAccount: mockLoadAccount.mockImplementation(
        (publicKey: string) => {
          const seq =
            networkSequences.get(publicKey) ?? "0";
          return Promise.resolve({
            sequenceNumber: () => seq,
            sequence: seq,
            balances: [],
          });
        },
      ),
    }),
  };
});

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

function sourceKeypair(): Keypair {
  return Keypair.random();
}

function setNetworkSequence(publicKey: string, seq: string | number): void {
  networkSequences.set(publicKey, String(seq));
}

function sequenceOf(xdr: string): string {
  return TransactionBuilder.fromXDR(xdr, networkConfig.networkPassphrase)
    .sequence;
}

function paymentParams(destination: string) {
  return { destination, amount: "10" };
}

describe("createTransactionContext (#394)", () => {
  let keypair: Keypair;
  let destination: string;

  beforeEach(() => {
    mockLoadAccount.mockReset();
    networkSequences.clear();
    keypair = sourceKeypair();
    destination = Keypair.random().publicKey();
    setNetworkSequence(keypair.publicKey(), 100);
  });

  it("assigns the fetched sequence to a single build", async () => {
    const ctxResult = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      keypair.publicKey(),
    );
    if (ctxResult.status === "error") throw new Error(ctxResult.error.message);
    const ctx = ctxResult.data;

    const build = await ctx.buildPayment(paymentParams(destination));
    expect(build.status).toBe("ok");
    if (build.status === "ok") {
      // SDK semantics: tx.sequence == source account sequence + 1.
      expect(sequenceOf(build.data)).toBe("101");
    }
    expect(ctx.peekNextSequence()).toBe("101");
  });

  it("increments the cached sequence for sequential builds without refetching", async () => {
    const ctxResult = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      keypair.publicKey(),
    );
    if (ctxResult.status === "error") throw new Error(ctxResult.error.message);
    const ctx = ctxResult.data;

    const builds = [
      await ctx.buildPayment(paymentParams(destination)),
      await ctx.buildPayment(paymentParams(destination)),
      await ctx.buildCreateAccount({ destination, startingBalance: "1" }),
      await ctx.buildTrustline({
        assetCode: "USDC",
        assetIssuer: Keypair.random().publicKey(),
      }),
    ];
    for (const b of builds) expect(b.status).toBe("ok");

    const sequences = builds.map((b) =>
      b.status === "ok" ? sequenceOf(b.data) : "",
    );
    expect(sequences).toEqual(["101", "102", "103", "104"]);

    // One fetch at creation; no repeated Horizon round trips for builds.
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });

  it("gives concurrent builds unique, increasing sequences", async () => {
    const ctxResult = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      keypair.publicKey(),
    );
    if (ctxResult.status === "error") throw new Error(ctxResult.error.message);
    const ctx = ctxResult.data;

    const results = await Promise.all([
      ctx.buildPayment(paymentParams(destination)),
      ctx.buildPayment(paymentParams(destination)),
      ctx.buildPayment(paymentParams(destination)),
    ]);

    for (const r of results) expect(r.status).toBe("ok");
    const sequences = results.map((r) =>
      r.status === "ok" ? sequenceOf(r.data) : "",
    );
    expect(new Set(sequences).size).toBe(3); // all unique
    expect(sequences).toEqual(["101", "102", "103"]);
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });

  it("does not consume a sequence when a build fails", async () => {
    const ctxResult = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      keypair.publicKey(),
    );
    if (ctxResult.status === "error") throw new Error(ctxResult.error.message);
    const ctx = ctxResult.data;

    // An invalid destination makes the SDK throw inside the try block —
    // the allocated sequence must not be consumed by a failed build.
    const failed = await ctx.buildPayment({
      destination: "not-a-valid-key",
      amount: "10",
    });
    expect(failed.status).toBe("error");

    expect(ctx.peekNextSequence()).toBe("100");

    const next = await ctx.buildPayment(paymentParams(destination));
    if (next.status === "ok") expect(sequenceOf(next.data)).toBe("101");
  });

  describe("validateFreshSequence", () => {
    it("passes when the network matches the context state", async () => {
      const ctxResult = await createTransactionContext(
        networkConfig.horizonUrl,
        networkConfig,
        keypair.publicKey(),
      );
      if (ctxResult.status === "error") throw new Error(ctxResult.error.message);
      const ctx = ctxResult.data;

      const check = await ctx.validateFreshSequence();
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.data.valid).toBe(true);
        expect(check.data.expectedSequence).toBe("100");
        expect(check.data.networkSequence).toBe("100");
      }
    });

    it("reports informational staleness (no throw) when a pending tx has not landed yet", async () => {
      const ctxResult = await createTransactionContext(
        networkConfig.horizonUrl,
        networkConfig,
        keypair.publicKey(),
      );
      if (ctxResult.status === "error") throw new Error(ctxResult.error.message);
      const ctx = ctxResult.data;

      await ctx.buildPayment(paymentParams(destination)); // next = 101
      // Ledger still at 100 — expected for an unsubmitted tx; not a conflict.
      const check = await ctx.validateFreshSequence();
      expect(check.status).toBe("ok");
      if (check.status === "ok") {
        expect(check.data.valid).toBe(false);
        expect(check.data.expectedSequence).toBe("101");
        expect(check.data.networkSequence).toBe("100");
      }
    });

    it("detects a stale context when another transaction consumed the sequence", async () => {
      const publicKey = keypair.publicKey();
      const ctxResult = await createTransactionContext(
        networkConfig.horizonUrl,
        networkConfig,
        publicKey,
      );
      if (ctxResult.status === "error") throw new Error(ctxResult.error.message);
      const ctx = ctxResult.data;

      const first = await ctx.buildPayment(paymentParams(destination));
      if (first.status !== "ok") throw new Error("build failed");
      // tx built with sequence 100; context now expects 101

      // An external actor submits and advances the ledger past our pending tx.
      setNetworkSequence(publicKey, 105);

      const check = await ctx.validateFreshSequence();
      expect(check.status).toBe("error");
      if (check.status === "error") {
        expect(check.error.code).toBe(SorokitErrorCode.TX_SEQUENCE_CONFLICT);
        const detail = check.error.cause as {
          expectedSequence: string;
          networkSequence: string;
        };
        expect(detail.expectedSequence).toBe("101");
        expect(detail.networkSequence).toBe("105");
      }
    });
  });

  describe("reset", () => {
    it("adopts an advanced network sequence without regressing below assigned ones", async () => {
      const publicKey = keypair.publicKey();
      const ctxResult = await createTransactionContext(
        networkConfig.horizonUrl,
        networkConfig,
        publicKey,
      );
      if (ctxResult.status === "error") throw new Error(ctxResult.error.message);
      const ctx = ctxResult.data;

      await ctx.buildPayment(paymentParams(destination)); // uses 100 → next 101

      // Network moved ahead of both the ledger and this context.
      setNetworkSequence(publicKey, 110);
      const reset = await ctx.reset();
      expect(reset.status).toBe("ok");
      expect(ctx.peekNextSequence()).toBe("110");

      const rebuilt = await ctx.buildPayment(paymentParams(destination));
      if (rebuilt.status === "ok") expect(sequenceOf(rebuilt.data)).toBe("111");
    });

    it("never regresses below already-assigned sequences", async () => {
      const publicKey = keypair.publicKey();
      const ctxResult = await createTransactionContext(
        networkConfig.horizonUrl,
        networkConfig,
        publicKey,
      );
      if (ctxResult.status === "error") throw new Error(ctxResult.error.message);
      const ctx = ctxResult.data;

      await ctx.buildPayment(paymentParams(destination)); // next = 101

      // Ledger still reports the pre-build value.
      const reset = await ctx.reset();
      expect(reset.status).toBe("ok");
      expect(ctx.peekNextSequence()).toBe("101"); // kept, not regressed to 100
    });
  });

  it("invalidate forces a re-fetch on the next build", async () => {
    const publicKey = keypair.publicKey();
    const ctxResult = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      publicKey,
    );
    if (ctxResult.status === "error") throw new Error(ctxResult.error.message);
    const ctx = ctxResult.data;
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);

    ctx.invalidate();
    setNetworkSequence(publicKey, 200);

    const build = await ctx.buildPayment(paymentParams(destination));
    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    if (build.status === "ok") expect(sequenceOf(build.data)).toBe("201");
  });

  it("propagates account-load failures as TX_BUILD_FAILED", async () => {
    mockLoadAccount.mockRejectedValueOnce(new Error("horizon down"));

    const result = await createTransactionContext(
      networkConfig.horizonUrl,
      networkConfig,
      keypair.publicKey(),
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
    }
  });
});
