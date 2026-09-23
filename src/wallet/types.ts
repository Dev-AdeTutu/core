/**
 * Wallet module public types.
 *
 * All wallet-related types live here.
 * No other module imports wallet types directly — they go through this file.
 */

import type { SorokitResult } from "../shared/response";

export enum WalletType {
  FREIGHTER = "FREIGHTER",
  XBULL = "XBULL",
  LOBSTR = "LOBSTR",
  HANA = "HANA",
  RABET = "RABET",
}

export interface WalletState {
  connected: boolean;
  publicKey: string | null;
  walletType: WalletType | null;
}

export type WalletCapabilityId =
  | "account.read"
  | "account.multi"
  | "account.switch"
  | "transaction.sign"
  | "transaction.sign_multisig"
  | "transaction.sign_soroban"
  | "hardware.signing"
  | "qr.signing"
  | (string & {});

export type WalletCapabilitySource = "adapter" | "fallback";

export interface WalletCapability {
  id: WalletCapabilityId;
  supported: boolean;
  source: WalletCapabilitySource;
  description?: string;
}

export interface WalletCapabilities {
  walletType: WalletType;
  capabilities: WalletCapability[];
  supports(capability: string): boolean;
}
export interface SignTransactionInput {
  /** XDR-encoded transaction to sign */
  transactionXdr: string;
  /** Network passphrase — required by all Stellar wallets */
  networkPassphrase: string;
  /** Optional: specific account to sign as (multisig scenarios) */
  accountToSign?: string;
  /** Optional: list of signer public keys expected to co-sign this transaction */
  signers?: string[];
}

/**
 * WalletAdapter — the enforced contract every wallet integration must satisfy.
 *
 * Rules:
 * - Every method returns SorokitResult<T> — no throws, no raw returns
 * - isAvailable() is the only synchronous method — it cannot fail
 * - connect() returns the public key string on success
 * - disconnect() returns undefined on success
 * - signTransaction() returns the signed XDR string on success
 *
 * Optional methods (multi-account support):
 * - getAccounts() returns all public keys the wallet exposes (undefined when unsupported)
 * - setActiveAccount() switches the active account to the given public key (undefined when unsupported)
 */
export interface WalletAdapter {
  /** Identifies which wallet this adapter handles */
  readonly walletType: WalletType;

  /** Returns false in Node or when the wallet extension is not installed */
  isAvailable(): boolean;

  /** Connect and return the user's public key */
  connect(): Promise<SorokitResult<string>>;

  /** Disconnect — state cleanup is the consumer's responsibility */
  disconnect(): Promise<SorokitResult<undefined>>;

  /** Sign a transaction XDR and return the signed XDR */
  signTransaction(input: SignTransactionInput): Promise<SorokitResult<string>>;

  /**
   * Optional: declare wallet capabilities without granting permission to skip
   * the adapter's normal runtime validation.
   */
  getCapabilities?(): WalletCapabilities;

  /**
   * Optional: return all public keys currently accessible from the wallet.
   *
   * Present when the underlying wallet / SWK version supports multi-account listing.
   * When absent, {@link listConnectedAccounts} falls back to the single active account.
   */
  getAccounts?(): Promise<SorokitResult<string[]>>;

  /**
   * Optional: switch the wallet's active account to the given public key.
   *
   * Present when the underlying wallet / SWK version supports programmatic
   * account switching. When absent, {@link switchAccount} returns WALLET_NOT_FOUND.
   */
  setActiveAccount?(accountKey: string): Promise<SorokitResult<string>>;
}

/** Outcome of a single wallet diagnostic check. */
export type DiagnosticStatus = "pass" | "fail" | "warn" | "skipped";

/** A single check performed by {@link diagnoseWalletConnection}. */
export interface DiagnosticCheck {
  /** Stable machine-readable check identifier, e.g. "wallet_installed". */
  name: string;
  /** Outcome of the check. */
  status: DiagnosticStatus;
  /** Human-readable description of what was observed. */
  finding: string;
  /** Suggested remediation when the check did not pass. */
  recommendation?: string;
}

