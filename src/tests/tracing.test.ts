import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createTraceContext,
  createTracedFetch,
  getTraceContext,
  setTraceContext,
  createAutoTracedFetch,
  type TraceContext,
} from "../shared/tracing";

describe("createTraceContext", () => {
  it("generates a traceId when not provided", () => {
    const ctx = createTraceContext();
    expect(ctx.traceId).toBeDefined();
    expect(ctx.traceId.length).toBeGreaterThan(0);
    expect(ctx.spanId).toBeDefined();
    expect(ctx.spanId.length).toBe(16); // 8 bytes = 16 hex chars
  });

  it("uses the provided traceId", () => {
    const ctx = createTraceContext("my-custom-id");
    expect(ctx.traceId).toBe("my-custom-id");
  });

  it("accepts parentSpanId", () => {
    const ctx = createTraceContext("t1", { parentSpanId: "parent-123" });
    expect(ctx.parentSpanId).toBe("parent-123");
  });

  it("accepts tags", () => {
    const tags = { env: "test", version: "1" };
    const ctx = createTraceContext(undefined, { tags });
    expect(ctx.tags).toEqual(tags);
  });

  it("generates unique spanIds across calls", () => {
    const ctx1 = createTraceContext();
    const ctx2 = createTraceContext();
    expect(ctx1.spanId).not.toBe(ctx2.spanId);
  });
});

describe("getTraceContext / setTraceContext", () => {
  beforeEach(() => setTraceContext(null));
  afterEach(() => setTraceContext(null));

  it("returns null when no context is set", () => {
    expect(getTraceContext()).toBeNull();
  });

  it("returns the set context", () => {
    const ctx = createTraceContext("test-id");
    setTraceContext(ctx);
    expect(getTraceContext()).toEqual(ctx);
  });
});

describe("createTracedFetch", () => {
  it("injects x-correlation-id header", async () => {
    const ctx = createTraceContext("corr-123");
    const tracedFetch = createTracedFetch(ctx);

    const mockFetch = vi.fn().mockResolvedValue(new Response());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      await tracedFetch("https://example.com/api");
      const [input, init] = mockFetch.mock.calls[0];
      const headers = init?.headers as Headers;
      expect(headers.get("x-correlation-id")).toBe("corr-123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("injects traceparent header in W3C format", async () => {
    const ctx = createTraceContext("abcdef1234567890abcdef1234567890");
    const tracedFetch = createTracedFetch(ctx);

    const mockFetch = vi.fn().mockResolvedValue(new Response());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      await tracedFetch("https://example.com/api");
      const [input, init] = mockFetch.mock.calls[0];
      const headers = init?.headers as Headers;
      const traceparent = headers.get("traceparent") as string;
      expect(traceparent).toMatch(/^00-[a-f0-9]+-[a-f0-9]+-01$/);
      expect(traceparent).toContain(ctx.traceId);
      expect(traceparent).toContain(ctx.spanId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("injects x-span-id header", async () => {
    const ctx = createTraceContext("span-test");
    const tracedFetch = createTracedFetch(ctx);

    const mockFetch = vi.fn().mockResolvedValue(new Response());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      await tracedFetch("https://example.com/api");
      const [input, init] = mockFetch.mock.calls[0];
      const headers = init?.headers as Headers;
      expect(headers.get("x-span-id")).toBe(ctx.spanId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not overwrite existing traceparent header", async () => {
    const ctx = createTraceContext("ctx-1");
    const tracedFetch = createTracedFetch(ctx);

    const mockFetch = vi.fn().mockResolvedValue(new Response());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const existingHeaders = new Headers({ traceparent: "00-existing-0000000000000000-01" });
      await tracedFetch("https://example.com/api", { headers: existingHeaders });
      const [input, init] = mockFetch.mock.calls[0];
      const headers = init?.headers as Headers;
      expect(headers.get("traceparent")).toBe("00-existing-0000000000000000-01");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes through to the real fetch and returns a response", async () => {
    const ctx = createTraceContext("real-fetch");
    const tracedFetch = createTracedFetch(ctx);

    const mockResponse = new Response("ok", { status: 200 });
    const mockFetch = vi.fn().mockResolvedValue(mockResponse);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const response = await tracedFetch("https://example.com/api");
      expect(response).toBe(mockResponse);
      expect(response.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("createAutoTracedFetch", () => {
  it("returns a fetch function and a context", () => {
    const { fetch, context } = createAutoTracedFetch();
    expect(typeof fetch).toBe("function");
    expect(context.traceId).toBeDefined();
    expect(context.spanId).toBeDefined();
  });

  it("accepts tags", () => {
    const { context } = createAutoTracedFetch({ env: "test" });
    expect(context.tags).toEqual({ env: "test" });
  });

  it("injects headers via the returned fetch", async () => {
    const { fetch: tracedFetch, context } = createAutoTracedFetch();

    const mockFetch = vi.fn().mockResolvedValue(new Response());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      await tracedFetch("https://example.com/api");
      const [input, init] = mockFetch.mock.calls[0];
      const headers = init?.headers as Headers;
      expect(headers.get("x-correlation-id")).toBe(context.traceId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
