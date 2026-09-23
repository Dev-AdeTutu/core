import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Keypair, Account, TransactionBuilder, Operation, Networks, Asset, Memo } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import {
  createTextMemo,
  createIdMemo,
  createHashMemo,
  buildPaymentTransaction,
  buildCreateAccountTransaction,
  buildTrustlineTransaction,
  validateTransaction,
} from "../transaction";

const TESTNET_PASSPHRASE = Networks.TESTNET;

// ─── Fast-Check Arbitraries ───────────────────────────────────────────────────

const validKeypairArb = fc.constantWithCause ? fc.constant(null).map(() => Keypair.random()) : fc.nat().map(() => Keypair.random());

const validPublicKeyArb = validKeypairArb.map((kp) => kp.publicKey());

const positiveAmountArb = fc
  .tuple(
    fc.integer({ min: 1, max: 100_000_000 }),
    fc.integer({ min: 0, max: 9_999_999 }),
  )
  .map(([whole, fraction]) => `${whole}.${String(fraction).padStart(7, "0")}`);

const sequenceNumberArb = fc
  .bigInt({ min: 1n, max: 9_007_199_254_740_991n })
  .map((s) => s.toString());

const feeStroopsArb = fc
  .integer({ min: 100, max: 100_000 })
  .map((f) => f.toString());

const assetCodeArb = fc.stringMatching(/^[A-Z0-9]{1,12}$/).filter((s) => s.length >= 1);

const asciiTextMemoArb = fc.string({ minLength: 1, maxLength: 28 }).filter((s) => Buffer.byteLength(s, "utf8") <= 28);

const uint64IdMemoArb = fc.bigInt({ min: 0n, max: 18_446_744_073_709_551_615n });

const hexHash32Arb = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((buf) => Buffer.from(buf).toString("hex"));

// ─── Property-Based Test Suite ────────────────────────────────────────────────

