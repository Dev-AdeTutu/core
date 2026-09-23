/**
 * Tests for timeout configuration (#207).
 */

import { describe, it, expect } from "vitest";
import {
  getTimeout,
  isValidTimeout,
  createTimeoutSignal,
  DEFAULT_TIMEOUTS,
  type OperationType,
} from "../shared/config";

describe("timeout configuration", () => {
  describe("DEFAULT_TIMEOUTS", () => {
    it("should have defined timeouts for all operation types", () => {
      const operationTypes: OperationType[] = [
        "wallet_connect",
        "wallet_disconnect",
        "wallet_sign",
        "account_get",
        "account_get_batch",
        "account_get_balances",
        "account_stream",
        "tx_build",
        "tx_submit",
        "tx_status",
        "tx_estimate_fee",
        "tx_stream",
        "tx_validate_destination",
        "tx_query_history",
        "tx_export_history",
        "soroban_get_methods",
        "soroban_simulate",
        "soroban_prepare",
        "soroban_execute",
        "soroban_invoke",
        "soroban_read",
      ];

      for (const opType of operationTypes) {
        expect(DEFAULT_TIMEOUTS[opType]).toBeDefined();
        expect(typeof DEFAULT_TIMEOUTS[opType]).toBe("number");
      }
    });

    it("should have reasonable timeout values", () => {
      expect(DEFAULT_TIMEOUTS.wallet_connect).toBe(30000);
      expect(DEFAULT_TIMEOUTS.wallet_sign).toBe(60000);
      expect(DEFAULT_TIMEOUTS.account_get).toBe(10000);
      expect(DEFAULT_TIMEOUTS.tx_submit).toBe(30000);
      expect(DEFAULT_TIMEOUTS.soroban_simulate).toBe(60000);
    });

    it("should have zero timeout for streaming operations", () => {
      expect(DEFAULT_TIMEOUTS.account_stream).toBe(0);
      expect(DEFAULT_TIMEOUTS.tx_stream).toBe(0);
    });
  });

  describe("getTimeout", () => {
    it("should return per-call override when provided", () => {
      const timeout = getTimeout("account_get", 5000, 10000);
      expect(timeout).toBe(5000);
    });

    it("should return global override when no per-call override", () => {
      const timeout = getTimeout("account_get", undefined, 10000);
      expect(timeout).toBe(10000);
    });

    it("should return default when no overrides provided", () => {
      const timeout = getTimeout("account_get");
      expect(timeout).toBe(DEFAULT_TIMEOUTS.account_get);
    });

    it("should prioritize per-call over global override", () => {
      const timeout = getTimeout("account_get", 5000, 10000);
      expect(timeout).toBe(5000);
    });

    it("should handle undefined global override", () => {
      const timeout = getTimeout("account_get", undefined, undefined);
      expect(timeout).toBe(DEFAULT_TIMEOUTS.account_get);
    });

    it("should handle undefined per-call override", () => {
      const timeout = getTimeout("account_get", undefined, 10000);
      expect(timeout).toBe(10000);
    });
  });

  describe("isValidTimeout", () => {
    it("should accept valid positive timeout", () => {
      expect(isValidTimeout(1000)).toBe(true);
      expect(isValidTimeout(30000)).toBe(true);
      expect(isValidTimeout(600000)).toBe(true);
    });

    it("should accept zero timeout", () => {
      expect(isValidTimeout(0)).toBe(true);
    });

    it("should reject negative timeout", () => {
      expect(isValidTimeout(-1)).toBe(false);
      expect(isValidTimeout(-1000)).toBe(false);
    });

    it("should reject NaN", () => {
      expect(isValidTimeout(NaN)).toBe(false);
    });

    it("should reject timeout above maximum", () => {
      expect(isValidTimeout(600001)).toBe(false);
      expect(isValidTimeout(999999)).toBe(false);
    });

    it("should reject non-number types", () => {
      expect(isValidTimeout("1000" as unknown as number)).toBe(false);
      expect(isValidTimeout(null as unknown as number)).toBe(false);
      expect(isValidTimeout(undefined as unknown as number)).toBe(false);
    });
  });

  describe("createTimeoutSignal", () => {
    it("should return undefined for zero timeout", () => {
      const signal = createTimeoutSignal(0);
      expect(signal).toBeUndefined();
    });

    it("should return AbortSignal for positive timeout", () => {
      const signal = createTimeoutSignal(1000);
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it("should create signal with correct timeout", () => {
      const signal = createTimeoutSignal(1000);
      expect(signal).toBeDefined();
      // The signal should abort after the timeout
      // We can't easily test this without waiting, but we can verify it's a signal
    });
  });

  describe("timeout precedence", () => {
    it("should use per-call timeout over all others", () => {
      const perCall = 5000;
      const global = 10000;
      const defaultTimeout = DEFAULT_TIMEOUTS.account_get;

      const result = getTimeout("account_get", perCall, global);
      expect(result).toBe(perCall);
      expect(result).not.toBe(global);
      expect(result).not.toBe(defaultTimeout);
    });

    it("should use global timeout over default", () => {
      const global = 15000;
      const defaultTimeout = DEFAULT_TIMEOUTS.account_get;

      const result = getTimeout("account_get", undefined, global);
      expect(result).toBe(global);
      expect(result).not.toBe(defaultTimeout);
    });

    it("should use default when no overrides", () => {
      const defaultTimeout = DEFAULT_TIMEOUTS.account_get;

      const result = getTimeout("account_get");
      expect(result).toBe(defaultTimeout);
    });
  });

  describe("operation-specific defaults", () => {
    it("should have longer timeouts for wallet operations", () => {
      expect(DEFAULT_TIMEOUTS.wallet_sign).toBeGreaterThan(DEFAULT_TIMEOUTS.wallet_disconnect);
      expect(DEFAULT_TIMEOUTS.wallet_connect).toBeGreaterThan(DEFAULT_TIMEOUTS.wallet_disconnect);
    });

    it("should have longer timeouts for Soroban operations", () => {
      expect(DEFAULT_TIMEOUTS.soroban_simulate).toBeGreaterThan(DEFAULT_TIMEOUTS.account_get);
      expect(DEFAULT_TIMEOUTS.soroban_execute).toBeGreaterThan(DEFAULT_TIMEOUTS.soroban_simulate);
    });

    it("should have moderate timeouts for transaction Operations", () => {
      expect(DEFAULT_TIMEOUTS.tx_submit).toBe(30000);
      expect(DEFAULT_TIMEOUTS.tx_estimate_fee).toBe(60000);
    });
  });
});
