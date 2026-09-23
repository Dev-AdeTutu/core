import { describe, it, expect, vi, beforeEach } from "vitest";
import { Horizon } from "@stellar/stellar-sdk";
import * as serverFactory from "../shared/serverFactory";
import {
  exportTransactionHistory,
  formatTransactionsToCsv,
  formatTransactionsToJson,
} from "../transaction/exportTransactionHistory";
import type { ExportedTransaction } from "../transaction/exportTransactionHistory";
import { createSorokitClient } from "../client/createSorokitClient";
import { SorokitErrorCode } from "../shared/response";

const sampleRecords: ExportedTransaction[] = [
  {
    hash: "hash123",
    date: "2026-01-15T10:00:00Z",
    ledger: 1000,
    status: "success",
    type: "payment",
    sourceAccount: "GSOURCE123",
    destination: "GDEST456",
    asset: "XLM",
    amount: "100.5",
    fee: "100",
    memo: "Tax Payment",
  },
  {
    hash: "hash456",
    date: "2026-02-01T12:00:00Z",
    ledger: 1005,
    status: "success",
    type: "create_account",
    sourceAccount: "GSOURCE123",
    destination: "GNEWACCOUNT",
    asset: "XLM",
    amount: "50",
    fee: "100",
    memo: 'Memo with "quotes" and, comma',
  },
  {
    hash: "hash789",
    date: "2026-03-01T14:30:00Z",
    ledger: 1010,
    status: "failed",
    type: "payment",
    sourceAccount: "GSOURCE123",
    destination: "GDEST789",
    asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    amount: "250.75",
    fee: "200",
    memo: "Multi-line\nmemo",
  },
];

describe("formatTransactionsToCsv & formatTransactionsToJson", () => {
  it("formats transactions to valid CSV according to RFC 4180", () => {
    const csv = formatTransactionsToCsv(sampleRecords);
    const lines = csv.split("\r\n");

    expect(lines[0]).toBe("Hash,Date,Ledger,Status,Type,Source,Destination,Asset,Amount,Fee,Memo");
    expect(lines[1]).toBe("hash123,2026-01-15T10:00:00Z,1000,success,payment,GSOURCE123,GDEST456,XLM,100.5,100,Tax Payment");
    // Check RFC 4180 escaping for quotes and commas
    expect(lines[2]).toBe('hash456,2026-02-01T12:00:00Z,1005,success,create_account,GSOURCE123,GNEWACCOUNT,XLM,50,100,"Memo with ""quotes"" and, comma"');
    // Check RFC 4180 escaping for multi-line field
    expect(csv).toContain('"Multi-line\nmemo"');
  });

  it("formats empty transaction list to CSV headers only", () => {
    const csv = formatTransactionsToCsv([]);
    expect(csv).toBe("Hash,Date,Ledger,Status,Type,Source,Destination,Asset,Amount,Fee,Memo");
  });

  it("formats transactions to JSON string", () => {
    const jsonStr = formatTransactionsToJson(sampleRecords);
    const parsed = JSON.parse(jsonStr);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].hash).toBe("hash123");
    expect(parsed[1].memo).toBe('Memo with "quotes" and, comma');
  });
});