describe("Property-Based Testing for Transaction Builders", () => {
  it("Property 1: XDR Serialization/Deserialization Roundtrip (1000 runs)", () => {
    const startTime = Date.now();

    fc.assert(
      fc.property(
        validKeypairArb,
        validPublicKeyArb,
        positiveAmountArb,
        sequenceNumberArb,
        feeStroopsArb,
        asciiTextMemoArb,
        (sourceKp, destPk, amount, seqNum, fee, memoText) => {
          const sourceAccount = new Account(
            sourceKp.publicKey(),
            seqNum,
          );

          const tx = new TransactionBuilder(sourceAccount, {
            fee,
            networkPassphrase: TESTNET_PASSPHRASE,
          })
            .addOperation(
              Operation.payment({
                destination: destPk,
                asset: Asset.native(),
                amount,
              }),
            )
            .addMemo(Memo.text(memoText))
            .setTimeout(30)
            .build();

          // 1. Serialize to XDR base64
          const xdrBase64 = tx.toXDR("base64");
          expect(typeof xdrBase64).toBe("string");
          expect(xdrBase64.length).toBeGreaterThan(0);

          // 2. Deserialize from XDR base64
          const parsed = TransactionBuilder.fromXDR(
            xdrBase64,
            TESTNET_PASSPHRASE,
          ) as Transaction;

          // 3. Verify exact structural equivalence
          expect(parsed.source).toBe(sourceKp.publicKey());
          expect(parsed.sequence).toBe((BigInt(seqNum) + 1n).toString());
          expect(parsed.fee).toBe(fee);
          expect(parsed.operations.length).toBe(1);

          const op = parsed.operations[0] as any;
          expect(op.type).toBe("payment");
          expect(op.destination).toBe(destPk);
          expect(op.amount).toBe(amount);
          expect(op.asset.isNative()).toBe(true);

          expect(parsed.memo.type).toBe("text");
          expect(parsed.memo.value?.toString()).toBe(memoText);
        },
      ),
      { numRuns: 1000 },
    );

    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(10000); // Must complete in <10 seconds
  });

  it("Property 2: Signature Generation & Cryptographic Validation (1000 runs)", () => {
    const startTime = Date.now();

    fc.assert(
      fc.property(
        validKeypairArb,
        validKeypairArb,
        validPublicKeyArb,
        positiveAmountArb,
        (sourceKp, signerKp, destPk, amount) => {
          const sourceAccount = new Account(
            sourceKp.publicKey(),
            "100",
          );

          const tx = new TransactionBuilder(sourceAccount, {
            fee: "100",
            networkPassphrase: TESTNET_PASSPHRASE,
          })
            .addOperation(
              Operation.payment({
                destination: destPk,
                asset: Asset.native(),
                amount,
              }),
            )
            .setTimeout(30)
            .build();

          // Sign transaction with random keypair
          tx.sign(signerKp);

          expect(tx.signatures.length).toBe(1);
          const sig = tx.signatures[0];
          expect(sig).toBeDefined();

          // Cryptographic verification of signature against transaction hash
          const txHash = tx.hash();
          const verified = Keypair.fromPublicKey(
            signerKp.publicKey(),
          ).verify(txHash, sig.signature());

          expect(verified).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );

    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(10000); // Must complete in <10 seconds
  });

  it("Property 3: Amount, Precision, and Asset Invariants (1000 runs)", () => {
    const startTime = Date.now();

    fc.assert(
      fc.property(
        validPublicKeyArb,
        positiveAmountArb,
        assetCodeArb,
        validPublicKeyArb,
        (destPk, amount, code, issuerPk) => {
          // Positive amount invariant
          const floatVal = parseFloat(amount);
          expect(floatVal).toBeGreaterThan(0);

          // 7-decimal precision invariant
          const decimals = amount.split(".")[1] || "";
          expect(decimals.length).toBeLessThanOrEqual(7);

          // Asset invariants
          const customAsset = new Asset(code, issuerPk);
          expect(customAsset.getCode()).toBe(code);
          expect(customAsset.getIssuer()).toBe(issuerPk);
          expect(customAsset.isNative()).toBe(false);

          const native = Asset.native();
          expect(native.isNative()).toBe(true);
          expect(native.getCode()).toBe("XLM");
        },
      ),
      { numRuns: 1000 },
    );

    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(10000);
  });

  it("Property 4: Edge Case Discovery — Memo Bytes, Uint64 & Pre-submission Validation (1000 runs)", () => {
    const startTime = Date.now();

    // Edge Case 1: Multi-byte UTF-8 string byte length vs string length
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 50 }), (str) => {
        const byteLen = Buffer.byteLength(str, "utf8");

        if (byteLen <= 28) {
          // Valid text memo within 28 bytes
          const memo = createTextMemo(str);
          expect(memo.type).toBe("text");
        } else {
          // Exceeds 28 byte cap -> MUST throw error even if string length <= 28
          expect(() => createTextMemo(str)).toThrow();
        }
      }),
      { numRuns: 1000 },
    );

    // Edge Case 2: Uint64 ID memo maximum bounds (18446744073709551615n)
    fc.assert(
      fc.property(uint64IdMemoArb, (uint64Val) => {
        const memo = createIdMemo(uint64Val);
        expect(memo.type).toBe("id");
        expect(memo.value.toString()).toBe(uint64Val.toString());

        // Negative numbers or overflow must throw
        expect(() => createIdMemo(-1n)).toThrow();
        expect(() => createIdMemo(18_446_744_073_709_551_616n)).toThrow();
      }),
      { numRuns: 1000 },
    );

    // Edge Case 3: 32-byte Hex Hash Memos
    fc.assert(
      fc.property(hexHash32Arb, (hex32) => {
        const memo = createHashMemo(hex32);
        expect(memo.type).toBe("hash");
        expect(memo.value.toString("hex")).toBe(hex32);
      }),
      { numRuns: 1000 },
    );

    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(10000);
  });
});
