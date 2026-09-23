import type { SorokitResult } from "../shared/response";
import type { AccountInfo } from "./types";
import type { AccountStreamConfig } from "./streamAccount";
import { streamAccount } from "./streamAccount";

export type AccountEventType = "balance_updated";

export interface AccountEvent {
  type: AccountEventType;
  publicKey: string;
  account: AccountInfo;
}

export interface EventSubscription {
  unsubscribe(): void;
}

export interface AccountEventTransport {
  subscribe(
    publicKey: string,
    events: AccountEventType[],
    callback: (event: AccountEvent) => void,
  ): EventSubscription;
}

export interface AccountSubscriptionOptions {
  transport?: AccountEventTransport;
  fallbackToPolling?: boolean;
  polling?: AccountStreamConfig;
  signal?: AbortSignal;
}

export function subscribeToAccountEvents(
  horizonUrl: string,
  publicKey: string,
  events: AccountEventType[],
  callback: (event: AccountEvent) => void,
  options?: AccountSubscriptionOptions,
): EventSubscription {
  if (options?.transport) {
    return options.transport.subscribe(publicKey, events, callback);
  }

  if (options?.fallbackToPolling === false) {
    return { unsubscribe: () => undefined };
  }

  const controller = new AbortController();
  options?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  let lastSnapshot = "";

  void (async () => {
    for await (const result of streamAccount(
      horizonUrl,
      publicKey,
      options?.polling,
      controller.signal,
    )) {
      if (result.status !== "ok") continue;
      const snapshot = JSON.stringify(result.data.balances);
      if (snapshot === lastSnapshot) continue;
      lastSnapshot = snapshot;
      if (events.includes("balance_updated")) {
        callback({ type: "balance_updated", publicKey, account: result.data });
      }
    }
  })();

  return { unsubscribe: () => controller.abort() };
}

export type AccountSubscriptionResult = SorokitResult<AccountEvent>;
