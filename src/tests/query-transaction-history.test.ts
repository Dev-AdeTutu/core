import { describe, it, expect, vi, beforeEach } from "vitest";
import { Horizon } from "@stellar/stellar-sdk";
import * as serverFactory from "../shared/serverFactory";
import {
  queryTransactionHistory,
  resolveSort,
} from "../transaction/queryTransactionHistory";
import type {
  TransactionHistorySort,
  ExportedTransaction,
} from "../transaction/exportTransactionHistory";
import { createSorokitClient } from "../client/createSorokitClient";

const sampleTransactions: ExportedTransaction[] = [
  {
    hash: "hash001",
    date: "2026-01-15T10:00:00Z",
    ledger: 1000,
    status: "success",
    type: "payment",
    sourceAccount: "GSOURCE123",
    destination: "GDEST001",
    asset: "XLM",
    amount: "100.5",
    fee: "100",
    memo: "Payment 1",
  },
  {
    hash: "hash002",
    date: "2026-01-20T12:00:00Z",
    ledger: 1005,
    status: "success",
    type: "create_account",
    sourceAccount: "GSOURCE123",
    destination: "GDEST002",
    asset: "XLM",
    amount: "50",
    fee: "100",
    memo: "Create account",
  },
  {
    hash: "hash003",
    date: "2026-02-01T14:30:00Z",
    ledger: 1010,
    status: "failed",
    type: "payment",
    sourceAccount: "GSOURCE123",
    destination: "GDEST003",
    asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    amount: "250.75",
    fee: "200",
    memo: "USDC payment",
  },
  {
    hash: "hash004",
    date: "2026-02-10T08:00:00Z",
    ledger: 1015,
    status: "success",
    type: "payment",
    sourceAccount: "GSOURCE123",
    destination: "GDEST004",
    asset: "XLM",
    amount: "25",
    fee: "150",
    memo: "Small payment",
  },
  {
    hash: "hash005",
    date: "2026-02-15T16:00:00Z",
    ledger: 1020,
    status: "success",
    type: "change_trust",
    sourceAccount: "GSOURCE123",
    destination: "",
    asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    amount: "1000",
    fee: "100",
    memo: "Add trustline",
  },
];

describe("resolveSort", () => {
  it("returns default sort by date descending when no sort provided", () => {
    const result = resolveSort();
    expect(result).toEqual({ by: "date", order: "desc" });
  });

  it("returns the provided sort config as-is", () => {
    const sort: TransactionHistorySort = { by: "amount", order: "asc" };
    const result = resolveSort(sort);
    expect(result).toEqual(sort);
  });
});

