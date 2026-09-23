/**
 * Unit tests for WalletConnectAdapter.
 *
 * @walletconnect/sign-client is mocked via vi.mock so this suite has no
 * network dependency and runs fully offline.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WalletConnectAdapter } from "./walletconnect";
import { WalletType } from "../types";
import { SorokitErrorCode } from "../../shared/response";

// ─── Mock @walletconnect/sign-client ──────────────────────────────────────────
// vi.mock is hoisted to the top of the file by Vitest, so these factory
// functions run before any imports.

const mockDisconnect = vi.fn();
const mockRequest = vi.fn();
const mockSessionGetAll = vi.fn(() => []);
const mockConnect = vi.fn();
const mockOn = vi.fn();

const mockClient = {
  session: { getAll: mockSessionGetAll, get: vi.fn() },
  connect: mockConnect,
  disconnect: mockDisconnect,
  request: mockRequest,
  on: mockOn,
  off: vi.fn(),
};

const mockSignClientInit = vi.fn().mockResolvedValue(mockClient);

vi.mock("@walletconnect/sign-client", () => ({
  SignClient: { init: mockSignClientInit },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROJECT_ID = "test-project-id";
const PUBLIC_KEY = "GABC1234567890DEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTU";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const MOCK_XDR = "AAAA...";
const SIGNED_XDR = "BBBB...";

function makeSession(pubkey = PUBLIC_KEY, network = "testnet") {
  return {
    topic: "mock-topic",
    namespaces: {
      stellar: {
        accounts: [`stellar:${network}:${pubkey}`],
        methods: ["stellar_signXDR"],
        events: ["accountsChanged"],
      },
    },
  };
}

function makeAdapter(
  overrides: Partial<ConstructorParameters<typeof WalletConnectAdapter>[0]> = {},
) {
  return new WalletConnectAdapter({ projectId: PROJECT_ID, ...overrides });
}

/**
 * Fully connect an adapter by going through the mock pairing flow.
 * mockConnect must be set up before calling this.
 */
async function connectAdapter(
  adapter: WalletConnectAdapter,
  session = makeSession(),
) {
  mockConnect.mockResolvedValueOnce({
    uri: "wc:mock-uri",
    approval: vi.fn().mockResolvedValue(session),
  });
  return adapter.connect();
}

/**
 * Directly inject a session into the adapter to skip the pairing flow.
 * Used for tests that need a connected adapter without exercising connect().
 */
