import { describe, expect, it, vi } from "vitest";
import { createInMemoryCache } from "../shared/cache";
import { SorokitErrorCode } from "../shared/response";
import {
  DEFAULT_PRICE_CACHE_TTL_MS,
  StaticPriceFeed,
  getAssetPrice,
} from "../transaction/priceFeeds";
import type { PriceFeed } from "../shared/types";

describe("transaction price feeds", () => {
  it("returns and caches normalized prices from provider priority", async () => {
    const cache = createInMemoryCache();
    const fallback = new StaticPriceFeed({ XLM: 0.12 }, "fallback");
    const primary: PriceFeed = {
      name: "primary",
      getPrice: vi.fn().mockResolvedValue(null),
    };

    const first = await getAssetPrice("native", {
      cache,
      providers: [primary, fallback],
    });
    const second = await getAssetPrice("XLM", {
      cache,
      providers: [primary],
    });

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status === "ok" && second.status === "ok") {
      expect(first.data.provider).toBe("fallback");
      expect(second.data.price).toBe(0.12);
      expect(second.data.currency).toBe("USD");
    }
    expect(primary.getPrice).toHaveBeenCalledTimes(1);
  });

  it("distinguishes stale and unavailable prices", async () => {
    const staleProvider: PriceFeed = {
      name: "stale",
      getPrice: vi.fn().mockResolvedValue({
        asset: "XLM",
        price: 0.1,
        currency: "USD",
        provider: "stale",
        timestamp: new Date(Date.now() - DEFAULT_PRICE_CACHE_TTL_MS * 2).toISOString(),
        status: "fresh",
      }),
    };

    const result = await getAssetPrice("XLM", { providers: [staleProvider] });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.SERVICE_UNAVAILABLE);
      expect((result.error.cause as { status?: string }).status).toBe("stale");
    }
  });
});
