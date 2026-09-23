import { describe, it, expect } from "vitest";
import type { AccountInfo, AssetBalance } from "../account/types";
import type {
  ContractCallResult,
  PreparedContractCall,
  SimulateTransactionResult,
  ContractMethod,
} from "../soroban/types";
import type { TransactionResult } from "../transaction/types";
import type { FeeEstimate } from "../transaction/estimateFee";
import type { TransactionPage } from "../transaction/streamTransactions";
import type { DestinationValidationResult } from "../transaction/validateDestination";
import type { ExportedTransaction } from "../transaction/exportTransactionHistory";

// ─── Testnet Fixtures ─────────────────────────────────────────────────────────

const TESTNET_PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const TESTNET_CONTRACT_ID = "CCW67TSBVMGTV253TZ4E2ZHW0XB8WGA3B3DGF7T9B2J5Y65P2D0A5L1A";
const TESTNET_TX_HASH = "912384a5b6c7d8e9f0123456789abcdef0123456789abcdef0123456789abcdef";

const mockAccountInfo: AccountInfo = {
  id: TESTNET_PUBLIC_KEY,
  sequence: "123456789012345",
  subentryCount: 2,
  balances: [
    {
      assetType: "native",
      balance: "1000.5000000",
      limit: undefined,
      assetCode: undefined,
      assetIssuer: undefined,
      buyingLiabilities: "0.0000000",
      sellingLiabilities: "0.0000000",
    },
    {
      assetType: "credit_alphanum4",
      balance: "250.0000000",
      assetCode: "USDC",
      assetIssuer: TESTNET_USDC_ISSUER,
      limit: "100000.0000000",
      buyingLiabilities: "0.0000000",
      sellingLiabilities: "0.0000000",
      isAuthorized: true,
      isClawbackEnabled: false,
    },
  ],
  thresholds: {
    lowThreshold: 0,
    medThreshold: 1,
    highThreshold: 2,
  },
  flags: {
    authRequired: false,
    authRevocable: false,
    authImmutable: false,
    authClawbackEnabled: false,
  },
  signers: [
    {
      key: TESTNET_PUBLIC_KEY,
      weight: 1,
      type: "ed25519_public_key",
    },
  ],
  data: {
    domain: "dGVzdG5ldC5zdGVsbGFyLm9yZw==",
  },
};

const mockAssetBalances: AssetBalance[] = [
  {
    assetType: "native",
    balance: "1000.5000000",
  },
  {
    assetType: "credit_alphanum4",
    balance: "250.0000000",
    assetCode: "USDC",
    assetIssuer: TESTNET_USDC_ISSUER,
    limit: "100000.0000000",
    isAuthorized: true,
  },
];

const mockAccountsBatchResult: AccountInfo[] = [
  mockAccountInfo,
  {
    ...mockAccountInfo,
    id: "GBXGQJWVLWOYHFLVTKWVVTJRJL6YZKXOKROVDDUBCW2STX2TM722WDOH",
    sequence: "987654321098765",
  },
];

const mockContractCallResult: ContractCallResult = {
  xdr: "AAAAEgAAAAEAAAAAAA==",
  value: {
    symbol: "USDC",
    decimals: 7,
    name: "USD Coin",
  },
  minResourceFee: "1500",
  simulation: {
    transactionData: "AAAAAAAAAAAAAA==",
    events: [],
    minResourceFee: "1500",
  },
};

const mockPreparedContractCall: PreparedContractCall = {
  builtXdr: "AAAAAgAAAAD...",
  simulatedXdr: "AAAAAwAAAAD...",
  assembledXdr: "AAAABAAAAAD...",
  minFee: "2000",
  simulation: {
    success: true,
    minResourceFee: "2000",
    results: [
      {
        xdr: "AAAAEgAAAAE=",
        auth: [],
      },
    ],
    events: [
      {
        type: "contract",
        contractId: TESTNET_CONTRACT_ID,
        topics: ["AAAADwAAAAR0cmFuc2Zlcg=="],
        value: "AAAAEgAAAAE=",
      },
    ],
  },
};

