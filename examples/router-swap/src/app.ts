/**
 * Router integration example — browser wiring (#357).
 *
 * Everything framework-specific lives here: reading the form, rendering the
 * quote, and reporting errors. All swap logic sits in `routerSwap.ts`, which
 * knows nothing about the DOM.
 *
 * The page expects the host app to expose an initialised Stellar Wallets Kit
 * instance as `window.stellarWalletsKit` — sorokit-core never constructs the
 * kit itself. See README.md for that snippet.
 */

import { connectWallet } from "../../../src/wallet/connect";
import { FreighterAdapter } from "../../../src/wallet/adapters/freighter";
import type { SWKInstance, WalletAdapter } from "../../../src/wallet/types";
import type { PathPaymentMode } from "../../../src/transaction/types";
import {
  createRouterSwapClient,
  formatQuote,
} from "./routerSwap";
import type { SwapQuote, SwapRequest } from "./routerSwap";

declare global {
  interface Window {
    /** Stellar Wallets Kit instance created by the host page */
    stellarWalletsKit?: SWKInstance;
  }
}

/** Elements the page drives. */
interface Elements {
  form: HTMLFormElement;
  connect: HTMLButtonElement;
  swap: HTMLButtonElement;
  account: HTMLElement;
  quote: HTMLElement;
  status: HTMLElement;
}

/** Everything the page remembers between clicks. */
interface AppState {
  publicKey: string | null;
  quote: SwapQuote | null;
  adapter: WalletAdapter | null;
}

const state: AppState = { publicKey: null, quote: null, adapter: null };

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in index.html`);
  return element as T;
}

function elements(): Elements {
  return {
    form: requireElement<HTMLFormElement>("swap-form"),
    connect: requireElement<HTMLButtonElement>("connect"),
    swap: requireElement<HTMLButtonElement>("swap"),
    account: requireElement("account"),
    quote: requireElement("quote"),
    status: requireElement("status"),
  };
}

function field(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Render an error the same way for every step of the flow. */
function showError(target: HTMLElement, code: string, message: string): void {
  target.className = "error";
  target.textContent = `${code}: ${message}`;
}

function showInfo(target: HTMLElement, message: string): void {
  target.className = "info";
  target.textContent = message;
}

export function main(): void {
  const ui = elements();

  // One client for the page. Swap "testnet" for "mainnet" when you go live.
  const created = createRouterSwapClient({ network: "testnet" });
  if (created.status === "error") {
    showError(ui.status, created.error.code, created.error.message);
    return;
  }
  const router = created.data;

  ui.connect.addEventListener("click", async () => {
    const kit = window.stellarWalletsKit;
    if (!kit) {
      showError(
        ui.status,
        "WALLET_NOT_FOUND",
        "window.stellarWalletsKit is not set — initialise Stellar Wallets Kit first (see README).",
      );
      return;
    }

    const adapter = new FreighterAdapter(kit);
    const connected = await connectWallet(adapter);
    if (connected.status === "error") {
      showError(ui.status, connected.error.code, connected.error.message);
      return;
    }

    state.adapter = adapter;
    state.publicKey = connected.data.publicKey;
    ui.account.textContent = connected.data.publicKey ?? "";
    showInfo(ui.status, "Wallet connected. Request a quote to continue.");
  });

  // Quoting is a read-only operation — no signature, no submission — so the
  // user can price a swap before the wallet ever prompts them.
  ui.form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!state.publicKey) {
      showError(ui.status, "WALLET_NOT_CONNECTED", "Connect a wallet first.");
      return;
    }

    const sendIssuer = field(ui.form, "sendIssuer");
    const receiveIssuer = field(ui.form, "receiveIssuer");
    const request: SwapRequest = {
      sourcePublicKey: state.publicKey,
      destination: field(ui.form, "destination") || state.publicKey,
      sendAsset: {
        code: field(ui.form, "sendCode"),
        ...(sendIssuer ? { issuer: sendIssuer } : {}),
      },
      receiveAsset: {
        code: field(ui.form, "receiveCode"),
        ...(receiveIssuer ? { issuer: receiveIssuer } : {}),
      },
      mode: field(ui.form, "mode") as PathPaymentMode,
      amount: field(ui.form, "amount"),
      slippageTolerancePercent: Number(field(ui.form, "slippage") || "0.5"),
    };

    ui.swap.disabled = true;
    showInfo(ui.status, "Fetching quote…");

    const quote = await router.getQuote(request);
    if (quote.status === "error") {
      state.quote = null;
      ui.quote.textContent = "";
      // Router failures carry ROUTER_* codes, so the UI can tell "no liquidity"
      // apart from "your slippage bound was too tight".
      showError(ui.status, quote.error.code, quote.error.message);
      return;
    }

    state.quote = quote.data;
    ui.quote.textContent = formatQuote(quote.data);
    ui.swap.disabled = false;
    showInfo(ui.status, "Quote ready. Review it, then swap.");
  });

  ui.swap.addEventListener("click", async () => {
    const quote = state.quote;
    const adapter = state.adapter;
    if (!quote || !adapter || !state.publicKey) {
      showError(ui.status, "INVALID_CONFIG", "Request a quote first.");
      return;
    }

    ui.swap.disabled = true;
    const result = await router.executeSwap(quote, adapter, state.publicKey, {
      onProgress: (step) => {
        const messages: Record<typeof step, string> = {
          signing: "Approve the transaction in your wallet…",
          submitting: "Submitting the swap…",
          confirming: "Waiting for confirmation…",
        };
        showInfo(ui.status, messages[step]);
      },
    });

    if (result.status === "error") {
      showError(ui.status, result.error.code, result.error.message);
      ui.swap.disabled = false;
      return;
    }

    // The quote is spent: its sequence number is consumed by the submitted
    // transaction, so the user must request a fresh one for another swap.
    state.quote = null;
    showInfo(ui.status, `Swap confirmed — transaction ${result.data.hash}`);
  });
}

// Guard so this module can also be imported by tests without touching the DOM.
if (typeof document !== "undefined") {
  main();
}
