import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import type { AssetPrice, PriceFeed, PriceFeedStatus } from "../shared/types";

export interface GetAssetPriceOptions {
  currency?: string;
  providers?: PriceFeed[];
  cache?: SorokitCache;
  ttlMs?: number;
  maxAgeMs?: number;
}

export const DEFAULT_PRICE_CACHE_TTL_MS = 5 * 60 * 1000;

export class StaticPriceFeed implements PriceFeed {
  readonly name: string;
  private readonly prices: Record<string, number>;

  constructor(prices: Record<string, number>, name = "static") {
    this.prices = prices;
    this.name = name;
  }

  async getPrice(asset: string, currency = "USD"): Promise<AssetPrice | null> {
    const price = this.prices[normalizeAsset(asset)];
    if (price === undefined) return null;
    return normalizePrice(asset, currency, this.name, price, new Date());
  }
}

export function normalizeAsset(asset: string): string {
  return asset === "native" ? "XLM" : asset.toUpperCase();
}

export function normalizePrice(
  asset: string,
  currency: string,
  provider: string,
  price: number,
  timestamp: Date,
  status: PriceFeedStatus = "fresh",
): AssetPrice {
  return {
    asset: normalizeAsset(asset),
    price,
    currency: currency.toUpperCase(),
    provider,
    timestamp: timestamp.toISOString(),
    status,
  };
}

function getCacheKey(asset: string, currency: string): string {
  return `price:${normalizeAsset(asset)}:${currency.toUpperCase()}`;
}

function classifyPrice(price: AssetPrice, maxAgeMs: number): PriceFeedStatus {
  if (!Number.isFinite(price.price) || price.price <= 0) return "invalid";
  const timestamp = Date.parse(price.timestamp);
  if (!Number.isFinite(timestamp)) return "invalid";
  return Date.now() - timestamp > maxAgeMs ? "stale" : "fresh";
}

export async function getAssetPrice(
  asset: string,
  options?: GetAssetPriceOptions,
): Promise<SorokitResult<AssetPrice>> {
  const currency = options?.currency ?? "USD";
  const cacheKey = getCacheKey(asset, currency);
  const cached = options?.cache?.get(cacheKey) as AssetPrice | undefined;
  if (cached) return ok(cached);

  const providers = options?.providers ?? [];
  if (providers.length === 0) {
    return err(
      SorokitErrorCode.SERVICE_UNAVAILABLE,
      "No price feed providers configured.",
    );
  }

  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_PRICE_CACHE_TTL_MS;
  let stale: AssetPrice | null = null;

  for (const provider of providers) {
    try {
      const response = await provider.getPrice(asset, currency);
      if (!response) continue;
      const normalized = {
        ...response,
        asset: normalizeAsset(response.asset || asset),
        currency: (response.currency || currency).toUpperCase(),
        provider: response.provider || provider.name,
        status: classifyPrice(response, maxAgeMs),
      };
      if (normalized.status === "fresh") {
        options?.cache?.set(cacheKey, normalized, options.ttlMs ?? DEFAULT_PRICE_CACHE_TTL_MS);
        return ok(normalized);
      }
      if (normalized.status === "stale" && stale === null) stale = normalized;
    } catch {
      continue;
    }
  }

  if (stale) {
    return err(SorokitErrorCode.SERVICE_UNAVAILABLE, "Only stale price feed responses were available.", stale);
  }

  return err(
    SorokitErrorCode.SERVICE_UNAVAILABLE,
    "No available price feed provider returned a valid price.",
  );
}
