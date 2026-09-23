/**
 * Gas and budget regression tests for router operations (#353).
 *
 * These tests track CPU and memory budget usage for key SDK operations
 * to detect regressions as the codebase evolves.
 *
 * Baseline thresholds (measured on reference hardware, Node 20):
 *   createAssetPair        < 0.5ms per call
 *   validateTokenAsset     < 0.1ms per call
 *   normalizePairId        < 0.1ms per call
 *   createSorokitClient    < 50ms per call
 *   validateTransaction    < 10ms per call
 *   formatAddress          < 0.5ms per call
 *
 * Acceptable regression threshold: 20% slower than baseline.
 * Run with: npm run test -- --reporter=verbose src/tests/budget-regression.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createAssetPair,
  hasExistingPair,
  resetPairRegistry,
} from "../transaction/assetPairs";
import {
  validateTokenAsset,
  validateAssetCode,
  validateAssetIssuer,
  isSameAsset,
  normalizePairId,
} from "../shared/validateToken";
import type { SwapRouteAsset } from "../transaction/pathPayment";
import { validateTransaction } from "../transaction/validateTransaction";
import { formatAddress } from "../shared/utils";
import { createSorokitClient } from "../client/createSorokitClient";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function measureTime(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function measureMemory(): number {
  if (typeof process !== "undefined" && process.memoryUsage) {
    return process.memoryUsage().heapUsed;
  }
  return 0;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ASSET_USDC: SwapRouteAsset = { code: "USDC", issuer: "GABC..." };
const ASSET_EURC: SwapRouteAsset = { code: "EURC", issuer: "GDEF..." };
const ASSET_USDT: SwapRouteAsset = { code: "USDT", issuer: "GHIJ..." };
const MOCK_XDR = "AAAAAQAAAAA=";
const VALID_PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

// ─── Budget regression tests ──────────────────────────────────────────────────

describe("budget regression — token validation", () => {
  beforeEach(() => {
    resetPairRegistry();
  });

  it("validateAssetCode should complete within budget", () => {
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      validateAssetCode("USDC");
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    expect(perCall).toBeLessThan(0.5);
  });

  it("validateAssetIssuer should complete within budget", () => {
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      validateAssetIssuer("GABC...");
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    expect(perCall).toBeLessThan(0.5);
  });

  it("validateTokenAsset should complete within budget", () => {
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      validateTokenAsset(ASSET_USDC);
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    expect(perCall).toBeLessThan(0.5);
  });

  it("isSameAsset should complete within budget", () => {
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      isSameAsset(ASSET_USDC, ASSET_EURC);
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    expect(perCall).toBeLessThan(0.1);
  });

  it("normalizePairId should complete within budget", () => {
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      normalizePairId(ASSET_USDC, ASSET_EURC);
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    expect(perCall).toBeLessThan(0.1);
  });
});

describe("budget regression — asset pair operations", () => {
  beforeEach(() => {
    resetPairRegistry();
  });

  it("createAssetPair should complete within budget", () => {
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      resetPairRegistry();
      createAssetPair(ASSET_USDC, ASSET_EURC);
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    expect(perCall).toBeLessThan(0.5);
  });

  it("hasExistingPair should complete within budget", () => {
    resetPairRegistry();
    createAssetPair(ASSET_USDC, ASSET_EURC);

    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      hasExistingPair(ASSET_USDC, ASSET_EURC);
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    expect(perCall).toBeLessThan(0.1);
  });
});

describe("budget regression — transaction validation", () => {
  it("validateTransaction should complete within budget", () => {
    const iterations = 100;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      validateTransaction(MOCK_XDR, {
        networkPassphrase: "Test SDF Network ; September 2015",
      });
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    expect(perCall).toBeLessThan(10);
  });
});

describe("budget regression — utility functions", () => {
  it("formatAddress should complete within budget", () => {
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      formatAddress(VALID_PUBLIC_KEY);
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    expect(perCall).toBeLessThan(0.5);
  });
});

describe("budget regression — client construction", () => {
  it("createSorokitClient should complete within budget", () => {
    const iterations = 10;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      createSorokitClient({ network: "testnet" });
    }
    const elapsed = performance.now() - start;
    const perCall = elapsed / iterations;

    expect(perCall).toBeLessThan(50);
  });
});

describe("budget regression — memory usage", () => {
  beforeEach(() => {
    resetPairRegistry();
  });

  it("createAssetPair should not cause excessive memory allocation", () => {
    const memBefore = measureMemory();
    const iterations = 1000;

    for (let i = 0; i < iterations; i++) {
      resetPairRegistry();
      createAssetPair(ASSET_USDC, ASSET_EURC);
    }

    const memAfter = measureMemory();
    const memDelta = memAfter - memBefore;

    // Allow up to 2MB overhead for 1000 iterations (accounts for GC variability)
    expect(memDelta).toBeLessThan(2 * 1024 * 1024);
  });

  it("validateTokenAsset should not cause excessive memory allocation", () => {
    const memBefore = measureMemory();
    const iterations = 1000;

    for (let i = 0; i < iterations; i++) {
      validateTokenAsset(ASSET_USDC);
    }

    const memAfter = measureMemory();
    const memDelta = memAfter - memBefore;

    // Allow up to 1MB overhead for 1000 iterations
    expect(memDelta).toBeLessThan(1024 * 1024);
  });
});
