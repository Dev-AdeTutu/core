/**
 * Tests for the circuit breaker pattern (Issue #186).
 *
 * Covers all state transitions:
 *   CLOSED → OPEN on 5 consecutive transient failures
 *   OPEN   → HALF_OPEN after recovery window
 *   HALF_OPEN → CLOSED on successful probe
 *   HALF_OPEN → OPEN on failed probe
 *
 * Also verifies:
 *   - Fail-fast in OPEN state (no fn call)
 *   - Non-transient errors do NOT trip the circuit
 *   - Metrics track transitions correctly
 *   - CircuitBreakerRegistry creates and reuses breakers per endpoint
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitOpenError,
} from "../network/circuitBreaker";

const ENDPOINT = "https://soroban-testnet.stellar.org";

/** A transient network error (5xx-like) that trips the circuit. */
function transientError(): Error {
  return Object.assign(new Error("Service Unavailable"), {
    response: { status: 503 },
  });
}

/** A permanent error (4xx) that should NOT trip the circuit. */
function permanentError(): Error {
  return Object.assign(new Error("Bad Request"), {
    response: { status: 400 },
  });
}

/** Async fn that always rejects with the given error. */
function alwaysFails(error: Error) {
  return () => Promise.reject(error);
}

/** Async fn that always resolves with the given value. */
function alwaysSucceeds<T>(value: T) {
  return () => Promise.resolve(value);
}

// ─── CircuitBreaker ───────────────────────────────────────────────────────────

describe("CircuitBreaker — state transitions", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker(ENDPOINT, { failureThreshold: 5, recoveryWindowMs: 60_000 });
  });

  it("starts in CLOSED state", () => {
    expect(cb.currentState).toBe("CLOSED");
  });

  it("stays CLOSED after fewer than threshold consecutive failures", async () => {
    for (let i = 0; i < 4; i++) {
      await expect(cb.call(alwaysFails(transientError()))).rejects.toThrow();
    }
    expect(cb.currentState).toBe("CLOSED");
  });

  it("CLOSED → OPEN after 5 consecutive transient failures", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(cb.call(alwaysFails(transientError()))).rejects.toThrow();
    }
    expect(cb.currentState).toBe("OPEN");
  });

  it("resets consecutive failure count on a success — does not open prematurely", async () => {
    // 4 failures
    for (let i = 0; i < 4; i++) {
      await expect(cb.call(alwaysFails(transientError()))).rejects.toThrow();
    }
    // 1 success — counter resets
    await cb.call(alwaysSucceeds("ok"));
    expect(cb.currentState).toBe("CLOSED");

    // 4 more failures — still not at threshold
    for (let i = 0; i < 4; i++) {
      await expect(cb.call(alwaysFails(transientError()))).rejects.toThrow();
    }
    expect(cb.currentState).toBe("CLOSED");
  });

  it("OPEN state — throws CircuitOpenError immediately without calling fn", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(cb.call(alwaysFails(transientError()))).rejects.toThrow();
    }
    expect(cb.currentState).toBe("OPEN");

    const fn = vi.fn().mockResolvedValue("should-not-be-called");
    await expect(cb.call(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("CircuitOpenError carries endpoint and openedAt", async () => {
    const before = Date.now();
    for (let i = 0; i < 5; i++) {
      await expect(cb.call(alwaysFails(transientError()))).rejects.toThrow();
    }
    const after = Date.now();

    try {
      await cb.call(alwaysSucceeds("x"));
    } catch (e) {
      expect(e).toBeInstanceOf(CircuitOpenError);
      const err = e as CircuitOpenError;
      expect(err.endpoint).toBe(ENDPOINT);
      expect(err.openedAt).toBeGreaterThanOrEqual(before);
      expect(err.openedAt).toBeLessThanOrEqual(after);
    }
  });

  it("OPEN → HALF_OPEN after recovery window elapses", async () => {
    vi.useFakeTimers();

    const cb2 = new CircuitBreaker(ENDPOINT, {
      failureThreshold: 5,
      recoveryWindowMs: 60_000,
    });

    for (let i = 0; i < 5; i++) {
      await expect(cb2.call(alwaysFails(transientError()))).rejects.toThrow();
    }
    expect(cb2.currentState).toBe("OPEN");

    vi.advanceTimersByTime(60_001);
    expect(cb2.currentState).toBe("HALF_OPEN");

    vi.useRealTimers();
  });

  it("HALF_OPEN → CLOSED on successful probe", async () => {
    vi.useFakeTimers();

    const cb2 = new CircuitBreaker(ENDPOINT, {
      failureThreshold: 5,
      recoveryWindowMs: 60_000,
    });

    for (let i = 0; i < 5; i++) {
      await expect(cb2.call(alwaysFails(transientError()))).rejects.toThrow();
    }

    vi.advanceTimersByTime(60_001);
    expect(cb2.currentState).toBe("HALF_OPEN");

    await cb2.call(alwaysSucceeds("probe-ok"));
    expect(cb2.currentState).toBe("CLOSED");

    vi.useRealTimers();
  });

  it("HALF_OPEN → OPEN on failed probe — restarts recovery clock", async () => {
    vi.useFakeTimers();

    const cb2 = new CircuitBreaker(ENDPOINT, {
      failureThreshold: 5,
      recoveryWindowMs: 60_000,
    });

    for (let i = 0; i < 5; i++) {
      await expect(cb2.call(alwaysFails(transientError()))).rejects.toThrow();
    }

    vi.advanceTimersByTime(60_001);
    expect(cb2.currentState).toBe("HALF_OPEN");

    // Probe fails
    await expect(cb2.call(alwaysFails(transientError()))).rejects.toThrow();
    expect(cb2.currentState).toBe("OPEN");

    // Partial window — still OPEN
    vi.advanceTimersByTime(30_000);
    expect(cb2.currentState).toBe("OPEN");

    // Full window again — HALF_OPEN
    vi.advanceTimersByTime(30_001);
    expect(cb2.currentState).toBe("HALF_OPEN");

    vi.useRealTimers();
  });
});

