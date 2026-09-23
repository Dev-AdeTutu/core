import { describe, it, expect, vi } from "vitest";
import { FeeCalculator } from "../transaction/feeCalculator";
import type { FeeEstimate } from "../transaction/estimateFee";

const MOCK_ESTIMATE: FeeEstimate = {
  fee: "250",
  feeFloat: 250,
  feeXlm: "0.0000250",
  baseFee: "100",
  simulated: true,
};

const MOCK_ESTIMATE_NO_SIM: FeeEstimate = {
  fee: "100",
  feeFloat: 100,
  feeXlm: "0.0000100",
  baseFee: "100",
  simulated: false,
};

const MOCK_ESTIMATE_WITH_SURGE: FeeEstimate = {
  fee: "5000",
  feeFloat: 5000,
  feeXlm: "0.0005000",
  baseFee: "100",
  simulated: true,
  surge: true,
  tiers: {
    economy: "80",
    standard: "100",
    fast: "250",
  },
};

describe("FeeCalculator", () => {
  it("starts with null current breakdown", () => {
    const fc = new FeeCalculator();
    expect(fc.current).toBeNull();
  });

  it("computes breakdown from fee estimate", () => {
    const fc = new FeeCalculator();
    const breakdown = fc.computeFromEstimate(MOCK_ESTIMATE);
    expect(breakdown.baseFee.stroops).toBe("100");
    expect(breakdown.resourceFee.stroops).toBe("150");
    expect(breakdown.total.stroops).toBe("250");
    expect(breakdown.simulated).toBe(true);
    expect(breakdown.surge).toBe(false);
  });

  it("computes resource fee as zero for non-simulated estimates", () => {
    const fc = new FeeCalculator();
    const breakdown = fc.computeFromEstimate(MOCK_ESTIMATE_NO_SIM);
    expect(breakdown.resourceFee.stroops).toBe("0");
    expect(breakdown.simulated).toBe(false);
  });

  it("detects fee surge", () => {
    const fc = new FeeCalculator();
    const breakdown = fc.computeFromEstimate(MOCK_ESTIMATE_WITH_SURGE);
    expect(breakdown.surge).toBe(true);
  });

  it("computes fee tiers", () => {
    const fc = new FeeCalculator();
    const breakdown = fc.computeFromEstimate(MOCK_ESTIMATE_WITH_SURGE);
    expect(breakdown.tiers).not.toBeNull();
    if (breakdown.tiers) {
      expect(breakdown.tiers.economy.stroops).toBe("80");
      expect(breakdown.tiers.standard.stroops).toBe("100");
      expect(breakdown.tiers.fast.stroops).toBe("250");
    }
  });

  it("emits breakdown on compute", () => {
    const listener = vi.fn();
    const fc = new FeeCalculator({ onFeeUpdate: listener });
    fc.computeFromEstimate(MOCK_ESTIMATE);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].total.stroops).toBe("250");
  });

  it("subscribe and unsubscribe works", () => {
    const fc = new FeeCalculator();
    const listener = vi.fn();
    const unsub = fc.subscribe(listener);
    fc.computeFromEstimate(MOCK_ESTIMATE);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    fc.computeFromEstimate(MOCK_ESTIMATE);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("getComparison returns comparison items", () => {
    const fc = new FeeCalculator();
    const items = fc.getComparison(MOCK_ESTIMATE);
    expect(items.length).toBe(3);
    expect(items[0].label).toBe("Simple Payment");
    expect(items[1].label).toBe("Contract Call");
    expect(items[2].label).toBe("Fee Comparison");
  });

  it("getComparison includes surge info when applicable", () => {
    const fc = new FeeCalculator();
    const items = fc.getComparison(MOCK_ESTIMATE_WITH_SURGE);
    expect(items[2].description).toContain("congestion");
  });

  it("getSurgeAlert returns null when no breakdown set", () => {
    const fc = new FeeCalculator();
    expect(fc.getSurgeAlert()).toBeNull();
  });

  it("getSurgeAlert returns null when no surge", () => {
    const fc = new FeeCalculator();
    fc.computeFromEstimate(MOCK_ESTIMATE);
    expect(fc.getSurgeAlert()).toBeNull();
  });

  it("getSurgeAlert returns alert when surge detected", () => {
    const fc = new FeeCalculator();
    fc.computeFromEstimate(MOCK_ESTIMATE_WITH_SURGE);
    const alert = fc.getSurgeAlert();
    expect(alert).not.toBeNull();
    if (alert) {
      expect(alert.active).toBe(true);
      expect(alert.message).toContain("surge");
      expect(alert.recommendation).toContain("waiting");
    }
  });

  it("formatFeeForDisplay returns formatted strings", () => {
    const fc = new FeeCalculator();
    const breakdown = fc.computeFromEstimate(MOCK_ESTIMATE);
    const formatted = fc.formatFeeForDisplay(breakdown.total);
    expect(formatted.stroops).toContain("stroops");
    expect(formatted.xlm).toContain("XLM");
  });

  it("handleError returns fallback info", () => {
    const fc = new FeeCalculator();
    const result = fc.handleError(new Error("Network timeout"));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.message).toContain("Network timeout");
      expect(result.data.fallbackBaseFee.stroops).toBe("100");
      expect(result.data.recommendation).toContain("fallback");
    }
  });

  it("tooltip contents are informative", () => {
    const fc = new FeeCalculator();
    const breakdown = fc.computeFromEstimate(MOCK_ESTIMATE);
    expect(breakdown.baseFee.tooltip).toContain("minimum fee");
    expect(breakdown.resourceFee.tooltip).toContain("computation");
    expect(breakdown.total.tooltip).toContain("sum of the base fee");
  });

  it("XLM conversion is correct", () => {
    const fc = new FeeCalculator();
    const breakdown = fc.computeFromEstimate(MOCK_ESTIMATE);
    expect(breakdown.total.xlm).toBe("0.0000250");
  });

  it("tiers include tooltips", () => {
    const fc = new FeeCalculator();
    const breakdown = fc.computeFromEstimate(MOCK_ESTIMATE_WITH_SURGE);
    if (breakdown.tiers) {
      expect(breakdown.tiers.economy.tooltip).toContain("10th percentile");
      expect(breakdown.tiers.standard.tooltip).toContain("50th percentile");
      expect(breakdown.tiers.fast.tooltip).toContain("90th percentile");
    }
  });

  it("handles zero fee edge case", () => {
    const fc = new FeeCalculator();
    const zeroEstimate: FeeEstimate = {
      fee: "0",
      feeFloat: 0,
      feeXlm: "0.0000000",
      baseFee: "0",
      simulated: false,
    };
    const breakdown = fc.computeFromEstimate(zeroEstimate);
    expect(breakdown.total.stroops).toBe("0");
    expect(breakdown.resourceFee.stroops).toBe("0");
  });

  it("handles large fee values", () => {
    const fc = new FeeCalculator();
    const largeEstimate: FeeEstimate = {
      fee: "100000000",
      feeFloat: 100000000,
      feeXlm: "10.0000000",
      baseFee: "100",
      simulated: true,
    };
    const breakdown = fc.computeFromEstimate(largeEstimate);
    expect(breakdown.total.stroops).toBe("100000000");
    expect(breakdown.resourceFee.stroops).toBe("99999900");
  });
});