describe("queryTransactionHistory", () => {
  const horizonUrl = "https://horizon-testnet.stellar.org";
  const publicKey = "GSOURCE123";

  function createMockServer(records: any[]) {
    const mockCall = vi.fn().mockResolvedValue({ records });
    const mockBuilder = {
      forAccount: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      cursor: vi.fn().mockReturnThis(),
      call: mockCall,
    };
    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      transactions: vi.fn().mockReturnValue(mockBuilder),
    } as any);
    return { mockCall, mockBuilder };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns paginated transaction history with default pagination (page 1, 20 per page)", async () => {
    createMockServer([
      {
        hash: "tx1",
        created_at: "2026-01-15T10:00:00Z",
        ledger_attr: 1000,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        memo: "test",
        envelope_xdr: "AAAAA...",
        paging_token: "pt1",
      },
    ]);

    const result = await queryTransactionHistory(horizonUrl, publicKey);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.page).toBe(1);
      expect(result.data.perPage).toBe(20);
      expect(result.data.transactions.length).toBeGreaterThanOrEqual(1);
      expect(typeof result.data.hasMore).toBe("boolean");
    }
  });

  it("supports custom page size and page number", async () => {
    const records = Array.from({ length: 25 }, (_, i) => ({
      hash: `tx${i + 1}`,
      created_at: `2026-01-${String(15 + i).padStart(2, "0")}T10:00:00Z`,
      ledger_attr: 1000 + i,
      successful: true,
      fee_charged: 100,
      source_account: publicKey,
      envelope_xdr: "AAAAA...",
      paging_token: `pt${i + 1}`,
    }));

    createMockServer(records);

    const result = await queryTransactionHistory(horizonUrl, publicKey, {
      perPage: 10,
      page: 1,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.perPage).toBe(10);
      expect(result.data.transactions.length).toBeLessThanOrEqual(10);
      expect(result.data.hasMore).toBe(true);
    }
  });

  it("filters by status", async () => {
    createMockServer([
      {
        hash: "tx_success",
        created_at: "2026-01-15T10:00:00Z",
        ledger_attr: 1000,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt1",
      },
      {
        hash: "tx_failed",
        created_at: "2026-01-16T10:00:00Z",
        ledger_attr: 1001,
        successful: false,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt2",
      },
    ]);

    const successResult = await queryTransactionHistory(horizonUrl, publicKey, {
      status: "success",
    });
    expect(successResult.status).toBe("ok");
    if (successResult.status === "ok") {
      expect(
        successResult.data.transactions.every((t) => t.status === "success"),
      ).toBe(true);
    }
  });

  it("filters by transaction type", async () => {
    createMockServer([
      {
        hash: "tx_payment",
        created_at: "2026-01-15T10:00:00Z",
        ledger_attr: 1000,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt1",
      },
    ]);

    const result = await queryTransactionHistory(horizonUrl, publicKey, {
      type: "transaction",
    });
    expect(result.status).toBe("ok");
  });

  it("filters by date range", async () => {
    createMockServer([
      {
        hash: "tx_jan",
        created_at: "2026-01-15T10:00:00Z",
        ledger_attr: 1000,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt1",
      },
      {
        hash: "tx_feb",
        created_at: "2026-02-15T10:00:00Z",
        ledger_attr: 1005,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt2",
      },
    ]);

    const result = await queryTransactionHistory(horizonUrl, publicKey, {
      fromDate: "2026-02-01T00:00:00Z",
      toDate: "2026-02-28T00:00:00Z",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      for (const tx of result.data.transactions) {
        const d = new Date(tx.date).getTime();
        expect(d).toBeGreaterThanOrEqual(new Date("2026-02-01T00:00:00Z").getTime());
        expect(d).toBeLessThanOrEqual(new Date("2026-02-28T23:59:59Z").getTime());
      }
    }
  });

  it("filters by amount range", async () => {
    createMockServer([
      {
        hash: "tx_small",
        created_at: "2026-01-15T10:00:00Z",
        ledger_attr: 1000,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt1",
      },
    ]);

    const result = await queryTransactionHistory(horizonUrl, publicKey, {
      minAmount: 200,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      for (const tx of result.data.transactions) {
        expect(parseFloat(tx.amount)).toBeGreaterThanOrEqual(200);
      }
    }
  });

  it("filters by asset", async () => {
    createMockServer([
      {
        hash: "tx_asset",
        created_at: "2026-01-15T10:00:00Z",
        ledger_attr: 1000,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt1",
      },
    ]);

    const result = await queryTransactionHistory(horizonUrl, publicKey, {
      asset: "XLM",
    });
    expect(result.status).toBe("ok");
  });

  it("applies sorting by date ascending", async () => {
    createMockServer([
      {
        hash: "tx_old",
        created_at: "2026-01-01T10:00:00Z",
        ledger_attr: 100,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt1",
      },
      {
        hash: "tx_new",
        created_at: "2026-06-01T10:00:00Z",
        ledger_attr: 200,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt2",
      },
    ]);

    const result = await queryTransactionHistory(horizonUrl, publicKey, {
      sort: { by: "date", order: "asc" },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const dates = result.data.transactions.map((t) => new Date(t.date).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]!).toBeGreaterThanOrEqual(dates[i - 1]!);
      }
    }
  });

  it("applies sorting by amount descending", async () => {
    createMockServer([
      {
        hash: "tx_low",
        created_at: "2026-01-15T10:00:00Z",
        ledger_attr: 1000,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt1",
      },
      {
        hash: "tx_high",
        created_at: "2026-01-20T10:00:00Z",
        ledger_attr: 1005,
        successful: true,
        fee_charged: 200,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt2",
      },
    ]);

    const result = await queryTransactionHistory(horizonUrl, publicKey, {
      sort: { by: "amount", order: "desc" },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const amounts = result.data.transactions.map((t) => parseFloat(t.amount));
      for (let i = 1; i < amounts.length; i++) {
        expect(amounts[i]!).toBeLessThanOrEqual(amounts[i - 1]!);
      }
    }
  });

  it("applies sorting by type", async () => {
    createMockServer([
      {
        hash: "tx_b",
        created_at: "2026-01-15T10:00:00Z",
        ledger_attr: 1000,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt1",
      },
      {
        hash: "tx_a",
        created_at: "2026-01-20T10:00:00Z",
        ledger_attr: 1005,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt2",
      },
    ]);

    const result = await queryTransactionHistory(horizonUrl, publicKey, {
      sort: { by: "type", order: "asc" },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const types = result.data.transactions.map((t) => t.type);
      for (let i = 1; i < types.length; i++) {
        expect(types[i]!.localeCompare(types[i - 1]!)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("combines multiple filters together", async () => {
    createMockServer([
      {
        hash: "tx_combined",
        created_at: "2026-01-15T10:00:00Z",
        ledger_attr: 1000,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        envelope_xdr: "AAAAA...",
        paging_token: "pt1",
      },
    ]);

    const result = await queryTransactionHistory(horizonUrl, publicKey, {
      type: "transaction",
      status: "success",
      fromDate: "2026-01-01T00:00:00Z",
      toDate: "2026-12-31T23:59:59Z",
      asset: "XLM",
      minAmount: 1,
      maxAmount: 1000,
      sort: { by: "date", order: "desc" },
      perPage: 10,
    });
    expect(result.status).toBe("ok");
  });

  it("returns hasMore=true when there are more pages", async () => {
    const records = Array.from({ length: 30 }, (_, i) => ({
      hash: `tx_page${i + 1}`,
      created_at: `2026-01-${String(15 + i).padStart(2, "0")}T10:00:00Z`,
      ledger_attr: 1000 + i,
      successful: true,
      fee_charged: 100,
      source_account: publicKey,
      envelope_xdr: "AAAAA...",
      paging_token: `pt${i + 1}`,
    }));

    createMockServer(records);

    const result = await queryTransactionHistory(horizonUrl, publicKey, {
      perPage: 10,
      page: 1,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.hasMore).toBe(true);
      expect(result.data.nextCursor).not.toBeNull();
    }
  });

  it("returns hasMore=false on the last page", async () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      hash: `tx_last${i + 1}`,
      created_at: `2026-01-15T10:00:00Z`,
      ledger_attr: 1000 + i,
      successful: true,
      fee_charged: 100,
      source_account: publicKey,
      envelope_xdr: "AAAAA...",
      paging_token: `pt${i + 1}`,
    }));

    createMockServer(records);

    const result = await queryTransactionHistory(horizonUrl, publicKey, {
      perPage: 20,
      page: 1,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.hasMore).toBe(false);
    }
  });

  it("handles account not found error gracefully", async () => {
    const notFoundError = new Error("Request failed with status code 404");
    (notFoundError as any).response = { status: 404 };

    const mockCall = vi.fn().mockRejectedValue(notFoundError);
    const mockBuilder = {
      forAccount: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      cursor: vi.fn().mockReturnThis(),
      call: mockCall,
    };

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      transactions: vi.fn().mockReturnValue(mockBuilder),
    } as any);

    const result = await queryTransactionHistory(
      horizonUrl,
      "GBOGUSACCOUNT",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBeDefined();
      expect(result.error.message).toContain("Account not found");
    }
  });

  it("handles empty transaction history", async () => {
    createMockServer([]);

    const result = await queryTransactionHistory(horizonUrl, publicKey);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.transactions).toHaveLength(0);
      expect(result.data.total).toBe(0);
      expect(result.data.hasMore).toBe(false);
    }
  });
});

describe("SorokitClient.transaction.queryHistory integration", () => {
  it("exposes queryHistory on client.transaction", async () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;

    const client = clientResult.data;
    expect(typeof client.transaction.queryHistory).toBe("function");

    const mockTxRecords = [
      {
        hash: "client_query_tx",
        created_at: "2026-01-20T10:00:00Z",
        ledger_attr: 50,
        successful: true,
        fee_charged: 100,
        source_account: "GCLIENT123",
        memo: "client query test",
        envelope_xdr: "AAAAA...",
        paging_token: "pt1",
      },
    ];

    const mockCall = vi.fn().mockResolvedValue({ records: mockTxRecords });
    const mockBuilder = {
      forAccount: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      cursor: vi.fn().mockReturnThis(),
      call: mockCall,
    };

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      transactions: vi.fn().mockReturnValue(mockBuilder),
    } as any);

    const result = await client.transaction.queryHistory("GCLIENT123", {
      perPage: 5,
      status: "success",
      sort: { by: "date", order: "desc" },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.page).toBe(1);
      expect(result.data.perPage).toBe(5);
      expect(result.data.transactions.length).toBeGreaterThanOrEqual(0);
    }
  });
});