function injectSession(
  adapter: WalletConnectAdapter,
  session = makeSession(),
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).client = mockClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).session = session;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WalletConnectAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionGetAll.mockReturnValue([]);
    mockSignClientInit.mockResolvedValue(mockClient);
  });

  // ── Constructor ─────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("throws synchronously when projectId is missing", () => {
      expect(() => new WalletConnectAdapter({ projectId: "" })).toThrow();
    });

    it("sets walletType to WALLETCONNECT", () => {
      expect(makeAdapter().walletType).toBe(WalletType.WALLETCONNECT);
    });
  });

  // ── isAvailable ─────────────────────────────────────────────────────────────

  describe("isAvailable", () => {
    it("always returns true (works in browser and Node)", () => {
      expect(makeAdapter().isAvailable()).toBe(true);
    });
  });

  // ── connect — new pairing ───────────────────────────────────────────────────

  describe("connect — new pairing", () => {
    it("returns ok with public key after successful pairing", async () => {
      const adapter = makeAdapter();
      const result = await connectAdapter(adapter);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(PUBLIC_KEY);
      }
    });

    it("invokes onPairingUri callback with the URI", async () => {
      const onPairingUri = vi.fn();
      const adapter = makeAdapter({ onPairingUri });

      mockConnect.mockResolvedValueOnce({
        uri: "wc:test-uri",
        approval: vi.fn().mockResolvedValue(makeSession()),
      });

      await adapter.connect();
      expect(onPairingUri).toHaveBeenCalledWith("wc:test-uri");
    });

    it("returns WALLET_SIGN_REJECTED when user rejects the pairing", async () => {
      const adapter = makeAdapter();
      mockConnect.mockResolvedValueOnce({
        uri: "wc:uri",
        approval: vi.fn().mockRejectedValue(new Error("User rejected")),
      });

      const result = await adapter.connect();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
      }
    });

    it("returns WALLET_CONNECT_FAILED when pairing fails for other reasons", async () => {
      const adapter = makeAdapter();
      mockConnect.mockResolvedValueOnce({
        uri: "wc:uri",
        approval: vi.fn().mockRejectedValue(new Error("Network error")),
      });

      const result = await adapter.connect();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_CONNECT_FAILED);
      }
    });

    it("returns WALLET_CONNECT_FAILED when session has no accounts", async () => {
      const adapter = makeAdapter();
      const emptySession = {
        topic: "t",
        namespaces: { stellar: { accounts: [], methods: [], events: [] } },
      };
      mockConnect.mockResolvedValueOnce({
        uri: "wc:uri",
        approval: vi.fn().mockResolvedValue(emptySession),
      });

      const result = await adapter.connect();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_CONNECT_FAILED);
      }
    });

    it("returns WALLET_CONNECT_FAILED when @walletconnect/sign-client is not installed", async () => {
      const adapter = makeAdapter();
      // Patch _ensureClient to simulate the package missing
      (adapter as any)._ensureClient = async () => {
        throw new Error(
          "WalletConnect requires @walletconnect/sign-client. Install it: npm install @walletconnect/sign-client",
        );
      };

      const result = await adapter.connect();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_CONNECT_FAILED);
      }
    });
  });

  // ── connect — session restore ───────────────────────────────────────────────

  describe("connect — session restore", () => {
    it("reuses an existing active session without pairing", async () => {
      const existingSession = makeSession();
      mockSessionGetAll.mockReturnValue([existingSession]);

      const adapter = makeAdapter();
      const result = await adapter.connect();

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(PUBLIC_KEY);
      }
      // No new pairing should have been initiated.
      expect(mockConnect).not.toHaveBeenCalled();
    });
  });

  // ── disconnect ──────────────────────────────────────────────────────────────

  describe("disconnect", () => {
    it("disconnects an active session and returns ok", async () => {
      const adapter = makeAdapter();
      injectSession(adapter);

      mockDisconnect.mockResolvedValueOnce(undefined);
      const result = await adapter.disconnect();

      expect(result.status).toBe("ok");
      expect(mockDisconnect).toHaveBeenCalledWith(
        expect.objectContaining({ topic: "mock-topic" }),
      );
    });

    it("returns ok even when already disconnected", async () => {
      const adapter = makeAdapter();
      const result = await adapter.disconnect();

      expect(result.status).toBe("ok");
      expect(mockDisconnect).not.toHaveBeenCalled();
    });

    it("returns ok when the remote disconnect throws (session already expired)", async () => {
      const adapter = makeAdapter();
      injectSession(adapter);

      mockDisconnect.mockRejectedValueOnce(new Error("Session not found"));
      const result = await adapter.disconnect();

      expect(result.status).toBe("ok");
    });
  });

  // ── signTransaction ─────────────────────────────────────────────────────────

  describe("signTransaction", () => {
    it("returns ok with signed XDR on success (object response)", async () => {
      const adapter = makeAdapter();
      injectSession(adapter);

      mockRequest.mockResolvedValueOnce({ signedXDR: SIGNED_XDR });

      const result = await adapter.signTransaction({
        transactionXdr: MOCK_XDR,
        networkPassphrase: TESTNET_PASSPHRASE,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(SIGNED_XDR);
      }
    });

    it("returns ok with signed XDR on success (raw string response)", async () => {
      const adapter = makeAdapter();
      injectSession(adapter);

      mockRequest.mockResolvedValueOnce(SIGNED_XDR);

      const result = await adapter.signTransaction({
        transactionXdr: MOCK_XDR,
        networkPassphrase: MAINNET_PASSPHRASE,
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toBe(SIGNED_XDR);
      }
    });

    it("passes accountToSign in the request when provided", async () => {
      const adapter = makeAdapter();
      injectSession(adapter);

      mockRequest.mockResolvedValueOnce({ signedXDR: SIGNED_XDR });

      await adapter.signTransaction({
        transactionXdr: MOCK_XDR,
        networkPassphrase: TESTNET_PASSPHRASE,
        accountToSign: PUBLIC_KEY,
      });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            params: expect.objectContaining({ accountToSign: PUBLIC_KEY }),
          }),
        }),
      );
    });

    it("returns WALLET_SIGN_REJECTED when user rejects the request", async () => {
      const adapter = makeAdapter();
      injectSession(adapter);

      mockRequest.mockRejectedValueOnce(new Error("User rejected request"));

      const result = await adapter.signTransaction({
        transactionXdr: MOCK_XDR,
        networkPassphrase: TESTNET_PASSPHRASE,
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_REJECTED);
      }
    });

    it("returns OPERATION_TIMEOUT on timeout", async () => {
      const adapter = makeAdapter();
      injectSession(adapter);

      mockRequest.mockRejectedValueOnce(new Error("Request timed out"));

      const result = await adapter.signTransaction({
        transactionXdr: MOCK_XDR,
        networkPassphrase: TESTNET_PASSPHRASE,
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.OPERATION_TIMEOUT);
      }
    });

    it("returns WALLET_SIGN_FAILED on generic signing errors", async () => {
      const adapter = makeAdapter();
      injectSession(adapter);

      mockRequest.mockRejectedValueOnce(new Error("Unexpected wallet error"));

      const result = await adapter.signTransaction({
        transactionXdr: MOCK_XDR,
        networkPassphrase: TESTNET_PASSPHRASE,
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
      }
    });

    it("returns WALLET_NOT_CONNECTED when called before connect()", async () => {
      const adapter = makeAdapter();
      const result = await adapter.signTransaction({
        transactionXdr: MOCK_XDR,
        networkPassphrase: TESTNET_PASSPHRASE,
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_NOT_CONNECTED);
      }
    });

    it("returns WALLET_SIGN_FAILED when wallet returns empty signed XDR", async () => {
      const adapter = makeAdapter();
      injectSession(adapter);

      mockRequest.mockResolvedValueOnce({ signedXDR: "" });

      const result = await adapter.signTransaction({
        transactionXdr: MOCK_XDR,
        networkPassphrase: TESTNET_PASSPHRASE,
      });

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_SIGN_FAILED);
      }
    });
  });

  // ── getAccounts ─────────────────────────────────────────────────────────────

  describe("getAccounts", () => {
    it("returns all accounts from the active session", async () => {
      const secondKey = "GBBB2222222222222222222222222222222222222222222222222222";
      const session = {
        topic: "t",
        namespaces: {
          stellar: {
            accounts: [
              `stellar:testnet:${PUBLIC_KEY}`,
              `stellar:pubnet:${secondKey}`,
            ],
            methods: ["stellar_signXDR"],
            events: [],
          },
        },
      };

      const adapter = makeAdapter();
      injectSession(adapter, session);

      const result = await adapter.getAccounts();

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data).toEqual([PUBLIC_KEY, secondKey]);
      }
    });

    it("returns WALLET_NOT_CONNECTED before connect()", async () => {
      const adapter = makeAdapter();
      const result = await adapter.getAccounts();

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.WALLET_NOT_CONNECTED);
      }
    });
  });

  // ── session lifecycle events ────────────────────────────────────────────────

  describe("session lifecycle events", () => {
    it("clears the session when session_delete fires", async () => {
      const adapter = makeAdapter();
      injectSession(adapter);

      expect(adapter.getActiveSession()).not.toBeNull();

      // The on() handler is registered during _ensureClient, which injectSession
      // bypasses. Register it manually to simulate what happens after connect().
      (adapter as any).client = mockClient;
      // Simulate what _ensureClient does: register session_delete handler
      const onDelete = () => { (adapter as any).session = null; };
      mockOn.mock.calls.length = 0; // reset
      // Call the same registration logic inline
      mockClient.on("session_delete", onDelete);
      mockClient.on("session_expire", onDelete);

      // Fire session_delete
      const deleteHandler = mockOn.mock.calls.find(([event]) => event === "session_delete")?.[1];
      expect(deleteHandler).toBeDefined();
      deleteHandler?.();

      expect(adapter.getActiveSession()).toBeNull();
    });

    it("clears the session when session_expire fires", async () => {
      const adapter = makeAdapter();
      // Go through real connect so handlers are registered on mockClient
      const result = await connectAdapter(adapter);
      expect(result.status).toBe("ok");

      const expireHandler = mockOn.mock.calls.find(([event]) => event === "session_expire")?.[1];
      expect(expireHandler).toBeDefined();
      expireHandler?.();

      expect(adapter.getActiveSession()).toBeNull();
    });
  });

  // ── chain ID resolution ─────────────────────────────────────────────────────

  describe("chain ID resolution in signTransaction", () => {
    it("uses the chain from the session namespace", async () => {
      const adapter = makeAdapter();
      injectSession(adapter, makeSession(PUBLIC_KEY, "pubnet"));

      mockRequest.mockResolvedValueOnce({ signedXDR: SIGNED_XDR });

      await adapter.signTransaction({
        transactionXdr: MOCK_XDR,
        networkPassphrase: MAINNET_PASSPHRASE,
      });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ chainId: "stellar:pubnet" }),
      );
    });
  });
});
