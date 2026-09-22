import type { AssetPrice, PriceFeedStatus } from "../shared/types";
import { normalizeAsset } from "./priceFeeds";

// ─── Public types ──────────────────────────────────────────────────────────────

export type PriceUpdate = AssetPrice;

export interface PriceSubscription {
  unsubscribe(): void;
}

export interface PriceSubscriptionProvider {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(assets: string[]): void;
  onMessage(handler: (update: PriceUpdate) => void): void;
  onClose(handler: (wasClean: boolean) => void): void;
  onError(handler: (error: Error) => void): void;
}

export interface PriceSubscriptionOptions {
  providers?: PriceSubscriptionProvider[];
  currency?: string;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  jitterMs?: number;
  signal?: AbortSignal;
  onError?: (error: Error) => void;
  onProviderChange?: (providerName: string) => void;
}

// ─── Built-in WebSocket provider ──────────────────────────────────────────────

export interface WebSocketPriceProviderOptions {
  url: string;
  name?: string;
}

export class WebSocketPriceProvider implements PriceSubscriptionProvider {
  readonly name: string;
  private readonly url: string;
  private ws: WebSocket | null = null;
  private messageHandler: ((update: PriceUpdate) => void) | null = null;
  private closeHandler: ((wasClean: boolean) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;

  constructor(options: WebSocketPriceProviderOptions) {
    this.url = options.url;
    this.name = options.name ?? "websocket";
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => resolve();
      ws.onerror = (event) => {
        const error = new Error(`WebSocket error on provider "${this.name}"`);
        this.errorHandler?.(error);
        reject(error);
      };
      ws.onclose = (event) => {
        this.closeHandler?.(event.wasClean);
      };
      ws.onmessage = (event) => {
        try {
          const raw = JSON.parse(event.data as string) as Record<
            string,
            unknown
          >;
          const price = Number(raw.price);
          if (!Number.isFinite(price) || price <= 0) {
            this.errorHandler?.(
              new Error(
                `Invalid price value received from provider "${this.name}"`,
              ),
            );
            return;
          }
          const update: PriceUpdate = {
            asset: normalizeAsset(String(raw.asset ?? "")),
            price,
            currency: String(raw.currency ?? "USD").toUpperCase(),
            provider: String(raw.provider ?? this.name),
            timestamp: String(raw.timestamp ?? new Date().toISOString()),
            status: (raw.status as PriceFeedStatus) ?? "fresh",
          };
          this.messageHandler?.(update);
        } catch {
          this.errorHandler?.(
            new Error(`Failed to parse message from provider "${this.name}"`),
          );
        }
      };
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.onclose = null; // suppress reconnect-trigger
      this.ws.close();
      this.ws = null;
    }
  }

  subscribe(assets: string[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "subscribe", assets }));
    }
  }

  onMessage(handler: (update: PriceUpdate) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (wasClean: boolean) => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }
}

// ─── Core subscription logic ───────────────────────────────────────────────────

const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_RETRIES = 10;

export function subscribePrices(
  assets: string[],
  callback: (update: PriceUpdate) => void,
  options?: PriceSubscriptionOptions,
): PriceSubscription {
  if (!assets || assets.length === 0) {
    throw new Error("subscribePrices: assets array must be non-empty.");
  }

  const normalizedAssets = assets.map(normalizeAsset);
  const providers = options?.providers ?? [];
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const jitterMs = options?.jitterMs ?? 0;

  let unsubscribed = false;
  let retryCount = 0;
  let providerIndex = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let activeProvider: PriceSubscriptionProvider | null = null;

  function computeDelay(attempt: number): number {
    const backoff = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
    const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0;
    return backoff + jitter;
  }

  function scheduleReconnect(): void {
    if (unsubscribed) return;
    if (retryCount >= maxRetries) {
      // Try next provider
      providerIndex = (providerIndex + 1) % Math.max(providers.length, 1);
      retryCount = 0;

      if (providers.length === 0) {
        options?.onError?.(
          new Error(
            "subscribePrices: no providers configured and retry limit reached.",
          ),
        );
        return;
      }

      const allExhausted = providerIndex === 0;
      if (allExhausted && providers.length <= 1) {
        options?.onError?.(
          new Error("subscribePrices: all providers exhausted."),
        );
        return;
      }
    }

    const delay = computeDelay(retryCount);
    retryTimer = setTimeout(() => {
      if (!unsubscribed) void attemptConnect();
    }, delay);
    retryCount++;
  }

  async function attemptConnect(): Promise<void> {
    if (unsubscribed) return;
    if (providers.length === 0) {
      options?.onError?.(
        new Error("subscribePrices: no providers configured."),
      );
      return;
    }

    const provider = providers[providerIndex];
    if (!provider) {
      options?.onError?.(new Error("subscribePrices: provider is undefined."));
      return;
    }
    activeProvider = provider;

    provider.onMessage((update) => {
      if (!unsubscribed) callback(update);
    });

    provider.onError((error) => {
      if (!unsubscribed) options?.onError?.(error);
    });

    provider.onClose((wasClean) => {
      if (unsubscribed || wasClean) return;
      scheduleReconnect();
    });

    try {
      await provider.connect();
      if (unsubscribed) {
        provider.disconnect();
        return;
      }
      options?.onProviderChange?.(provider.name);
      provider.subscribe(normalizedAssets);
      retryCount = 0;
    } catch {
      scheduleReconnect();
    }
  }

  // Wire AbortSignal
  options?.signal?.addEventListener("abort", () => unsubscribeHandle(), {
    once: true,
  });

  // Start
  void attemptConnect();

  function unsubscribeHandle(): void {
    if (unsubscribed) return;
    unsubscribed = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    activeProvider?.disconnect();
    activeProvider = null;
  }

  return { unsubscribe: unsubscribeHandle };
}

// ─── Backoff utility (exported for testing) ───────────────────────────────────

export function computeBackoffDelay(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  return Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
}
