/**
 * Distributed tracing support with correlation IDs (#212).
 *
 * Provides trace context management and a custom fetch wrapper that injects
 * OpenTelemetry-compatible correlation headers into every outgoing HTTP request.
 * Designed to work with the existing `traceId` infrastructure in the logger
 * and error system while adding wire-level propagation.
 *
 * ## Headers injected
 *
 * | Header | Source | Example |
 * |--------|--------|---------|
 * | `x-correlation-id` | `context.traceId` | `"7f3c..."` |
 * | `traceparent` | W3C Trace Context | `"00-<traceId>-<spanId>-01"` |
 * | `x-span-id` | `context.spanId` | `"a1b2..."` |
 *
 * ## Usage
 *
 * ```typescript
 * import { createTraceContext, createTracedFetch } from "./tracing";
 *
 * const ctx = createTraceContext("my-trace-id");
 * const tracedFetch = createTracedFetch(ctx);
 *
 * // Pass tracedFetch to Horizon.Server and SorobanRpc.Server:
 * const horizon = new Horizon.Server(url, { fetch: tracedFetch });
 * ```
 */

import { generateTraceId } from "./utils";
import { randomBytes } from "crypto";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

/**
 * Trace context for a single operation flow.
 * Follows the W3C Trace Context specification where possible.
 */
export interface TraceContext {
  /** Globally unique trace identifier (128-bit hex). */
  readonly traceId: string;
  /** Span identifier for the current operation (64-bit hex). */
  readonly spanId: string;
  /** Optional parent span identifier for nested operations. */
  readonly parentSpanId?: string;
  /** Tags for filtering and searching traces. */
  readonly tags?: Record<string, string>;
}

export interface TraceContextOptions {
  parentSpanId?: string;
  tags?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/*  Singleton current context                                          */
/* ------------------------------------------------------------------ */

let currentContext: TraceContext | null = null;

/**
 * Get the current trace context (if any).
 * Returns null if no context has been set.
 */
export function getTraceContext(): TraceContext | null {
  return currentContext;
}

/**
 * Set the current trace context.
 * This is called internally by `createTracedFetch` and should not normally
 * need to be called directly by consumers.
 */
export function setTraceContext(context: TraceContext | null): void {
  currentContext = context;
}

/* ------------------------------------------------------------------ */
/*  Context creation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Create a new trace context.
 *
 * @param traceId Optional explicit trace ID; generated if omitted.
 * @param options Optional parent span ID and tags.
 */
export function createTraceContext(
  traceId?: string,
  options: TraceContextOptions = {},
): TraceContext {
  const id = traceId ?? generateTraceId();
  const spanId = generateSpanId();
  return {
    traceId: id,
    spanId,
    ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
    ...(options.tags !== undefined ? { tags: options.tags } : {}),
  };
}

/**
 * Generate a 64-bit hex span identifier.
 */
function generateSpanId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(8);
    c.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  const bytes = randomBytes(8);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------------------------------------------ */
/*  Traced fetch wrapper                                               */
/* ------------------------------------------------------------------ */

/**
 * W3C Trace Context header name.
 */
const TRACEPARENT_HEADER = "traceparent";

/**
 * Correlation ID header name (platform-agnostic).
 */
const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * Span ID header (proprietary, for easy lookup).
 */
const SPAN_ID_HEADER = "x-span-id";

/**
 * Wrap the global `fetch` function to inject tracing headers into every
 * outgoing HTTP request.
 *
 * @param context The trace context to inject.
 * @returns A fetch-compatible function that adds correlation headers.
 *
 * @example
 * ```typescript
 * const ctx = createTraceContext();
 * const fetch = createTracedFetch(ctx);
 * const horizon = new Horizon.Server(url, { fetch });
 * ```
 */
export function createTracedFetch(context: TraceContext): typeof fetch {
  const traceId = context.traceId;
  const spanId = context.spanId;

  // W3C traceparent: version-traceId-spanId-traceFlags
  const traceparent = `00-${traceId}-${spanId}-01`;

  return async function tracedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);

    // Inject correlation ID header
    if (!headers.has(CORRELATION_ID_HEADER)) {
      headers.set(CORRELATION_ID_HEADER, traceId);
    }

    // Inject W3C traceparent header
    if (!headers.has(TRACEPARENT_HEADER)) {
      headers.set(TRACEPARENT_HEADER, traceparent);
    }

    // Inject span ID for quick reference
    if (!headers.has(SPAN_ID_HEADER)) {
      headers.set(SPAN_ID_HEADER, spanId);
    }

    // Set current context so getTraceContext() works during request processing
    setTraceContext(context);

    try {
      return await globalThis.fetch(input, { ...init, headers });
    } finally {
      // Don't clear context here — it persists for the operation lifecycle
    }
  };
}

/**
 * Create a fetch wrapper that generates a new trace context automatically.
 * Convenience for consumers who don't need to manage context externally.
 */
export function createAutoTracedFetch(tags?: Record<string, string>): {
  fetch: typeof fetch;
  context: TraceContext;
} {
  const context = createTraceContext(undefined, tags !== undefined ? { tags } : {});
  return { fetch: createTracedFetch(context), context };
}
