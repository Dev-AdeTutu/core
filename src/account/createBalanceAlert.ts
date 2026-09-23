import type { BalanceAlert, BalanceAlertRule } from "./types";
import type { AccountStreamConfig } from "./streamAccount";
import { streamAccount } from "./streamAccount";

/**
 * Configuration for {@link createBalanceAlert}.
 */
export interface BalanceAlertConfig {
  /**
   * Polling interval in milliseconds. Default: 5000 (5 seconds).
   * Minimum enforced: 1000 ms.
   */
  pollIntervalMs?: number;
  /**
   * Optional external `AbortSignal` to stop monitoring.
   * When provided, monitoring stops when either this signal is aborted
   * or the returned unsubscribe function is called — whichever happens first.
   */
  signal?: AbortSignal;
}

/**
 * Create a balance alert monitor for a Stellar account.
 *
 * Polls the account balance at a configurable interval and fires the `onAlert`
 * callback whenever a threshold condition is crossed. Returns an unsubscribe
 * function that stops monitoring.
 *
 * @param horizonUrl - Base URL of the Horizon server.
 * @param address    - Stellar G-address of the account to monitor.
 * @param rules      - Balance alert rules to evaluate on each poll.
 * @param onAlert    - Callback fired when a threshold condition is crossed.
 * @param config     - Optional polling and signal configuration.
 * @returns An unsubscribe function that stops the monitor.
 *
 * @example
 * const unsubscribe = createBalanceAlert(
 *   "https://horizon.stellar.org",
 *   "GABC…1234",
 *   [{ assetCode: "XLM", condition: "below", threshold: 100 }],
 *   (alert) => console.log("Low balance alert:", alert),
 *   { pollIntervalMs: 10_000 },
 * );
 *
 * // Stop monitoring later
 * unsubscribe();
 */
export function createBalanceAlert(
  horizonUrl: string,
  address: string,
  rules: BalanceAlertRule[],
  onAlert: (alert: BalanceAlert) => void,
  config?: BalanceAlertConfig,
): () => void {
  const ac = new AbortController();

  // If the caller provided an external signal, abort our controller when it does.
  const externalSignal = config?.signal;
  if (externalSignal) {
    const onExternalAbort = () => {
      ac.abort();
      externalSignal.removeEventListener("abort", onExternalAbort);
    };
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  // Build the stream config, only including intervalMs when explicitly provided
  // to satisfy exactOptionalPropertyTypes.
  const streamConfig: AccountStreamConfig = {
    alertRules: rules,
    onAlert,
    emitOnStart: true,
  };
  if (config?.pollIntervalMs !== undefined) {
    streamConfig.intervalMs = config.pollIntervalMs;
  }

  // Start the stream in the background — we don't block on it.
  (async () => {
    try {
      for await (const _result of streamAccount(
        horizonUrl,
        address,
        streamConfig,
        ac.signal,
      )) {
        // Stream is consumed automatically; alerts are dispatched via onAlert.
        // We iterate to keep the generator running.
      }
    } catch {
      // Stream was aborted or encountered an unrecoverable error.
      // No action needed — the consumer called unsubscribe() or the signal fired.
    }
  })();

  return () => {
    ac.abort();
  };
}
