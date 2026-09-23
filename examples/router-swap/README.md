# Router swap example

A minimal frontend reference for integrating the `sorokit-core` router: fetch a
quote, execute the swap with a connected wallet, and follow the transaction
until it settles.

```
Connect wallet → Get quote → Sign → Submit → Confirm
```

## Files

| File                | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `src/routerSwap.ts` | All swap logic. No DOM, no framework — drop it into React, Vue, or Svelte. |
| `src/app.ts`        | Browser wiring: reads the form, renders quotes and errors.                 |
| `index.html`        | The page the example runs in.                                             |

## Running the checks

The example is type-checked against the SDK source with its own project file:

```bash
npm run typecheck:examples
```

Its behaviour is covered by `src/tests/router-example.test.ts`, which runs as
part of the normal suite (`npm run test`). Those tests exercise the real SDK
code with only Horizon faked, so the example cannot silently drift from the API
it documents.

## Running it in a browser

The example has no build step of its own — bundle it with whatever your app
already uses. With `esbuild`, for instance:

```bash
npx esbuild examples/router-swap/src/app.ts \
  --bundle --format=esm --outfile=examples/router-swap/dist/app.js
npx serve examples/router-swap
```

`index.html` loads `./dist/app.js`, so any bundler that writes there works.

## Wallet setup

`sorokit-core` never constructs a wallet kit itself — you pass an initialised
[Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit)
instance to an adapter. The example reads it from `window.stellarWalletsKit`,
so set that up before loading the app bundle:

```ts
import {
  StellarWalletsKit,
  WalletNetwork,
  FREIGHTER_ID,
  FreighterModule,
} from "@creit.tech/stellar-wallets-kit";

window.stellarWalletsKit = new StellarWalletsKit({
  network: WalletNetwork.TESTNET,
  selectedWalletId: FREIGHTER_ID,
  modules: [new FreighterModule()],
});
```

In your own application you would build the adapter wherever you manage wallet
state instead:

```ts
import { FreighterAdapter, connectWallet } from "sorokit-core";

const adapter = new FreighterAdapter(kit);
const connected = await connectWallet(adapter);
```

## Using the module

Inside this repository the example imports the SDK from source
(`../../../src/...`). In your app those imports collapse into one:

```ts
import { createRouterSwapClient } from "./routerSwap";

const created = createRouterSwapClient({ network: "testnet" });
if (created.status === "error") throw new Error(created.error.message);
const router = created.data;
```

### 1. Quote

```ts
const quote = await router.getQuote({
  sourcePublicKey: publicKey,
  destination: publicKey, // swap into your own account
  sendAsset: { code: "XLM" }, // omit `issuer` for native XLM
  receiveAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
  mode: "strict-send", // spend exactly `amount`
  amount: "100",
  slippageTolerancePercent: 0.5,
});

if (quote.status === "error") {
  // ROUTER_INVALID_PATH, ROUTER_INSUFFICIENT_LIQUIDITY, ROUTER_SLIPPAGE_EXCEEDED, …
  console.error(quote.error.code, quote.error.message);
} else {
  console.log(quote.data.route); // ["XLM", "USDC"]
  console.log(quote.data.receiveAmount); // "24.1500000"
  console.log(quote.data.slippageBound); // "24.0292500" — enforced on-chain
}
```

Quoting is read-only: it never prompts the wallet, so the user can price a swap
before committing to it.

Two things are worth copying from `getQuote`:

- **The quote and the transaction come from the same call.** `buildPathPayment`
  discovers the route on Horizon and prices it, and the example decodes the
  built XDR to display it. There is no second price source that can disagree
  with what the user signs.
- **Slippage is applied deliberately.** Path discovery sets the on-chain bound
  to the exact quoted amount, which fails as soon as the pool moves. The example
  re-builds the transaction over the discovered route with the bound widened by
  the user's tolerance, using integer stroop math so large amounts stay exact.

### 2. Swap

```ts
const result = await router.executeSwap(quote.data, adapter, publicKey, {
  onProgress: (step) => setStatus(step), // "signing" | "submitting" | "confirming"
});

if (result.status === "error") {
  console.error(result.error.code, result.error.message);
} else {
  console.log("Confirmed", result.data.hash);
}
```

`executeSwap` signs the quoted XDR, submits it, then polls Horizon until the
ledger result is readable — a transaction can be included in a ledger and still
fail, which is reported as `ROUTER_SWAP_FAILED` with the slippage bound that was
enforced. A wallet rejection keeps its own `WALLET_SIGN_REJECTED` code, since
the router never saw that swap.

## Error handling

Every function returns `SorokitResult<T>`, so there is nothing to catch — branch
on `status` and show `error.code` / `error.message`. Router failures are mapped
through `describeRouterSwapFailure`, which turns Horizon's text into stable
codes your UI can branch on:

| Code                            | Typical cause                                    |
| ------------------------------- | ------------------------------------------------ |
| `ROUTER_INVALID_PATH`           | No route between the two assets                  |
| `ROUTER_INSUFFICIENT_LIQUIDITY` | Pools cannot fill the requested size             |
| `ROUTER_SLIPPAGE_EXCEEDED`      | Price moved past the bound before settlement     |
| `ROUTER_SWAP_FAILED`            | Anything else the router rejected                |
| `WALLET_SIGN_REJECTED`          | User declined the signature                      |
| `INVALID_CONFIG`                | Bad amount or slippage tolerance from the form   |

## Notes

- Amounts are Stellar's seven-decimal fixed point (`"100.0000000"`).
- A quote consumes the source account's sequence number when it is submitted;
  request a fresh quote for each swap.
- Point `createRouterSwapClient` at `mainnet` — and a funded account — only once
  the flow behaves the way you expect on testnet.
