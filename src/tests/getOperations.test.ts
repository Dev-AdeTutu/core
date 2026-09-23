import { describe, it, expect, vi, beforeEach } from "vitest";
import { SorokitErrorCode } from "../shared/response";

// ─── Hoisted mock refs ────────────────────────────────────────────────────────

const { mockCall, mockForAccount, mockLimit, mockOrder, mockCursor, mockIncludeFailed } =
  vi.hoisted(() => ({
    mockCall: vi.fn(),
    mockForAccount: vi.fn(),
    mockLimit: vi.fn(),
    mockOrder: vi.fn(),
    mockCursor: vi.fn(),
    mockIncludeFailed: vi.fn(),
  }));

// ─── Stellar SDK mock ─────────────────────────────────────────────────────────

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  // Fluent builder — each method returns `this` so chains work.
  class MockOperationsBuilder {
    forAccount(...args: any[]) { mockForAccount(...args); return this; }
    limit(...args: any[]) { mockLimit(...args); return this; }
    order(...args: any[]) { mockOrder(...args); return this; }
    cursor(...args: any[]) { mockCursor(...args); return this; }
    includeFailed(...args: any[]) { mockIncludeFailed(...args); return this; }
    call(...args: any[]) { return mockCall(...args); }
  }

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        operations: () => new MockOperationsBuilder(),
      })),
    },
  };
});

// ─── Subject under test ───────────────────────────────────────────────────────

import { getOperations } from "../account/getOperations";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PUBLIC_KEY = "GBTABBLFJWSIJKGRVJMOV477L42GXCHFHGDUOCDMC7MXWASTPZKQNB25";
const OTHER_KEY  = "GAAL6LIAG2FGFQTKMUNGLCSCAM722PPYRVK2PXEMC6KNRRWLCFTYQD7R";

function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "123456789",
    paging_token: "123456789",
    source_account: PUBLIC_KEY,
    type: "payment",
    created_at: "2024-06-01T12:00:00Z",
    transaction_hash: "abc123",
    transaction_successful: true,
    ...overrides,
  };
}

