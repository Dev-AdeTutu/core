import { describe, expect, it, vi } from "vitest";
import { subscribeToAccountEvents } from "../account/subscriptions";
import { subscribeToTransactionEvents } from "../transaction/subscriptions";

describe("event subscriptions", () => {
  it("delegates account subscriptions to a custom transport", () => {
    const callback = vi.fn();
    const unsubscribe = vi.fn();
    const transport = {
      subscribe: vi.fn().mockReturnValue({ unsubscribe }),
    };

    const subscription = subscribeToAccountEvents(
      "http://horizon",
      "GACCOUNT",
      ["balance_updated"],
      callback,
      { transport },
    );
    subscription.unsubscribe();

    expect(transport.subscribe).toHaveBeenCalledWith(
      "GACCOUNT",
      ["balance_updated"],
      callback,
    );
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("delegates transaction subscriptions to a custom transport", () => {
    const callback = vi.fn();
    const transport = {
      subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    };

    subscribeToTransactionEvents(
      "http://horizon",
      "GACCOUNT",
      ["transaction_submitted", "transaction_confirmed"],
      callback,
      { transport },
    );

    expect(transport.subscribe).toHaveBeenCalledWith(
      "GACCOUNT",
      ["transaction_submitted", "transaction_confirmed"],
      callback,
    );
  });

  it("returns a no-op subscription when fallback is disabled", () => {
    expect(() =>
      subscribeToAccountEvents(
        "http://horizon",
        "GACCOUNT",
        ["balance_updated"],
        vi.fn(),
        { fallbackToPolling: false },
      ).unsubscribe(),
    ).not.toThrow();
  });
});