/** Structured report returned by {@link diagnoseWalletConnection}. */
export interface WalletDiagnosticReport {
  /** Which wallet was diagnosed. */
  walletType: WalletType;
  /** True when no check failed (skipped checks do not count as failures). */
  healthy: boolean;
  /** Every check performed, in execution order. */
  checks: DiagnosticCheck[];
  /** Flat list of all findings, for quick display. */
  findings: string[];
  /** Flat list of all recommendations from non-passing checks. */
  recommendations: string[];
}

/** Options controlling {@link diagnoseWalletConnection}. */
export interface WalletDiagnosticOptions {
  /** Optional endpoint (e.g. a Horizon URL) used to verify network reachability. */
  networkUrl?: string;
  /** Override the fetch implementation — useful for tests or non-browser runtimes. */
  fetchFn?: typeof fetch;
  /**
   * When true, attempt `adapter.connect()` to verify the extension responds.
   * Connecting can surface a user prompt, so it is opt-in. Default: true.
   */
  probeConnection?: boolean;
}

/**
 * Minimal interface required from a Stellar Wallets Kit instance.
 * Typed locally — sorokit-core never imports SWK at runtime.
 * SWK is a peer dependency instantiated by the consumer.
 */
export interface SWKInstance {
  getAddress(): Promise<{ address: string }>;
  signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; address?: string },
  ): Promise<{ signedTxXdr: string }>;

  /**
   * Optional: return all accounts the wallet currently exposes.
   * Present in SWK when the connected wallet supports multi-account listing
   * (e.g. hardware wallets, wallets with account management UIs).
   * When absent, {@link listConnectedAccounts} falls back to the single active account.
   */
  getAccounts?(): Promise<{ accounts: Array<{ address: string; name?: string }> }>;
}

/**
 * Result returned by {@link listConnectedAccounts}.
 * Contains all public keys currently accessible from the wallet.
 */
export interface ConnectedAccountsResult {
  /** All public keys exposed by the wallet at the time of the call. */
  accounts: string[];
  /** The account currently active (returned by getAddress). */
  activeAccount: string;
}

/**
 * Result returned by {@link switchAccount}.
 * Reflects the new wallet state after the active account is changed.
 */
export interface AccountSwitchResult {
  /** The public key that is now the active account. */
  publicKey: string;
  /** Updated wallet connection state. */
  walletState: WalletState;
}

/** Known wallet capability flags used for recommendation filtering. */
export type WalletFeature = "multisig" | "hardware" | "ledger" | "trezor" | "qr";

/** A wallet adapter with its availability status and feature set. */
export interface DetectedWallet {
  walletType: WalletType;
  available: boolean;
  features: WalletFeature[];
}

/** Criteria for {@link recommendWallets} — omit to return all available wallets. */
export interface RecommendationCriteria {
  /** Return only wallets that support ALL of the listed features. */
  features?: WalletFeature[];
}

/**
 * Pluggable persistence adapter for wallet state.
 *
 * Implementations handle serialising and restoring `WalletState` across page
 * reloads or application restarts.  The core never touches browser storage
 * directly — it delegates to the adapter provided in the client config.
 *
 * @example
 * // localStorage adapter
 * const adapter: PersistenceAdapter = {
 *   save: (key, state) => localStorage.setItem(key, JSON.stringify(state)),
 *   load: (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
 *   clear: (key) => localStorage.removeItem(key),
 * };
 */
export interface PersistenceAdapter {
  /** Persist wallet state under the given key. */
  save(key: string, value: WalletState): void;
  /** Load previously persisted wallet state, or `null` when absent. */
  load(key: string): WalletState | null;
  /** Remove persisted wallet state under the given key. */
  clear(key: string): void;
}
