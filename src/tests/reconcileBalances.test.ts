import { describe, it, expect } from "vitest";
import {
  reconcileBalances,
  type AccountBalance,
  type ExchangeRate,
} from "../account/reconcileBalances";

function bal(overrides: Partial<AccountBalance> = {}): AccountBalance {
  return {
    accountId: "GACCOUNT1234567890123456789012345678901234567890ABCDEF",
    assetCode: "XLM",
    assetIssuer: null,
    balance: 100,
    ...overrides,
  };
}

const rates: ExchangeRate[] = [
  { from: "XLM", to: "USD", rate: 0.1 },
  { from: "USDC", to: "USD", rate: 1.0 },
  { from: "EURC", to: "USD", rate: 1.08 },
];

describe("reconcileBalances", () => {
  it("calculates total value across multiple currencies", () => {
    const accounts: AccountBalance[] = [
      bal({ assetCode: "XLM", balance: 1000 }),
      bal({ assetCode: "USDC", balance: 500 }),
      bal({ assetCode: "EURC", balance: 200 }),
    ];

    const result = reconcileBalances(accounts, "USD", { rates });

    // 1000 * 0.1 + 500 * 1.0 + 200 * 1.08 = 100 + 500 + 216 = 816
    expect(result.totalValue).toBeCloseTo(816);
    expect(result.baseCurrency).toBe("USD");
  });

  it("reports missing exchange rates as discrepancies", () => {
    const accounts: AccountBalance[] = [
      bal({ assetCode: "UNKNOWN", balance: 100 }),
    ];

    const result = reconcileBalances(accounts, "USD", { rates });

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].type).toBe("missing_rate");
    expect(result.positions[0].convertedValue).toBeNull();
  });

  it("flags negative balances", () => {
    const accounts: AccountBalance[] = [bal({ balance: -50 })];

    const result = reconcileBalances(accounts, "USD", { rates });

    const negatives = result.discrepancies.filter(
      (d) => d.type === "negative_balance",
    );
    expect(negatives).toHaveLength(1);
  });

  it("filters dust balances", () => {
    const accounts: AccountBalance[] = [
      bal({ balance: 0.0001 }),
      bal({ balance: 100 }),
    ];

    const result = reconcileBalances(accounts, "USD", {
      rates,
      dustThreshold: 0.01,
    });

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].rawBalance).toBe(100);
    expect(result.discrepancies.some((d) => d.type === "dust_threshold")).toBe(
      true,
    );
  });

  it("handles same-currency conversion", () => {
    const accounts: AccountBalance[] = [bal({ assetCode: "USD", balance: 500 })];

    const result = reconcileBalances(accounts, "USD");

    expect(result.totalValue).toBe(500);
    expect(result.positions[0].convertedValue).toBe(500);
  });

  it("returns zero total with empty accounts", () => {
    const result = reconcileBalances([], "USD", { rates });

    expect(result.totalValue).toBe(0);
    expect(result.positions).toHaveLength(0);
    expect(result.discrepancies).toHaveLength(0);
  });

  it("calculates net positions per account", () => {
    const accounts: AccountBalance[] = [
      bal({ accountId: "GACC1", assetCode: "XLM", balance: 500 }),
      bal({ accountId: "GACC2", assetCode: "USDC", balance: 300 }),
    ];

    const result = reconcileBalances(accounts, "USD", { rates });

    expect(result.positions).toHaveLength(2);
    expect(result.positions[0].accountId).toBe("GACC1");
    expect(result.positions[0].convertedValue).toBeCloseTo(50);
    expect(result.positions[1].accountId).toBe("GACC2");
    expect(result.positions[1].convertedValue).toBeCloseTo(300);
  });
});
