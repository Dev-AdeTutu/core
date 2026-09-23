import type { SorokitResult } from "../shared/response";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { FeeEstimate, FeeEstimateInput, FeeEstimateOptions, FeeTiers } from "./estimateFee";

export interface FeeBreakdown {
  baseFee: FeeComponent;
  resourceFee: FeeComponent;
  total: FeeComponent;
  surge: boolean;
  simulated: boolean;
  tiers: FeeComponentTiers | null;
}

export interface FeeComponent {
  stroops: string;
  stroopsFloat: number;
  xlm: string;
  label: string;
  tooltip: string;
}

export interface FeeComponentTiers {
  economy: FeeComponent;
  standard: FeeComponent;
  fast: FeeComponent;
}

export interface FeeComparisonItem {
  label: string;
  description: string;
  fee: FeeComponent;
}

export type FeeCalculatorListener = (breakdown: FeeBreakdown) => void;
export type FeeCalculatorUnsubscribe = () => void;

export interface FeeCalculatorConfig {
  onFeeUpdate?: FeeCalculatorListener;
}

function stroopsToXlm(stroops: number): string {
  return (stroops / 10_000_000).toFixed(7);
}

function toFeeComponent(stroops: number, label: string, tooltip: string): FeeComponent {
  return {
    stroops: String(stroops),
    stroopsFloat: stroops,
    xlm: stroopsToXlm(stroops),
    label,
    tooltip,
  };
}

const BASE_FEE_TOOLTIP = "Base fee is the minimum fee required by the Stellar network. It applies to every transaction regardless of complexity.";
const RESOURCE_FEE_TOOLTIP = "Resource fee covers the cost of Soroban computation and storage. It varies based on contract complexity.";
const TOTAL_FEE_TOOLTIP = "Total fee is the sum of the base fee and any resource fee. This is the total amount deducted from your account.";

const SURGE_TOOLTIP = "A fee surge is detected when the estimated fee exceeds 2x the recent network median. This indicates network congestion.";

const SIMULATED_TOOLTIP = "This fee was estimated via Soroban RPC simulation, which provides a more accurate cost based on actual computation.";
const ESTIMATED_TOOLTIP = "This fee is an estimate based on the base fee. A simulation was not available.";

const ECONOMY_TOOLTIP = "Economy tier (10th percentile): suitable for non-urgent transactions during low network activity.";
const STANDARD_TOOLTIP = "Standard tier (50th percentile): the typical network fee for timely processing.";
const FAST_TOOLTIP = "Fast tier (90th percentile): prioritizes inclusion during network congestion.";

export class FeeCalculator {
  private _currentBreakdown: FeeBreakdown | null = null;
  private _listeners: Set<FeeCalculatorListener> = new Set();

  constructor(config?: FeeCalculatorConfig) {
    if (config?.onFeeUpdate) {
      this._listeners.add(config.onFeeUpdate);
    }
  }

  get current(): FeeBreakdown | null {
    return this._currentBreakdown;
  }

  subscribe(listener: FeeCalculatorListener): FeeCalculatorUnsubscribe {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  private _emit(): void {
    if (this._currentBreakdown) {
      for (const listener of this._listeners) {
        listener(this._currentBreakdown);
      }
    }
  }

  computeFromEstimate(estimate: FeeEstimate): FeeBreakdown {
    const totalStroops = parseInt(estimate.fee, 10);
    const baseStroops = parseInt(estimate.baseFee, 10);
    const resourceStroops = estimate.simulated ? Math.max(0, totalStroops - baseStroops) : 0;

    const breakdown: FeeBreakdown = {
      baseFee: toFeeComponent(baseStroops, "Base Fee", BASE_FEE_TOOLTIP),
      resourceFee: toFeeComponent(resourceStroops, "Resource Fee", RESOURCE_FEE_TOOLTIP),
      total: toFeeComponent(totalStroops, "Total Fee", TOTAL_FEE_TOOLTIP),
      surge: estimate.surge ?? false,
      simulated: estimate.simulated,
      tiers: estimate.tiers ? this._computeTiers(estimate.tiers) : null,
    };

    this._currentBreakdown = breakdown;
    this._emit();
    return breakdown;
  }

  private _computeTiers(tiers: FeeTiers): FeeComponentTiers {
    return {
      economy: toFeeComponent(parseInt(tiers.economy, 10), "Economy", ECONOMY_TOOLTIP),
      standard: toFeeComponent(parseInt(tiers.standard, 10), "Standard", STANDARD_TOOLTIP),
      fast: toFeeComponent(parseInt(tiers.fast, 10), "Fast", FAST_TOOLTIP),
    };
  }

  getComparison(estimate: FeeEstimate): FeeComparisonItem[] {
    const totalStroops = parseInt(estimate.fee, 10);
    const baseStroops = parseInt(estimate.baseFee, 10);

    return [
      {
        label: "Simple Payment",
        description: "Basic XLM or asset transfer between accounts",
        fee: toFeeComponent(baseStroops, "Base Fee", BASE_FEE_TOOLTIP),
      },
      {
        label: "Contract Call",
        description: "Soroban smart contract invocation",
        fee: toFeeComponent(totalStroops, "Estimated Fee", TOTAL_FEE_TOOLTIP),
      },
      {
        label: "Fee Comparison",
        description: estimate.surge
          ? "Current fee exceeds 2x the network median — possible congestion"
          : "Fee is within normal network range",
        fee: toFeeComponent(totalStroops, "Current vs Median", SURGE_TOOLTIP),
      },
    ];
  }

  getSurgeAlert(): { active: boolean; message: string; recommendation: string } | null {
    if (!this._currentBreakdown) return null;
    if (!this._currentBreakdown.surge) return null;

    return {
      active: true,
      message: "Network fee surge detected — fees are above the recent median.",
      recommendation: "Consider waiting until network activity subsides, or use the Economy tier if your transaction is not time-sensitive.",
    };
  }

  formatFeeForDisplay(component: FeeComponent): { stroops: string; xlm: string } {
    return {
      stroops: `${component.stroops} stroops`,
      xlm: `${component.xlm} XLM`,
    };
  }

  handleError(error: unknown): SorokitResult<FeeBreakdownFallback> {
    const message = error instanceof Error ? error.message : String(error);
    const fallback: FeeBreakdownFallback = {
      message: `Unable to estimate fees: ${message}`,
      fallbackBaseFee: toFeeComponent(100, "Base Fee (fallback)", BASE_FEE_TOOLTIP),
      recommendation: "Check your network connection and try again. The base fee of 100 stroops is used as a fallback.",
    };
    return ok(fallback);
  }
}

export interface FeeBreakdownFallback {
  message: string;
  fallbackBaseFee: FeeComponent;
  recommendation: string;
}