function makePageOf(records: Record<string, unknown>[]) {
  return Promise.resolve({ records });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getOperations (#555)", () => {
  beforeEach(() => {
    mockCall.mockReset();
    mockForAccount.mockReset();
    mockLimit.mockReset();
    mockOrder.mockReset();
    mockCursor.mockReset();
    mockIncludeFailed.mockReset();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe("successful fetch", () => {
    it("returns ok with a page of operations", async () => {
      mockCall.mockReturnValue(makePageOf([makeRecord()]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations).toHaveLength(1);
      expect(result.data.operations[0]?.type).toBe("payment");
      expect(result.data.operations[0]?.id).toBe("123456789");
    });

    it("maps all base fields onto OperationInfo", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({
          id: "999",
          paging_token: "999-token",
          source_account: OTHER_KEY,
          type: "create_account",
          created_at: "2024-01-15T08:30:00Z",
          transaction_hash: "deadbeef",
          transaction_successful: false,
        }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const op = result.data.operations[0]!;
      expect(op.id).toBe("999");
      expect(op.pagingToken).toBe("999-token");
      expect(op.sourceAccount).toBe(OTHER_KEY);
      expect(op.type).toBe("create_account");
      expect(op.createdAt).toBe("2024-01-15T08:30:00Z");
      expect(op.transactionHash).toBe("deadbeef");
      expect(op.transactionSuccessful).toBe(false);
    });

    it("sets nextCursor to pagingToken of last record", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({ paging_token: "token-1" }),
        makeRecord({ id: "2", paging_token: "token-2" }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.nextCursor).toBe("token-2");
    });

    it("sets nextCursor to null when page is empty", async () => {
      mockCall.mockReturnValue(makePageOf([]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations).toHaveLength(0);
      expect(result.data.nextCursor).toBeNull();
    });

    it("exposes raw Horizon record on each operation", async () => {
      const record = makeRecord({ amount: "500", asset_code: "USDC" });
      mockCall.mockReturnValue(makePageOf([record]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations[0]?.raw["amount"]).toBe("500");
      expect(result.data.operations[0]?.raw["asset_code"]).toBe("USDC");
    });
  });

  // ── Pagination ──────────────────────────────────────────────────────────────

  describe("pagination", () => {
    it("passes limit to the builder", async () => {
      mockCall.mockReturnValue(makePageOf([]));

      await getOperations(HORIZON_URL, PUBLIC_KEY, { limit: 50 });

      expect(mockLimit).toHaveBeenCalledWith(50);
    });

    it("caps limit at 200", async () => {
      mockCall.mockReturnValue(makePageOf([]));

      await getOperations(HORIZON_URL, PUBLIC_KEY, { limit: 9999 });

      expect(mockLimit).toHaveBeenCalledWith(200);
    });

    it("defaults limit to 20 when not specified", async () => {
      mockCall.mockReturnValue(makePageOf([]));

      await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(mockLimit).toHaveBeenCalledWith(20);
    });

    it("passes cursor to the builder when provided", async () => {
      mockCall.mockReturnValue(makePageOf([]));

      await getOperations(HORIZON_URL, PUBLIC_KEY, { cursor: "my-cursor" });

      expect(mockCursor).toHaveBeenCalledWith("my-cursor");
    });

    it("does not call cursor when omitted", async () => {
      mockCall.mockReturnValue(makePageOf([]));

      await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(mockCursor).not.toHaveBeenCalled();
    });

    it("passes order to the builder", async () => {
      mockCall.mockReturnValue(makePageOf([]));

      await getOperations(HORIZON_URL, PUBLIC_KEY, { order: "asc" });

      expect(mockOrder).toHaveBeenCalledWith("asc");
    });

    it("defaults order to desc", async () => {
      mockCall.mockReturnValue(makePageOf([]));

      await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(mockOrder).toHaveBeenCalledWith("desc");
    });

    it("enables includeFailed when option is true", async () => {
      mockCall.mockReturnValue(makePageOf([]));

      await getOperations(HORIZON_URL, PUBLIC_KEY, { includeFailed: true });

      expect(mockIncludeFailed).toHaveBeenCalledWith(true);
    });

    it("does not call includeFailed when option is false or omitted", async () => {
      mockCall.mockReturnValue(makePageOf([]));

      await getOperations(HORIZON_URL, PUBLIC_KEY, { includeFailed: false });

      expect(mockIncludeFailed).not.toHaveBeenCalled();
    });
  });

  // ── Type filtering ──────────────────────────────────────────────────────────

  describe("type filtering", () => {
    it("returns only operations matching the requested type", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({ id: "1", type: "payment" }),
        makeRecord({ id: "2", type: "create_account" }),
        makeRecord({ id: "3", type: "payment" }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY, {
        type: "payment",
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations).toHaveLength(2);
      expect(result.data.operations.every((op) => op.type === "payment")).toBe(true);
    });

    it("returns empty array when no operations match the type filter", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({ type: "create_account" }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY, {
        type: "clawback",
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations).toHaveLength(0);
      expect(result.data.nextCursor).toBeNull();
    });

    it("returns all operations when no type filter is provided", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({ id: "1", type: "payment" }),
        makeRecord({ id: "2", type: "change_trust" }),
        makeRecord({ id: "3", type: "manage_sell_offer" }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations).toHaveLength(3);
    });
  });

  // ── Source account filtering ────────────────────────────────────────────────

  describe("source account filtering", () => {
    it("returns only operations from the specified source account", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({ id: "1", source_account: PUBLIC_KEY }),
        makeRecord({ id: "2", source_account: OTHER_KEY }),
        makeRecord({ id: "3", source_account: PUBLIC_KEY }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY, {
        sourceAccount: PUBLIC_KEY,
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations).toHaveLength(2);
      expect(
        result.data.operations.every((op) => op.sourceAccount === PUBLIC_KEY),
      ).toBe(true);
    });

    it("returns empty array when no operations match the source account filter", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({ source_account: OTHER_KEY }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY, {
        sourceAccount: PUBLIC_KEY,
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations).toHaveLength(0);
    });
  });

  // ── Date range filtering ────────────────────────────────────────────────────

  describe("date range filtering", () => {
    it("filters out operations before the 'after' date", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({ id: "1", created_at: "2024-01-01T00:00:00Z" }),
        makeRecord({ id: "2", created_at: "2024-06-15T00:00:00Z" }),
        makeRecord({ id: "3", created_at: "2024-12-01T00:00:00Z" }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY, {
        after: "2024-06-01T00:00:00Z",
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations).toHaveLength(2);
      expect(result.data.operations.map((op) => op.id)).toEqual(["2", "3"]);
    });

    it("filters out operations on or after the 'before' date", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({ id: "1", created_at: "2024-01-01T00:00:00Z" }),
        makeRecord({ id: "2", created_at: "2024-06-15T00:00:00Z" }),
        makeRecord({ id: "3", created_at: "2024-12-01T00:00:00Z" }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY, {
        before: "2024-06-15T00:00:00Z",
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations).toHaveLength(1);
      expect(result.data.operations[0]?.id).toBe("1");
    });

    it("applies both 'after' and 'before' to form a closed date range", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({ id: "1", created_at: "2024-01-01T00:00:00Z" }),
        makeRecord({ id: "2", created_at: "2024-05-01T00:00:00Z" }),
        makeRecord({ id: "3", created_at: "2024-09-01T00:00:00Z" }),
        makeRecord({ id: "4", created_at: "2024-12-01T00:00:00Z" }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY, {
        after:  "2024-03-01T00:00:00Z",
        before: "2024-10-01T00:00:00Z",
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations.map((op) => op.id)).toEqual(["2", "3"]);
    });

    it("returns empty array when no operations fall in the date range", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({ created_at: "2023-01-01T00:00:00Z" }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY, {
        after: "2024-01-01T00:00:00Z",
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations).toHaveLength(0);
    });
  });

  // ── Combined filters ────────────────────────────────────────────────────────

  describe("combined filters", () => {
    it("applies type and source account filters together", async () => {
      mockCall.mockReturnValue(makePageOf([
        makeRecord({ id: "1", type: "payment",        source_account: PUBLIC_KEY }),
        makeRecord({ id: "2", type: "create_account", source_account: PUBLIC_KEY }),
        makeRecord({ id: "3", type: "payment",        source_account: OTHER_KEY  }),
      ]));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY, {
        type:          "payment",
        sourceAccount: PUBLIC_KEY,
      });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.operations).toHaveLength(1);
      expect(result.data.operations[0]?.id).toBe("1");
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("returns ACCOUNT_NOT_FOUND when Horizon returns a 404", async () => {
      const notFound = new Error("Request failed with status code 404");
      (notFound as any).response = { status: 404 };
      mockCall.mockRejectedValue(notFound);

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
      expect(result.error.message).toContain(PUBLIC_KEY);
    });

    it("returns ACCOUNT_FETCH_FAILED for generic network errors", async () => {
      mockCall.mockRejectedValue(new Error("Network unreachable"));

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_FETCH_FAILED);
      expect(result.error.message).toContain(PUBLIC_KEY);
    });

    it("surfaces the original cause on error", async () => {
      const cause = new Error("timeout");
      mockCall.mockRejectedValue(cause);

      const result = await getOperations(HORIZON_URL, PUBLIC_KEY);

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.cause).toBe(cause);
    });
  });
});
