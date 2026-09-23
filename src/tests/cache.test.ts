import { describe, it, expect, vi } from "vitest";
import { createInMemoryCache, SorokitCache } from "../shared/cache";

class MinimalMapCache implements SorokitCache {
  private store = new Map<string, { value: unknown; expiresAt?: number }>();

  get(key: string): unknown {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    if (ttlMs !== undefined) {
      this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    } else {
      this.store.set(key, { value });
    }
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

describe("SorokitCache Interface Contract", () => {
  it("cache.get('missing') returns undefined", () => {
    const cache = new MinimalMapCache();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("cache.set('key', 'value') followed by cache.get('key') returns 'value'", () => {
    const cache = new MinimalMapCache();
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");
  });

  it("cache.invalidate('key') causes cache.get('key') to return undefined", () => {
    const cache = new MinimalMapCache();
    cache.set("key", "value");
    cache.invalidate("key");
    expect(cache.get("key")).toBeUndefined();
  });

  it("cache.clear() causes all previously set keys to return undefined", () => {
    const cache = new MinimalMapCache();
    cache.set("k1", "v1");
    cache.set("k2", "v2");
    cache.clear();
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("k2")).toBeUndefined();
  });

  it("if TTL is implemented, cache.get(key) returns undefined after TTL expires", () => {
    const cache = new MinimalMapCache();
    cache.set("key", "value", 100);
    expect(cache.get("key")).toBe("value");

    const originalDateNow = Date.now;
    Date.now = vi.fn(() => originalDateNow() + 200);

    expect(cache.get("key")).toBeUndefined();

    Date.now = originalDateNow;
  });
});

describe("createInMemoryCache", () => {
  it("stores and retrieves values", () => {
    const cache = createInMemoryCache();
    cache.set("foo", "bar");
    expect(cache.get("foo")).toBe("bar");
  });

  it("invalidates and clears entries", () => {
    const cache = createInMemoryCache();
    cache.set("foo", "bar");
    cache.invalidate("foo");
    expect(cache.get("foo")).toBeUndefined();
  });

  it("should clear all keys", () => {
    const cache = createInMemoryCache();
    cache.set("foo", "bar");
    cache.set("baz", "qux");
    cache.clear();
    expect(cache.get("foo")).toBeUndefined();
    expect(cache.get("baz")).toBeUndefined();
  });

  it("should expire keys based on TTL", () => {
    const cache = createInMemoryCache();
    cache.set("foo", "bar", 100);
    expect(cache.get("foo")).toBe("bar");

    // Mock Date.now to simulate time passing
    const originalDateNow = Date.now;
    Date.now = vi.fn(() => originalDateNow() + 200);

    expect(cache.get("foo")).toBeUndefined();

    // Restore Date.now
    Date.now = originalDateNow;
  });

  it("should use default TTL", () => {
    const cache = createInMemoryCache(100);
    cache.set("foo", "bar");
    expect(cache.get("foo")).toBe("bar");

    const originalDateNow = Date.now;
    Date.now = vi.fn(() => originalDateNow() + 200);

    expect(cache.get("foo")).toBeUndefined();

    Date.now = originalDateNow;
  });

  it("validates TTL value", () => {
    const cache = createInMemoryCache();
    expect(() => cache.set("foo", "bar", -10)).toThrow();
    expect(() => cache.set("foo", "bar", 1.5)).toThrow();
    // @ts-expect-error
    expect(() => cache.set("foo", "bar", "100")).toThrow();
  });
});