describe("exportTransactionHistory", () => {
  const horizonUrl = "https://horizon-testnet.stellar.org";
  const publicKey = "GSOURCE123";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("exports transaction history to CSV format by default", async () => {
    const mockTxRecords = [
      {
        hash: "txhash1",
        created_at: "2026-01-10T12:00:00Z",
        ledger_attr: 100,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        memo: "payment 1",
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

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({ transactions: vi.fn().mockReturnValue(mockBuilder) } as any);

    const result = await exportTransactionHistory(horizonUrl, publicKey);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data).toContain("Hash,Date,Ledger,Status,Type,Source,Destination,Asset,Amount,Fee,Memo");
      expect(result.data).toContain("txhash1");
      expect(result.data).toContain("payment 1");
    }
  });

  it("exports transaction history to JSON format", async () => {
    const mockTxRecords = [
      {
        hash: "txhashjson",
        created_at: "2026-01-12T12:00:00Z",
        ledger_attr: 102,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        memo: "json test",
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

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({ transactions: vi.fn().mockReturnValue(mockBuilder) } as any);

    const result = await exportTransactionHistory(horizonUrl, publicKey, { format: "json" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.data);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].hash).toBe("txhashjson");
      expect(parsed[0].memo).toBe("json test");
    }
  });

  it("adds configurable cost-basis fields to JSON exports", async () => {
    const mockTxRecords = [
      {
        hash: "txhashbasis",
        created_at: "2026-01-12T12:00:00Z",
        ledger_attr: 102,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        memo: "basis test",
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

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({ transactions: vi.fn().mockReturnValue(mockBuilder) } as any);

    const result = await exportTransactionHistory(horizonUrl, publicKey, {
      format: "json",
      costBasis: {
        unitCostByAsset: { XLM: "0.08" },
        proceedsUnitByAsset: { XLM: "0.12" },
        precision: 2,
      },
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.data);
      expect(parsed[0].costBasis).toBe("0.00");
      expect(parsed[0].proceeds).toBe("0.00");
      expect(parsed[0].gainLoss).toBe("0.00");
    }
  });

  it("filters by date range (fromDate / toDate)", async () => {
    // Records in ascending order (oldest first) matching order: "asc"
    const mockTxRecords = [
      {
        hash: "tx1",
        created_at: "2026-01-01T00:00:00Z",
        ledger_attr: 10,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        paging_token: "pt1",
      },
      {
        hash: "tx2",
        created_at: "2026-01-15T00:00:00Z",
        ledger_attr: 20,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        paging_token: "pt2",
      },
      {
        hash: "tx3",
        created_at: "2026-02-01T00:00:00Z",
        ledger_attr: 30,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
        paging_token: "pt3",
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

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({ transactions: vi.fn().mockReturnValue(mockBuilder) } as any);

    const result = await exportTransactionHistory(horizonUrl, publicKey, {
      format: "json",
      fromDate: "2026-01-10T00:00:00Z",
      toDate: "2026-01-20T00:00:00Z",
      order: "asc",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.data);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].hash).toBe("tx2");
    }
  });

  it("filters by operation type", async () => {
    const mockTxRecords = [
      {
        hash: "tx_type_test",
        created_at: "2026-01-15T00:00:00Z",
        ledger_attr: 20,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
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

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({ transactions: vi.fn().mockReturnValue(mockBuilder) } as any);

    // Matching filter
    const resultMatch = await exportTransactionHistory(horizonUrl, publicKey, {
      format: "json",
      type: "transaction",
    });
    expect(resultMatch.status).toBe("ok");
    if (resultMatch.status === "ok") {
      const parsed = JSON.parse(resultMatch.data);
      expect(parsed).toHaveLength(1);
    }

    // Non-matching filter
    const resultNoMatch = await exportTransactionHistory(horizonUrl, publicKey, {
      format: "json",
      type: "create_account",
    });
    expect(resultNoMatch.status).toBe("ok");
    if (resultNoMatch.status === "ok") {
      const parsed = JSON.parse(resultNoMatch.data);
      expect(parsed).toHaveLength(0);
    }
  });

  it("filters by asset and amount range", async () => {
    const mockTxRecords = [
      {
        hash: "tx_asset_amount",
        created_at: "2026-01-15T00:00:00Z",
        ledger_attr: 20,
        successful: true,
        fee_charged: 100,
        source_account: publicKey,
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

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({ transactions: vi.fn().mockReturnValue(mockBuilder) } as any);

    // Asset XLM match
    const resAsset = await exportTransactionHistory(horizonUrl, publicKey, {
      format: "json",
      asset: "XLM",
    });
    expect(resAsset.status).toBe("ok");
    if (resAsset.status === "ok") {
      const parsed = JSON.parse(resAsset.data);
      expect(parsed).toHaveLength(1);
    }

    // Amount out of range
    const resAmountHigh = await exportTransactionHistory(horizonUrl, publicKey, {
      format: "json",
      minAmount: 100,
    });
    expect(resAmountHigh.status).toBe("ok");
    if (resAmountHigh.status === "ok") {
      const parsed = JSON.parse(resAmountHigh.data);
      expect(parsed).toHaveLength(0);
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

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({ transactions: vi.fn().mockReturnValue(mockBuilder) } as any);

    const result = await exportTransactionHistory(horizonUrl, "GBOGUSACCOUNT");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
      expect(result.error.message).toContain("Account not found");
    }
  });
});

describe("SorokitClient.transaction.exportHistory integration", () => {
  it("exposes exportHistory and exportTransactionHistory on client.transaction", async () => {
    const clientResult = createSorokitClient({ network: "testnet" });
    expect(clientResult.status).toBe("ok");
    if (clientResult.status !== "ok") return;

    const client = clientResult.data;
    expect(typeof client.transaction.exportHistory).toBe("function");
    expect(typeof client.transaction.exportTransactionHistory).toBe("function");

    const mockTxRecords = [
      {
        hash: "client_tx_1",
        created_at: "2026-01-20T10:00:00Z",
        ledger_attr: 50,
        successful: true,
        fee_charged: 100,
        source_account: "GCLIENT123",
        memo: "client test",
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

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({ transactions: vi.fn().mockReturnValue(mockBuilder) } as any);

    const resCsv = await client.transaction.exportHistory("GCLIENT123");
    expect(resCsv.status).toBe("ok");
    if (resCsv.status === "ok") {
      expect(resCsv.data).toContain("client_tx_1");
    }

    const resJson = await client.transaction.exportTransactionHistory("GCLIENT123", { format: "json" });
    expect(resJson.status).toBe("ok");
    if (resJson.status === "ok") {
      const parsed = JSON.parse(resJson.data);
      expect(parsed[0].hash).toBe("client_tx_1");
    }
  });
});
