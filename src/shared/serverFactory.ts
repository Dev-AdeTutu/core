/**
 * Centralized server factory with tracing support (#212).
 *
 * All module functions should use these helpers instead of directly
 * instantiating `Horizon.Server` or `SorobanRpc.Server`. The client
 * factory calls `setTracedFetch` once, and all subsequent server
 * instances automatically inject correlation headers.
 *
 * This avoids having to thread a `fetch` option through every function's
 * parameter list while still supporting custom fetch for tracing.
 */

import { Horizon } from "@stellar/stellar-sdk";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { SorobanSimulator } from "../soroban/simulator";

let tracedFetch: typeof globalThis.fetch | undefined;
let activeSimulator: SorobanSimulator | null = null;

/**
 * Set the fetch function to use for all server instances.
 * Called once during `createSorokitClient`.
 */
export function setTracedFetch(fetch: typeof globalThis.fetch): void {
  tracedFetch = fetch;
}

/**
 * Get the currently configured traced fetch, or undefined.
 */
export function getTracedFetch(): typeof globalThis.fetch | undefined {
  return tracedFetch;
}

/**
 * Inject a SorobanSimulator for local testing (#210).
 * When set, createSorobanServer returns the simulator instead of a
 * real SorobanRpc.Server for any URL matching simulator.rpc.
 */
export function setSorobanSimulator(simulator: SorobanSimulator | null): void {
  activeSimulator = simulator;
}

/**
 * Options accepted by the server factories.
 * `signal` aborts in-flight requests when the operation times out (#392).
 */
export interface ServerOptions {
  signal?: AbortSignal | undefined;
}

/**
 * Wrap a fetch so that requests are aborted when the given signal fires,
 * composing with any traced fetch already configured.
 */
function signalAwareFetch(signal: AbortSignal): NonNullable<typeof tracedFetch> {
  const base = tracedFetch ?? globalThis.fetch.bind(globalThis);
  return (input, init) =>
    base(input, {
      ...init,
      signal: composeSignals(init?.signal ?? undefined, signal),
    });
}

function composeSignals(
  a: AbortSignal | null | undefined,
  b: AbortSignal,
): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  const controller = new AbortController();
  const forward = (from: AbortSignal) => () => controller.abort((from as { reason?: unknown }).reason);
  a.addEventListener("abort", forward(a), { once: true });
  b.addEventListener("abort", forward(b), { once: true });
  return controller.signal;
}

/**
 * Create a Horizon.Server instance with optional tracing fetch and
 * optional timeout signal (#392).
 */
export function createHorizonServer(
  horizonUrl: string,
  options?: ServerOptions,
): Horizon.Server {
  if (options?.signal) {
    return new Horizon.Server(horizonUrl, {
      fetch: signalAwareFetch(options.signal),
    } as any);
  }
  return tracedFetch
    ? new Horizon.Server(horizonUrl, { fetch: tracedFetch } as any)
    : new Horizon.Server(horizonUrl);
}

/**
 * Create a SorobanRpc.Server instance with optional tracing fetch and
 * optional timeout signal (#392).
 * If a simulator is active and the URL matches, returns the simulator.
 */
export function createSorobanServer(
  rpcUrl: string,
  options?: ServerOptions,
): SorobanRpc.Server | SorobanSimulator {
  if (activeSimulator && rpcUrl === activeSimulator.rpc) {
    return activeSimulator;
  }
  if (options?.signal) {
    return new SorobanRpc.Server(rpcUrl, {
      fetch: signalAwareFetch(options.signal),
    } as any);
  }
  return tracedFetch
    ? new SorobanRpc.Server(rpcUrl, { fetch: tracedFetch } as any)
    : new SorobanRpc.Server(rpcUrl);
}
