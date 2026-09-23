/**
 * Multi-currency balance reconciliation (#459).
 *
 * Reconciles balances across multiple accounts and currencies, including
 * base-currency conversion, net position calculation, and discrepancy
 * reporting.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AccountBalance {
  /** Account public key or identifier. */
  accountId: string;
  /** Asset code, e.g. "XLM", "USDC", "EURC". */
  assetCode: string;
  /** Issuer public key (null for native asset). */
  assetIssuer: string | null;
  /** Balance in the asset's base units. */
  balance: number;
}

export interface ExchangeRate {
  /** Source asset code. */
  from: string;
  /** Target asset code (base currency). */
  to: string;
  /** Exchange rate: 1 unit of `from` = `rate` units of `to`. */
  rate: number;
}

export interface ReconciliationResult {
  /** Total value in the base currency. */
  totalValue: number;
  /** Per-account breakdown with converted values. */
  positions: AccountPosition[];
  /** Detected discrepancies. */
  discrepancies: Discrepancy[];
  /** Base currency code. */
  baseCurrency: string;
}

export interface AccountPosition {
  accountId: string;
  assetCode: string;
  assetIssuer: string | null;
  rawBalance: number;
  /** Value in the base currency, or null if no rate available. */
  convertedValue: number | null;
}

export interface Discrepancy {
  type: "missing_rate" | "negative_balance" | "dust_threshold";
  accountId: string;
  assetCode: string;
  description: string;
}

export interface ReconcileOptions {
  /** Minimum absolute balance to include (dust threshold, default: 0). */
  dustThreshold?: number;
  /** Exchange rates for currency conversion. */
  rates?: ExchangeRate[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findRate(
  rates: ExchangeRate[],
  from: string,
  to: string,
): number | undefined {
  if (from === to) return 1;
  return rates.find((r) => r.from === from && r.to === to)?.rate;
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Reconcile balances across multiple accounts and currencies.
 *
 * @param accounts    - All account balances to reconcile.
 * @param baseCurrency - The currency to normalise values into.
 * @param options     - Optional exchange rates and dust threshold.
 */
export function reconcileBalances(
  accounts: AccountBalance[],
  baseCurrency: string,
  options: ReconcileOptions = {},
): ReconciliationResult {
  const { dustThreshold = 0, rates = [] } = options;
  const positions: AccountPosition[] = [];
  const discrepancies: Discrepancy[] = [];
  let totalValue = 0;

  for (const acct of accounts) {
    // Skip dust balances
    if (Math.abs(acct.balance) < dustThreshold) {
      if (acct.balance !== 0) {
        discrepancies.push({
          type: "dust_threshold",
          accountId: acct.accountId,
          assetCode: acct.assetCode,
          description: `Balance ${acct.balance} is below dust threshold ${dustThreshold}`,
        });
      }
      continue;
    }

    // Flag negative balances
    if (acct.balance < 0) {
      discrepancies.push({
        type: "negative_balance",
        accountId: acct.accountId,
        assetCode: acct.assetCode,
        description: `Negative balance: ${acct.balance}`,
      });
    }

    const rate = findRate(rates, acct.assetCode, baseCurrency);
    const convertedValue = rate !== undefined ? acct.balance * rate : null;

    if (rate === undefined && acct.assetCode !== baseCurrency) {
      discrepancies.push({
        type: "missing_rate",
        accountId: acct.accountId,
        assetCode: acct.assetCode,
        description: `No exchange rate from ${acct.assetCode} to ${baseCurrency}`,
      });
    }

    if (convertedValue !== null) {
      totalValue += convertedValue;
    }

    positions.push({
      accountId: acct.accountId,
      assetCode: acct.assetCode,
      assetIssuer: acct.assetIssuer,
      rawBalance: acct.balance,
      convertedValue,
    });
  }

  return {
    totalValue,
    positions,
    discrepancies,
    baseCurrency,
  };
}
