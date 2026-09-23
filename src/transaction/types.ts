/**
 * Transaction module public types.
 */

export type TransactionStatus = "pending" | "success" | "failed" | "not_found";

export interface TransactionResult {
  hash: string;
  status: TransactionStatus;
  ledger?: number;
  createdAt?: string;
  fee?: string;
  /** Raw envelope XDR for debugging */
  envelopeXdr?: string;
  /** Result XDR */
  resultXdr?: string;
}

export type MemoType = "text" | "id" | "hash" | "return";

export interface MemoParams {
  /** Optional memo value. If omitted, no memo is attached. */
  memo?: string;
  /** Optional memo type. Defaults to text for string memo values. */
  memoType?: MemoType;
  /** Require a memo to be present. If true and no memo is provided, transaction build fails. */
  requireMemo?: boolean;
  /**
   * Optional custom validation callback applied before the memo is attached.
   * Receives the raw memo string and must return SorokitResult<void>.
   * A returned error result surfaces as TX_BUILD_FAILED and aborts the build.
   */
  memoValidator?: (memo: string) => import("../shared/response").SorokitResult<void>;
}

export interface PaymentParams extends MemoParams {
  destination: string;
  amount: string;
  /** Defaults to XLM (native) */
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips */
  autoFetchSequence?: boolean;
}

export interface TrustlineParams extends MemoParams {
  assetCode: string;
  assetIssuer: string;
  /** Defaults to max limit */
  limit?: string;
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips */
  autoFetchSequence?: boolean;
}

export interface AccountCreateParams extends MemoParams {
  destination: string;
  /** Starting balance in XLM — minimum 1 XLM */
  startingBalance: string;
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips */
  autoFetchSequence?: boolean;
}

export interface PaymentWithTrustlineParams {
  /** Trustline parameters to establish before payment */
  trustline: TrustlineParams;
  /** Payment parameters to execute after trustline */
  payment: PaymentParams;
}

export interface SwapTransactionParams {
  /** First payment (send asset A) */
  paymentA: PaymentParams;
  /** Second payment (receive asset B) */
  paymentB: PaymentParams;
}

export interface ReverseTransactionParams {
  /** Override fee in stroops. Defaults to BASE_FEE. */
  fee?: string;
}

export type PathPaymentMode = "strict-send" | "strict-receive";

export interface PathPaymentParams extends MemoParams {
  destination: string;
  sendAssetCode?: string;
  sendAssetIssuer?: string;
  destAssetCode?: string;
  destAssetIssuer?: string;
  /** "strict-send": exact send amount; "strict-receive": exact dest amount */
  mode: PathPaymentMode;
  /** Amount to send (strict-send) or receive (strict-receive) */
  amount: string;
  /** Slippage bound: min dest (strict-send) or max send (strict-receive). If omitted, dynamic path discovery is used to compute it. */
  slippageAmount?: string;
  /** Intermediate assets in the payment path. If omitted, dynamically discovered. */
  path?: Array<{ assetCode?: string; assetIssuer?: string }>;
  autoFetchSequence?: boolean;
}

export interface AtomicSwapParams extends MemoParams {
  /** First leg of the swap */
  legA: PathPaymentParams;
  /** Second leg of the swap */
  legB: PathPaymentParams;
}

export interface ManageOfferParams extends MemoParams {
  /**
   * Asset being sold. Omit or set to "XLM" for the native asset.
   */
  sellingAssetCode?: string;
  sellingAssetIssuer?: string;
  /**
   * Asset being bought. Omit or set to "XLM" for the native asset.
   */
  buyingAssetCode?: string;
  buyingAssetIssuer?: string;
  /**
   * Amount of the selling asset to offer. Set to "0" (with a non-zero offerId)
   * to cancel an existing offer.
   */
  amount: string;
  /**
   * Price of 1 unit of the selling asset expressed in the buying asset.
   * Accepts a decimal string ("1.5") or an exact rational ({ n: 3, d: 2 }).
   */
  price: string | { n: number; d: number };
  /**
   * Offer ID:
   *   - "0" (default) — create a new offer.
   *   - Non-zero string — update or cancel an existing offer.
   */
  offerId?: string;
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips. */
  autoFetchSequence?: boolean;
}

export interface ClawbackParams extends MemoParams {
  /**
   * Asset code to clawback. Must be a non-native issued asset (1–12 alphanumeric chars).
   */
  assetCode: string;
  /**
   * G-address of the asset issuer. The transaction source account must match this address.
   */
  assetIssuer: string;
  /**
   * G-address of the account to clawback from.
   */
  from: string;
  /**
   * Amount to clawback. Must be positive with at most 7 decimal places.
   */
  amount: string;
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips. */
  autoFetchSequence?: boolean;
}

export interface LiquidityPoolDepositParams extends MemoParams {
  /**
   * 64-character hex ID of the liquidity pool to deposit into.
   */
  liquidityPoolId: string;
  /**
   * Maximum amount of asset A to deposit. Must be positive, ≤7 decimal places.
   */
  maxAmountA: string;
  /**
   * Maximum amount of asset B to deposit. Must be positive, ≤7 decimal places.
   */
  maxAmountB: string;
  /**
   * Minimum price (A/B ratio) acceptable for the deposit.
   * Accepts a decimal string ("0.4") or a rational ({ n: 2, d: 5 }).
   * Must be positive and less than maxPrice.
   */
  minPrice: string | { n: number; d: number };
  /**
   * Maximum price (A/B ratio) acceptable for the deposit.
   * Accepts a decimal string ("0.6") or a rational ({ n: 3, d: 5 }).
   * Must be positive and greater than minPrice.
   */
  maxPrice: string | { n: number; d: number };
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips. */
  autoFetchSequence?: boolean;
}

export interface LiquidityPoolWithdrawParams extends MemoParams {
  /**
   * 64-character hex ID of the liquidity pool to withdraw from.
   */
  liquidityPoolId: string;
  /**
   * Number of pool shares to redeem. Must be positive, ≤7 decimal places.
   */
  amount: string;
  /**
   * Minimum amount of asset A to receive. Must be positive, ≤7 decimal places.
   */
  minAmountA: string;
  /**
   * Minimum amount of asset B to receive. Must be positive, ≤7 decimal places.
   */
  minAmountB: string;
  /** When true, reuses a 5-second module-level sequence cache to avoid repeated Horizon round trips. */
  autoFetchSequence?: boolean;
}

export type { FeeEstimate, FeeEstimateOptions } from "./estimateFee";
