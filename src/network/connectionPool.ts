export interface ConnectionPoolConfig {
  /** Maximum concurrent requests per origin. Defaults to 10. */
  maxPoolSize?: number;
  /** Time after which an idle origin entry is released. Defaults to 30 seconds. */
  keepAliveTimeoutMs?: number;
  /** Abort a request after this many milliseconds. Defaults to 30 seconds. */
  socketTimeoutMs?: number;
}

export interface ConnectionPoolStats {
  origin: string;
  active: number;
  queued: number;
  lastUsedAt: number;
}

type FetchLike = typeof globalThis.fetch;
type FetchInit = RequestInit & { agent?: unknown; dispatcher?: unknown };
type QueueItem = { resolve: () => void };

interface OriginState {
  active: number;
  queue: QueueItem[];
  lastUsedAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULTS: Required<ConnectionPoolConfig> = {
  maxPoolSize: 10,
  keepAliveTimeoutMs: 30_000,
  socketTimeoutMs: 30_000,
};

/**
 * Lightweight per-origin request pool. Native fetch implementations (including
 * Node's undici) reuse their own sockets; this layer adds bounded concurrency,
 * request timeouts, and one stable fetch entry point for SDK server factories.
 */
export class ConnectionPool {
  private readonly config: Required<ConnectionPoolConfig>;
  private readonly origins = new Map<string, OriginState>();
  private readonly baseFetch: FetchLike;

  constructor(config: ConnectionPoolConfig = {}, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    this.config = {
      maxPoolSize: Math.max(1, Math.floor(config.maxPoolSize ?? DEFAULTS.maxPoolSize)),
      keepAliveTimeoutMs: Math.max(0, Math.floor(config.keepAliveTimeoutMs ?? DEFAULTS.keepAliveTimeoutMs)),
      socketTimeoutMs: Math.max(0, Math.floor(config.socketTimeoutMs ?? DEFAULTS.socketTimeoutMs)),
    };
    this.baseFetch = fetchImpl;
  }

  private stateFor(origin: string): OriginState {
    const existing = this.origins.get(origin);
    if (existing) return existing;
    const state: OriginState = { active: 0, queue: [], lastUsedAt: Date.now() };
    this.origins.set(origin, state);
    return state;
  }

  private async acquire(origin: string): Promise<OriginState> {
    const state = this.stateFor(origin);
    state.lastUsedAt = Date.now();
    if (state.active < this.config.maxPoolSize) {
      state.active += 1;
      return state;
    }
    await new Promise<void>((resolve) => state.queue.push({ resolve }));
    state.active += 1;
    return state;
  }

  private release(origin: string, state: OriginState): void {
    state.active = Math.max(0, state.active - 1);
    state.lastUsedAt = Date.now();
    const next = state.queue.shift();
    if (next) next.resolve();
    if (state.active === 0 && state.queue.length === 0) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => {
        const current = this.origins.get(origin);
        if (current === state && current.active === 0) this.origins.delete(origin);
      }, this.config.keepAliveTimeoutMs);
    }
  }

  /** Fetch through the pool. Connections are keyed by URL origin. */
  fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const origin = new URL(url).origin;
    const state = await this.acquire(origin);
    const controller = new AbortController();
    const callerSignal = init?.signal;
    const onAbort = () => controller.abort(callerSignal && "reason" in callerSignal ? callerSignal.reason : undefined);
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    const timeout = this.config.socketTimeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`Connection socket timeout after ${this.config.socketTimeoutMs}ms`)), this.config.socketTimeoutMs)
      : undefined;
    try {
      const requestInit: FetchInit = { ...init, signal: controller.signal };
      return await this.baseFetch(input, requestInit);
    } finally {
      if (timeout) clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onAbort);
      this.release(origin, state);
    }
  };

  stats(): ConnectionPoolStats[] {
    return Array.from(this.origins, ([origin, state]) => ({
      origin,
      active: state.active,
      queued: state.queue.length,
      lastUsedAt: state.lastUsedAt,
    }));
  }

  close(): void {
    for (const state of this.origins.values()) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
    }
    this.origins.clear();
  }
}

export function createConnectionPool(config: ConnectionPoolConfig = {}): ConnectionPool {
  return new ConnectionPool(config);
}