// ─── Permanent errors ──────────────────────────────────────────────────────────

describe("CircuitBreaker — permanent errors", () => {
  it("does NOT count permanent (4xx) errors toward failure threshold", async () => {
    const cb = new CircuitBreaker(ENDPOINT, { failureThreshold: 3 });

    for (let i = 0; i < 10; i++) {
      await expect(cb.call(alwaysFails(permanentError()))).rejects.toThrow();
    }

    // Circuit must remain CLOSED — 4xx errors are not transient
    expect(cb.currentState).toBe("CLOSED");
  });

  it("permanent error still propagates to the caller", async () => {
    const cb = new CircuitBreaker(ENDPOINT);
    await expect(cb.call(alwaysFails(permanentError()))).rejects.toMatchObject({
      response: { status: 400 },
    });
  });
});

// ─── Metrics ──────────────────────────────────────────────────────────────────

describe("CircuitBreaker — metrics", () => {
  it("tracks totalFailures, totalSuccesses, and consecutiveFailures", async () => {
    const cb = new CircuitBreaker(ENDPOINT, { failureThreshold: 5 });

    await cb.call(alwaysSucceeds(1));
    await cb.call(alwaysSucceeds(2));
    await expect(cb.call(alwaysFails(transientError()))).rejects.toThrow();
    await expect(cb.call(alwaysFails(transientError()))).rejects.toThrow();

    const m = cb.getMetrics();
    expect(m.totalSuccesses).toBe(2);
    expect(m.totalFailures).toBe(2);
    expect(m.consecutiveFailures).toBe(2);
    expect(m.state).toBe("CLOSED");
    expect(m.lastOpenedAt).toBeNull();
  });

  it("records lastOpenedAt when circuit trips", async () => {
    const before = Date.now();
    const cb = new CircuitBreaker(ENDPOINT, { failureThreshold: 5 });

    for (let i = 0; i < 5; i++) {
      await expect(cb.call(alwaysFails(transientError()))).rejects.toThrow();
    }
    const after = Date.now();

    const m = cb.getMetrics();
    expect(m.state).toBe("OPEN");
    expect(m.lastOpenedAt).toBeGreaterThanOrEqual(before);
    expect(m.lastOpenedAt).toBeLessThanOrEqual(after);
  });

  it("onStateChange fires with correct transition data", async () => {
    const transitions: Array<{ from: string; to: string }> = [];

    const cb = new CircuitBreaker(ENDPOINT, {
      failureThreshold: 3,
      onStateChange: (e) => transitions.push({ from: e.from, to: e.to }),
    });

    for (let i = 0; i < 3; i++) {
      await expect(cb.call(alwaysFails(transientError()))).rejects.toThrow();
    }

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toEqual({ from: "CLOSED", to: "OPEN" });
  });

  it("onStateChange captures all transitions through a full recovery cycle", async () => {
    vi.useFakeTimers();

    const transitions: Array<{ from: string; to: string }> = [];
    const cb = new CircuitBreaker(ENDPOINT, {
      failureThreshold: 2,
      recoveryWindowMs: 1_000,
      onStateChange: (e) => transitions.push({ from: e.from, to: e.to }),
    });

    // CLOSED → OPEN
    for (let i = 0; i < 2; i++) {
      await expect(cb.call(alwaysFails(transientError()))).rejects.toThrow();
    }

    // OPEN → HALF_OPEN
    vi.advanceTimersByTime(1_001);
    cb.currentState; // trigger check

    // HALF_OPEN → CLOSED
    await cb.call(alwaysSucceeds("recovered"));

    expect(transitions).toEqual([
      { from: "CLOSED", to: "OPEN" },
      { from: "OPEN", to: "HALF_OPEN" },
      { from: "HALF_OPEN", to: "CLOSED" },
    ]);

    vi.useRealTimers();
  });
});

