import { describe, it, expect, vi } from "vitest";
import { SigningRateLimiter } from "../wallet/signingRateLimiter";
import { signTransaction } from "../wallet/signTransaction";
import { ok, SorokitErrorCode } from "../shared/response";
import type { WalletAdapter } from "../wallet/types";

describe("SigningRateLimiter (#404)", () => {
  const mockAdapter: WalletAdapter = {
    walletType: "freighter" as any,
    isAvailable: () => true,
    connect: async () => ok("G123"),
    disconnect: async () => ok(undefined),
    signTransaction: async (input) => ok(`signed-${input.transactionXdr}`),
  };

  it("throttles request execution rate according to configuration", async () => {
    const limiter = new SigningRateLimiter({ requestsPerSecond: 10 }); // 100ms interval
    const start = Date.now();

    const p1 = limiter.enqueue(async () => ok("tx1")).promise;
    const p2 = limiter.enqueue(async () => ok("tx2")).promise;

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  it("maintains FIFO request queue order", async () => {
    const limiter = new SigningRateLimiter({ requestsPerSecond: 100 });
    const order: string[] = [];

    const p1 = limiter.enqueue(async () => {
      order.push("1");
      return ok("1");
    }).promise;

    const p2 = limiter.enqueue(async () => {
      order.push("2");
      return ok("2");
    }).promise;

    await Promise.all([p1, p2]);
    expect(order).toEqual(["1", "2"]);
  });

  it("exposes queue length and position to callers", () => {
    const limiter = new SigningRateLimiter({ requestsPerSecond: 0.1 }); // Very slow

    const req1 = limiter.enqueue(async () => ok("1"));
    const req2 = limiter.enqueue(async () => ok("2"));

    expect(limiter.getQueueState().queueLength).toBeGreaterThanOrEqual(1);
    expect(limiter.getPosition(req2.requestId)).toBeGreaterThanOrEqual(1);

    limiter.clear();
  });

  it("supports request cancellation", async () => {
    const limiter = new SigningRateLimiter({ requestsPerSecond: 0.1 });

    const req1 = limiter.enqueue(async () => ok("1"));
    const req2 = limiter.enqueue(async () => ok("2"));

    const cancelled = limiter.cancel(req2.requestId, "User cancelled");
    expect(cancelled).toBe(true);

    const res2 = await req2.promise;
    expect(res2.status).toBe("error");
    expect(res2.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
    expect(res2.error.message).toBe("User cancelled");

    limiter.clear();
  });

  it("integrates seamlessly with signTransaction function", async () => {
    const limiter = new SigningRateLimiter({ requestsPerSecond: 50 });

    const res = await signTransaction(
      mockAdapter,
      { transactionXdr: "AAAA", networkPassphrase: "test" },
      undefined,
      limiter,
    );

    expect(res.status).toBe("ok");
    expect(res.data).toBe("signed-AAAA");
  });
});
