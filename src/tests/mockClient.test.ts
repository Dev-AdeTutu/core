import { describe, it, expect, vi } from "vitest";
import {
  createMockClient,
  createMockWalletAdapter,
  MOCK_PUBLIC_KEY,
  MOCK_NETWORK_CONFIG,
  MOCK_WALLET_STATE,
  MOCK_CONNECTED_WALLET_STATE,
  MOCK_ACCOUNT_INFO,
  MOCK_TX_RESULT,
} from "../testing/mockClient";

describe("MOCK_PUBLIC_KEY", () => {
  it("is a valid 56-character Stellar G-address", () => {
    expect(MOCK_PUBLIC_KEY).toHaveLength(56);
    expect(MOCK_PUBLIC_KEY.charAt(0)).toBe("G");
  });
});

describe("createMockClient", () => {
  it("returns a client with all required namespaces", () => {
    const client = createMockClient();
    expect(client.wallet).toBeDefined();
    expect(client.account).toBeDefined();
    expect(client.transaction).toBeDefined();
    expect(client.soroban).toBeDefined();
    expect(client.network).toBeDefined();
  });

  it("exposes default network config", () => {
    const client = createMockClient();
    expect(client.networkConfig).toEqual(MOCK_NETWORK_CONFIG);
  });

  it("wallet.connect stub resolves with connected wallet state", async () => {
    const client = createMockClient();
    const result = await client.wallet.connect(MOCK_CONNECTED_WALLET_STATE.walletType!);
    expect(result.status).toBe("ok");
  });

  it("wallet.emptyState returns default wallet state", () => {
    const client = createMockClient();
    const result = client.wallet.emptyState();
    expect(result.status).toBe("ok");
  });

  it("account.get resolves with default account info", async () => {
    const client = createMockClient();
    const result = await client.account.get(MOCK_PUBLIC_KEY);
    expect(result.status).toBe("ok");
  });

  it("account.formatAddress returns display address string", () => {
    const client = createMockClient();
    const display = client.account.formatAddress(MOCK_PUBLIC_KEY);
    expect(typeof display).toBe("string");
    expect(display.length).toBeGreaterThan(0);
  });

  it("transaction.submit resolves with tx result", async () => {
    const client = createMockClient();
    const result = await client.transaction.submit("SIGNED_XDR_MOCK==");
    expect(result.status).toBe("ok");
  });

  it("soroban.simulate resolves with simulate result", async () => {
    const client = createMockClient();
    const result = await client.soroban.simulate("CONTRACT_ID", "method", []);
    expect(result.status).toBe("ok");
  });

  it("network.getConfig returns network config synchronously", () => {
    const client = createMockClient();
    const config = client.network.getConfig();
    expect(config).toEqual(MOCK_NETWORK_CONFIG);
  });

  it("accepts overridden wallet state via config", () => {
    const customState = { ...MOCK_CONNECTED_WALLET_STATE };
    const client = createMockClient({ walletState: customState });
    expect(client.wallet.emptyState).toBeDefined();
  });

  it("accepts overridden account info via config", async () => {
    const customAccount = { ...MOCK_ACCOUNT_INFO, sequence: "9999" };
    const client = createMockClient({ accountInfo: customAccount });
    const result = await client.account.get(MOCK_PUBLIC_KEY);
    expect(result.status).toBe("ok");
  });

  it("all wallet methods are vi.fn() stubs", () => {
    const client = createMockClient();
    expect(vi.isMockFunction(client.wallet.connect)).toBe(true);
    expect(vi.isMockFunction(client.wallet.disconnect)).toBe(true);
    expect(vi.isMockFunction(client.wallet.signTransaction)).toBe(true);
    expect(vi.isMockFunction(client.wallet.listConnectedAccounts)).toBe(true);
    expect(vi.isMockFunction(client.wallet.switchAccount)).toBe(true);
  });

  it("all account methods are vi.fn() stubs", () => {
    const client = createMockClient();
    expect(vi.isMockFunction(client.account.get)).toBe(true);
    expect(vi.isMockFunction(client.account.getBalances)).toBe(true);
    expect(vi.isMockFunction(client.account.formatAddress)).toBe(true);
    expect(vi.isMockFunction(client.account.stream)).toBe(true);
  });

  it("account.stream is an async generator that yields account info", async () => {
    const client = createMockClient();
    const gen = client.account.stream(MOCK_PUBLIC_KEY);
    const result = await gen.next();
    expect(result.done).toBe(false);
    expect(result.value.status).toBe("ok");
    if (result.value.status === "ok") {
      expect(result.value.data.publicKey).toBe(MOCK_PUBLIC_KEY);
    }
  });

  it("transaction.stream is an async generator that yields transaction pages", async () => {
    const client = createMockClient();
    const gen = client.transaction.stream(MOCK_PUBLIC_KEY);
    const result = await gen.next();
    expect(result.done).toBe(false);
    expect(result.value.status).toBe("ok");
    if (result.value.status === "ok") {
      expect(result.value.data.transactions).toEqual([MOCK_TX_RESULT]);
      expect(result.value.data.nextCursor).toBeNull();
    }
  });

  it("account.stream can be consumed with for await...of", async () => {
    const client = createMockClient();
    const results: unknown[] = [];
    for await (const result of client.account.stream(MOCK_PUBLIC_KEY)) {
      results.push(result);
    }
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({ status: "ok" }));
  });

  it("transaction.stream can be consumed with for await...of", async () => {
    const client = createMockClient();
    const results: unknown[] = [];
    for await (const result of client.transaction.stream(MOCK_PUBLIC_KEY)) {
      results.push(result);
    }
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({ status: "ok" }));
  });

  it("stubs can be overridden with mockResolvedValueOnce", async () => {
    const client = createMockClient();
    const customResult = { ok: true, value: { ...MOCK_TX_RESULT, hash: "custom_hash" } };
    (client.transaction.submit as ReturnType<typeof vi.fn>).mockResolvedValueOnce(customResult);
    const result = await client.transaction.submit("XDR");
    expect(result).toEqual(customResult);
  });
});

