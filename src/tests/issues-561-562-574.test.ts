import { afterEach, describe, expect, it, vi } from "vitest";
import { streamTransactionsSSE } from "../transaction/streamTransactionsSSE";
import { ConnectionPool } from "../network/connectionPool";
import { Counter, Timer, clearMetrics, getMetrics } from "../shared/metrics";
import { ok } from "../shared/response";

afterEach(() => {
  vi.restoreAllMocks();
  clearMetrics();
});

describe("issue #561: Horizon SSE transaction stream", () => {
  it("parses events and preserves the paging cursor", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: transaction\ndata: {"hash":"abc","successful":true,"paging_token":"42"}\n\n',
        ));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));

    const results = [];
    for await (const result of streamTransactionsSSE("https://horizon.example", "GABC", {}, { fallback: (async function* () { yield ok({ transactions: [], nextCursor: null }); })() })) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("ok");
    if (results[0]?.status === "ok") {
      expect(results[0].data.transactions[0]?.hash).toBe("abc");
      expect(results[0].data.nextCursor).toBe("42");
    }
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/accounts/GABC/transactions?stream=true"),
      expect.objectContaining({ headers: { Accept: "text/event-stream" } }),
    );
  });

  it("falls back when Horizon does not offer SSE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 406 })));
    const fallback = (async function* () {
      yield ok({ transactions: [], nextCursor: null });
    })();
    const results = [];
    for await (const result of streamTransactionsSSE("https://horizon.example", "GABC", {}, { fallback })) results.push(result);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("ok");
  });
});

describe("issue #562: connection pool", () => {
  it("limits concurrent requests for each origin and exposes stats", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximum = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return new Response("ok");
    });
    const pool = new ConnectionPool({ maxPoolSize: 1, keepAliveTimeoutMs: 0 }, fetchImpl);
    const first = pool.fetch("https://horizon.example/a");
    const second = pool.fetch("https://horizon.example/b");
    await Promise.resolve();
    expect(pool.stats()[0]?.queued).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    pool.close();
  });
});

describe("issue #574: metrics primitives", () => {
  it("counts events and records timer durations", () => {
    const counter = new Counter("cache.hit");
    counter.increment();
    counter.increment(2);
    expect(counter.value).toBe(3);
    const timer = new Timer("request.test");
    expect(timer.stop()).toBeGreaterThanOrEqual(0);
    expect(getMetrics({ operation: "request.test" })[0]?.count).toBe(1);
  });
});
