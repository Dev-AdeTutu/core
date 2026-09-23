import { describe, it, expect } from "vitest";
import {
  isBrowser,
  isNode,
  getEnvironment,
  timers,
  crypto as envCrypto,
  getStorage,
  MemoryStorage,
} from "../shared/environment";

describe("environment abstraction", () => {
  it("correctly identifies Node.js runtime environment", () => {
    expect(isNode()).toBe(true);
    expect(isBrowser()).toBe(false);
    expect(getEnvironment()).toBe("node");
  });

  it("provides functional timer abstraction", async () => {
    let fired = false;
    const id = timers.setTimeout(() => {
      fired = true;
    }, 10);
    expect(id).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fired).toBe(true);

    let cancelFired = false;
    const cancelId = timers.setTimeout(() => {
      cancelFired = true;
    }, 50);
    timers.clearTimeout(cancelId);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(cancelFired).toBe(false);
  });

  it("provides crypto abstraction for random bytes", () => {
    const bytes = envCrypto.randomBytes(16);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(16);
  });

  it("provides storage abstraction with memory fallback", () => {
    const storage = getStorage();
    expect(storage).toBeDefined();

    storage.setItem("test-key", "test-val");
    expect(storage.getItem("test-key")).toBe("test-val");
    storage.removeItem("test-key");
    expect(storage.getItem("test-key")).toBeNull();

    const memStorage = new MemoryStorage();
    memStorage.setItem("a", "1");
    expect(memStorage.getItem("a")).toBe("1");
    memStorage.clear();
    expect(memStorage.getItem("a")).toBeNull();
  });
});