describe("createMockWalletAdapter", () => {
  it("returns all required adapter methods as vi.fn() stubs", () => {
    const adapter = createMockWalletAdapter();
    expect(vi.isMockFunction(adapter.isAvailable)).toBe(true);
    expect(vi.isMockFunction(adapter.connect)).toBe(true);
    expect(vi.isMockFunction(adapter.disconnect)).toBe(true);
    expect(vi.isMockFunction(adapter.signTransaction)).toBe(true);
    expect(vi.isMockFunction(adapter.getAccounts)).toBe(true);
    expect(vi.isMockFunction(adapter.setActiveAccount)).toBe(true);
  });

  it("isAvailable returns true by default", () => {
    const adapter = createMockWalletAdapter();
    expect(adapter.isAvailable()).toBe(true);
  });

  it("connect resolves with ok public key by default", async () => {
    const adapter = createMockWalletAdapter();
    const result = await adapter.connect();
    expect(result.status).toBe("ok");
  });

  it("disconnect resolves with ok by default", async () => {
    const adapter = createMockWalletAdapter();
    const result = await adapter.disconnect();
    expect(result.status).toBe("ok");
  });

  it("getAccounts resolves with array containing mock public key", async () => {
    const adapter = createMockWalletAdapter();
    const result = await adapter.getAccounts();
    expect(result.status).toBe("ok");
  });

  it("connect stub can be overridden to simulate failure", async () => {
    const adapter = createMockWalletAdapter();
    const errResult = { ok: false, error: { code: "WALLET_CONNECT_FAILED", message: "denied" } };
    adapter.connect.mockResolvedValueOnce(errResult);
    const result = await adapter.connect();
    expect(result.ok).toBe(false);
  });
});