const mockSimulateTransactionResult: SimulateTransactionResult = {
  success: true,
  minResourceFee: "1200",
  results: [
    {
      xdr: "AAAAEgAAAAE=",
      auth: [],
    },
  ],
  events: [
    {
      type: "system",
      contractId: TESTNET_CONTRACT_ID,
      topics: ["AAAADwAAAGluaXQ="],
      value: "AAAAEgAAAAA=",
    },
  ],
};

const mockContractMethods: ContractMethod[] = [
  {
    name: "balance",
    inputs: [{ name: "id", type: "Address" }],
    outputs: [{ type: "i128" }],
    docs: "Get account balance for contract",
  },
  {
    name: "transfer",
    inputs: [
      { name: "from", type: "Address" },
      { name: "to", type: "Address" },
      { name: "amount", type: "i128" },
    ],
    outputs: [{ type: "Void" }],
    docs: "Transfer token balance between accounts",
  },
];

const mockTransactionResult: TransactionResult = {
  hash: TESTNET_TX_HASH,
  status: "success",
  ledger: 5241029,
  createdAt: "2026-01-20T14:30:00Z",
  fee: "100",
  envelopeXdr: "AAAAAgAAAAD...",
  resultXdr: "AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA=",
};

const mockFeeEstimate: FeeEstimate = {
  baseFee: "100",
  recommendedFee: "150",
  feeTiers: {
    low: "100",
    medium: "150",
    high: "300",
  },
  isSurging: false,
};

const mockTransactionPage: TransactionPage = {
  transactions: [
    mockTransactionResult,
    {
      hash: "1111111122222222333333334444444455555555666666667777777788888888",
      status: "success",
      ledger: 5241028,
      createdAt: "2026-01-20T14:28:00Z",
      fee: "100",
    },
  ],
  nextCursor: "52410280001",
};

const mockDestinationValidationResult: DestinationValidationResult = {
  valid: true,
  exists: true,
  requiresMemo: false,
  balances: mockAssetBalances,
  issues: [],
};

const mockExportedTransaction: ExportedTransaction = {
  hash: TESTNET_TX_HASH,
  date: "2026-01-20T14:30:00Z",
  ledger: 5241029,
  status: "success",
  type: "payment",
  sourceAccount: TESTNET_PUBLIC_KEY,
  destination: "GBXGQJWVLWOYHFLVTKWVVTJRJL6YZKXOKROVDDUBCW2STX2TM722WDOH",
  asset: "XLM",
  amount: "100.5",
  fee: "100",
  memo: "Testnet Payment Memo",
};

// ─── API Schema Snapshot Suite ────────────────────────────────────────────────

describe("API Response Schema Snapshots", () => {
  describe("Account API Response Schemas", () => {
    it("matches AccountInfo response schema", () => {
      expect(mockAccountInfo).toMatchSnapshot();
    });

    it("matches AssetBalance[] response schema", () => {
      expect(mockAssetBalances).toMatchSnapshot();
    });

    it("matches AccountsBatch response schema", () => {
      expect(mockAccountsBatchResult).toMatchSnapshot();
    });
  });

  describe("Soroban Contract API Response Schemas", () => {
    it("matches ContractCallResult response schema", () => {
      expect(mockContractCallResult).toMatchSnapshot();
    });

    it("matches PreparedContractCall response schema", () => {
      expect(mockPreparedContractCall).toMatchSnapshot();
    });

    it("matches SimulateTransactionResult response schema", () => {
      expect(mockSimulateTransactionResult).toMatchSnapshot();
    });

    it("matches ContractMethod[] response schema", () => {
      expect(mockContractMethods).toMatchSnapshot();
    });
  });

  describe("Transaction API Response Schemas", () => {
    it("matches TransactionResult response schema", () => {
      expect(mockTransactionResult).toMatchSnapshot();
    });

    it("matches FeeEstimate response schema", () => {
      expect(mockFeeEstimate).toMatchSnapshot();
    });

    it("matches TransactionPage response schema", () => {
      expect(mockTransactionPage).toMatchSnapshot();
    });

    it("matches DestinationValidationResult response schema", () => {
      expect(mockDestinationValidationResult).toMatchSnapshot();
    });

    it("matches ExportedTransaction response schema", () => {
      expect(mockExportedTransaction).toMatchSnapshot();
    });
  });
});
