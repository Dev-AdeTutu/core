/**
 * NFT metadata caching and media proxying (#458).
 *
 * Provides cached retrieval of NFT metadata from external URIs with
 * configurable TTL and LRU eviction. Optionally proxies media requests
 * to avoid exposing external endpoints to clients.
 */

import { SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { ok, err } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import { createInMemoryCache } from "../shared/cache";

export interface NftMetadata {
  /** NFT asset identifier (token ID or contract-based ID) */
  assetId: string;
  /** Metadata name */
  name?: string | undefined;
  /** Metadata description */
  description?: string | undefined;
  /** URI to the NFT image/media */
  image?: string | undefined;
  /** Proxied image URL if media proxying is enabled */
  proxyImage?: string | undefined;
  /** External metadata URI that was fetched */
  metadataUri?: string | undefined;
  /** Raw metadata attributes */
  attributes?:
    | Array<{ trait_type: string; value: string | number }>
    | undefined;
  /** Timestamp when metadata was fetched */
  fetchedAt: number;
}

export interface NftMetadataOptions {
  /** Custom cache instance (uses built-in LRU cache if omitted) */
  cache?: SorokitCache | undefined;
  /** TTL for cached metadata in milliseconds (default: 5 minutes) */
  ttlMs?: number | undefined;
  /** Base URL for media proxy (enables media proxying when set) */
  mediaProxyUrl?: string | undefined;
  /** Custom fetch function (defaults to globalThis.fetch) */
  fetchFn?: typeof fetch | undefined;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number | undefined;
}

/** Default cache capacity for LRU eviction */
const DEFAULT_MAX_CACHE_ENTRIES = 200;
/** Default TTL: 5 minutes */
const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** Default request timeout */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Simple LRU eviction wrapper around SorokitCache.
 * Tracks insertion order and evicts oldest entries when capacity is exceeded.
 */
function createLruCache(maxEntries: number, ttlMs: number): SorokitCache {
  const inner = createInMemoryCache(ttlMs);
  const order: string[] = [];

  return {
    get(key: string): unknown {
      const val = inner.get(key);
      if (val !== undefined) {
        // Move to end (most recently used)
        const idx = order.indexOf(key);
        if (idx !== -1) order.splice(idx, 1);
        order.push(key);
      }
      return val;
    },
    set(key: string, value: unknown, entryTtlMs?: number): void {
      // Evict oldest if at capacity
      while (order.length >= maxEntries) {
        const oldest = order.shift();
        if (oldest) inner.invalidate(oldest);
      }
      if (!order.includes(key)) order.push(key);
      inner.set(key, value, entryTtlMs);
    },
    invalidate(key: string): void {
      inner.invalidate(key);
      const idx = order.indexOf(key);
      if (idx !== -1) order.splice(idx, 1);
    },
    clear(): void {
      inner.clear();
      order.length = 0;
    },
  };
}

/**
 * Default in-memory LRU cache for NFT metadata.
 */
let defaultCache: SorokitCache | null = null;

function getDefaultCache(): SorokitCache {
  if (!defaultCache) {
    defaultCache = createLruCache(DEFAULT_MAX_CACHE_ENTRIES, DEFAULT_TTL_MS);
  }
  return defaultCache;
}

/**
 * Clear the default global NFT metadata cache.
 */
export function clearNftMetadataCache(): void {
  if (defaultCache) {
    defaultCache.clear();
  }
}

/**
 * Build a cache key for NFT metadata.
 */
function buildCacheKey(assetId: string): string {
  return `nft:metadata:${assetId}`;
}

/**
 * Construct a proxied media URL.
 */
function buildProxyUrl(originalUrl: string, proxyBase: string): string {
  const encoded = encodeURIComponent(originalUrl);
  return `${proxyBase.replace(/\/$/, "")}/${encoded}`;
}

/**
 * Fetch NFT metadata with caching and optional media proxying.
 *
 * @param assetId  - The NFT asset identifier
 * @param uri      - The external metadata URI to fetch from
 * @param options  - Caching, proxy, and fetch options
 * @returns SorokitResult with the NFT metadata
 */
export async function getNftMetadata(
  assetId: string,
  uri: string,
  options?: NftMetadataOptions,
): Promise<SorokitResult<NftMetadata>> {
  if (!assetId || typeof assetId !== "string") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "assetId must be a non-empty string",
    );
  }

  if (!uri || typeof uri !== "string") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "uri must be a non-empty string",
    );
  }

  const cache = options?.cache ?? getDefaultCache();
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const cacheKey = buildCacheKey(assetId);

  // Check cache
  const cached = cache.get(cacheKey) as NftMetadata | undefined;
  if (cached) {
    return ok(cached);
  }

  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchFn(uri, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `Failed to fetch NFT metadata: HTTP ${response.status}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const proxyImage =
      typeof data.image === "string" && options?.mediaProxyUrl
        ? buildProxyUrl(data.image, options.mediaProxyUrl)
        : undefined;

    const metadata: NftMetadata = {
      assetId,
      name: typeof data.name === "string" ? data.name : undefined,
      description:
        typeof data.description === "string" ? data.description : undefined,
      image: typeof data.image === "string" ? data.image : undefined,
      proxyImage,
      metadataUri: uri,
      attributes: Array.isArray(data.attributes)
        ? (data.attributes as Array<{
            trait_type: string;
            value: string | number;
          }>)
        : undefined,
      fetchedAt: Date.now(),
    };

    cache.set(cacheKey, metadata, ttlMs);
    return ok(metadata);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `NFT metadata fetch timed out after ${timeoutMs}ms`,
      );
    }
    return err(
      SorokitErrorCode.NETWORK_ERROR,
      `Failed to fetch NFT metadata: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
