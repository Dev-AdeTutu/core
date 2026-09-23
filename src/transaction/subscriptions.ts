import type { TransactionResult } from "./types";
import type { TransactionStreamConfig } from "./streamTransactions";
import { streamTransactions } from "./streamTransactions";

export type TransactionEventType = "transaction_submitted" | "transaction_confirmed";

export interface TransactionEvent {
  type: TransactionEventType;
  publicKey: string;
  transaction: TransactionResult;
}

export interface EventSubscription {
  unsubscribe(): void;
}

export interface TransactionEventTransport {
  subscribe(
    publicKey: string,
    events: TransactionEventType[],
    callback: (event: TransactionEvent) => void,
  ): EventSubscription;
}

export interface TransactionSubscriptionOptions {
  transport?: TransactionEventTransport;
  fallbackToPolling?: boolean;
  polling?: TransactionStreamConfig;
  signal?: AbortSignal;
}

function eventTypeForStatus(status: TransactionResult["status"]): TransactionEventType {
  return status === "pending" ? "transaction_submitted" : "transaction_confirmed";
}

export function subscribeToTransactionEvents(
  horizonUrl: string,
  publicKey: string,
  events: TransactionEventType[],
  callback: (event: TransactionEvent) => void,
  options?: TransactionSubscriptionOptions,
): EventSubscription {
  if (options?.transport) {
    return options.transport.subscribe(publicKey, events, callback);
  }

  if (options?.fallbackToPolling === false) {
    return { unsubscribe: () => undefined };
  }

  const controller = new AbortController();
  options?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const seen = new Set<string>();

  void (async () => {
    for await (const result of streamTransactions(
      horizonUrl,
      publicKey,
      options?.polling,
      controller.signal,
    )) {
      if (result.status !== "ok") continue;
      for (const transaction of result.data.transactions) {
        const key = transaction.hash ?? JSON.stringify(transaction);
        if (seen.has(key)) continue;
        seen.add(key);
        const type = eventTypeForStatus(transaction.status);
        if (events.includes(type)) {
          callback({ type, publicKey, transaction });
        }
      }
    }
  })();

  return { unsubscribe: () => controller.abort() };
}
