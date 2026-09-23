/**
 * Unified runtime environment abstraction layer for browser and Node.js.
 * Centralizes runtime detection, timers, crypto, and storage.
 */

export type RuntimeEnvironment = "browser" | "node" | "unknown";

/**
 * Safely detect whether the current runtime environment is a browser.
 */
export function isBrowser(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.document !== "undefined"
  );
}

/**
 * Safely detect whether the current runtime environment is Node.js.
 */
export function isNode(): boolean {
  return (
    typeof process !== "undefined" &&
    process.versions !== undefined &&
    process.versions.node !== undefined
  );
}

/**
 * Get the current runtime environment type.
 */
export function getEnvironment(): RuntimeEnvironment {
  if (isBrowser()) return "browser";
  if (isNode()) return "node";
  return "unknown";
}

/**
 * Unified Timers Interface
 */
export interface EnvironmentTimers {
  setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
  clearTimeout(timeoutId: any): void;
  setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
  clearInterval(intervalId: any): void;
}

export const timers: EnvironmentTimers = {
  setTimeout: (cb, ms, ...args) => globalThis.setTimeout(cb, ms, ...args),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (cb, ms, ...args) => globalThis.setInterval(cb, ms, ...args),
  clearInterval: (id) => globalThis.clearInterval(id),
};

/**
 * Unified Crypto Interface
 */
export interface EnvironmentCrypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomBytes(length: number): Uint8Array;
}

export const crypto: EnvironmentCrypto = {
  getRandomValues<T extends ArrayBufferView>(array: T): T {
    if (
      typeof globalThis.crypto !== "undefined" &&
      typeof globalThis.crypto.getRandomValues === "function"
    ) {
      return globalThis.crypto.getRandomValues(array);
    }
    if (isNode()) {
      try {
        const nodeCrypto = require("crypto");
        if (nodeCrypto.webcrypto && typeof nodeCrypto.webcrypto.getRandomValues === "function") {
          return nodeCrypto.webcrypto.getRandomValues(array);
        }
        if (typeof nodeCrypto.randomBytes === "function") {
          const bytes: Buffer = nodeCrypto.randomBytes(array.byteLength);
          const uint8 = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
          uint8.set(bytes);
          return array;
        }
      } catch {
        // Fallback
      }
    }
    throw new Error("No secure random value generator available in this environment.");
  },
  randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    return this.getRandomValues(bytes);
  },
};

/**
 * Key-Value Storage Interface
 */
export interface EnvironmentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

export class MemoryStorage implements EnvironmentStorage {
  private _store = new Map<string, string>();

  getItem(key: string): string | null {
    return this._store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this._store.set(key, String(value));
  }
  removeItem(key: string): void {
    this._store.delete(key);
  }
  clear(): void {
    this._store.clear();
  }
}

/**
 * Retrieve the active storage abstraction (localStorage if supported, else memory storage fallback).
 */
export function getStorage(): EnvironmentStorage {
  if (isBrowser()) {
    try {
      if (typeof window !== "undefined" && typeof window.localStorage !== "undefined") {
        return window.localStorage;
      }
    } catch {
      // In sandboxed iframe localStorage may throw
    }
  }
  return new MemoryStorage();
}