// ─── CircuitBreakerRegistry ───────────────────────────────────────────────────

describe("CircuitBreakerRegistry", () => {
  it("creates a new breaker per endpoint", () => {
    const registry = new CircuitBreakerRegistry();
    const b1 = registry.getBreakerFor("https://endpoint-a.example.com");
    const b2 = registry.getBreakerFor("https://endpoint-b.example.com");
    expect(b1).not.toBe(b2);
  });

  it("reuses the same breaker for the same endpoint", () => {
    const registry = new CircuitBreakerRegistry();
    const b1 = registry.getBreakerFor(ENDPOINT);
    const b2 = registry.getBreakerFor(ENDPOINT);
    expect(b1).toBe(b2);
  });

  it("call() trips the per-endpoint breaker after failures", async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 3 });

    for (let i = 0; i < 3; i++) {
      await expect(
        registry.call(ENDPOINT, alwaysFails(transientError())),
      ).rejects.toThrow();
    }

    expect(registry.getBreakerFor(ENDPOINT).currentState).toBe("OPEN");
    await expect(
      registry.call(ENDPOINT, alwaysSucceeds("x")),
    ).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("breakers for different endpoints are independent", async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 2 });
    const ep1 = "https://rpc-1.example.com";
    const ep2 = "https://rpc-2.example.com";

    for (let i = 0; i < 2; i++) {
      await expect(
        registry.call(ep1, alwaysFails(transientError())),
      ).rejects.toThrow();
    }

    expect(registry.getBreakerFor(ep1).currentState).toBe("OPEN");
    expect(registry.getBreakerFor(ep2).currentState).toBe("CLOSED");
  });

  it("getAllMetrics returns a snapshot for all known endpoints", async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 5 });
    registry.getBreakerFor("https://a.example.com");
    registry.getBreakerFor("https://b.example.com");

    const metrics = registry.getAllMetrics();
    expect(Object.keys(metrics)).toHaveLength(2);
    expect(metrics["https://a.example.com"].state).toBe("CLOSED");
    expect(metrics["https://b.example.com"].state).toBe("CLOSED");
  });

  it("resetAll resets all breakers to CLOSED", async () => {
    const registry = new CircuitBreakerRegistry({ failureThreshold: 2 });

    for (let i = 0; i < 2; i++) {
      await expect(
        registry.call(ENDPOINT, alwaysFails(transientError())),
      ).rejects.toThrow();
    }
    expect(registry.getBreakerFor(ENDPOINT).currentState).toBe("OPEN");

    registry.resetAll();
    expect(registry.getBreakerFor(ENDPOINT).currentState).toBe("CLOSED");
  });
});
