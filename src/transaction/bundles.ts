/**
 * Transaction bundles for dependent workflows (#457).
 *
 * Groups related transactions with dependency ordering, conditional execution,
 * recovery actions, and bundle-level lifecycle tracking.
 *
 * This is a workflow orchestration layer — it does NOT imply blockchain-level
 * atomicity or rollback of already-confirmed transactions.
 */

import { SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { ok, err } from "../shared/response";

export type BundleStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "recovery";

export type BundleStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial_failure"
  | "failed"
  | "recovery";

export interface BundleStep {
  /** Unique step identifier */
  id: string;
  /** Human-readable description */
  description?: string | undefined;
  /** Transaction XDR for this step (or undefined if deferred) */
  transactionXdr?: string | undefined;
  /** Step IDs that must complete before this step runs */
  dependencies?: string[] | undefined;
  /** Predicate evaluated before execution — returning false skips this step */
  condition?: (() => boolean) | undefined;
  /** Recovery action if this step fails */
  recovery?: (() => Promise<SorokitResult<void>>) | undefined;
  /** Current status */
  status: BundleStepStatus;
  /** Error message if step failed */
  error?: string | undefined;
  /** Transaction hash if step was submitted on-chain */
  txHash?: string | undefined;
}

export interface TransactionBundle {
  /** Unique bundle identifier */
  id: string;
  /** Bundle name for display */
  name?: string | undefined;
  /** Ordered steps in this bundle */
  steps: BundleStep[];
  /** Current bundle status */
  status: BundleStatus;
  /** Timestamp of bundle creation */
  createdAt: number;
  /** Timestamp of last update */
  updatedAt: number;
}

export interface CreateBundleOptions {
  /** Optional bundle identifier (auto-generated if omitted) */
  id?: string | undefined;
  /** Bundle display name */
  name?: string | undefined;
}

/**
 * Generate a simple unique ID.
 */
function generateId(): string {
  return `bundle_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a transaction bundle from a list of steps.
 *
 * Steps can define dependencies on other steps via their `dependencies` field.
 * The bundle enforces topological ordering during execution.
 *
 * @param steps    - Step definitions to include in the bundle
 * @param options  - Optional bundle metadata
 * @returns The created bundle with initial "pending" status
 */
export function createTransactionBundle(
  steps: Omit<BundleStep, "status">[],
  options?: CreateBundleOptions,
): SorokitResult<TransactionBundle> {
  if (steps.length === 0) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Bundle must contain at least one step",
    );
  }

  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id || typeof step.id !== "string") {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        "Each step must have a string id",
      );
    }
    if (ids.has(step.id)) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Duplicate step id: ${step.id}`,
      );
    }
    ids.add(step.id);
  }

  // Validate dependencies reference existing steps
  for (const step of steps) {
    if (step.dependencies) {
      for (const dep of step.dependencies) {
        if (!ids.has(dep)) {
          return err(
            SorokitErrorCode.INVALID_CONFIG,
            `Step "${step.id}" depends on unknown step "${dep}"`,
          );
        }
      }
    }
  }

  const now = Date.now();
  const bundle: TransactionBundle = {
    id: options?.id ?? generateId(),
    name: options?.name,
    steps: steps.map((s) => ({ ...s, status: "pending" as const })),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  return ok(bundle);
}

/**
 * Get the execution order for a bundle's steps based on dependencies.
 * Returns step IDs in topological order. Throws if there's a cycle.
 */
export function resolveExecutionOrder(bundle: TransactionBundle): string[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const order: string[] = [];
  const stepMap = new Map(bundle.steps.map((s) => [s.id, s]));

  function visit(id: string) {
    if (visited.has(id)) return;
    if (inStack.has(id)) {
      throw new Error(`Circular dependency detected involving step "${id}"`);
    }
    inStack.add(id);
    const step = stepMap.get(id);
    if (step?.dependencies) {
      for (const dep of step.dependencies) {
        visit(dep);
      }
    }
    inStack.delete(id);
    visited.add(id);
    order.push(id);
  }

  for (const step of bundle.steps) {
    visit(step.id);
  }

  return order;
}

/**
 * Check if all dependencies of a step are completed.
 */
export function areDependenciesMet(
  step: BundleStep,
  bundle: TransactionBundle,
): boolean {
  if (!step.dependencies || step.dependencies.length === 0) return true;

  const stepMap = new Map(bundle.steps.map((s) => [s.id, s]));
  return step.dependencies.every((depId) => {
    const dep = stepMap.get(depId);
    return dep?.status === "completed";
  });
}

/**
 * Find the next step that can be executed.
 * A step is executable if its dependencies are met, it has a pending status,
 * and its condition (if any) returns true.
 */
export function findNextExecutableStep(
  bundle: TransactionBundle,
): BundleStep | null {
  for (const step of bundle.steps) {
    if (step.status !== "pending") continue;
    if (!areDependenciesMet(step, bundle)) continue;
    if (step.condition && !step.condition()) {
      step.status = "skipped";
      continue;
    }
    return step;
  }
  return null;
}

/**
 * Update a step's status and refresh the bundle's timestamp.
 */
export function updateStepStatus(
  bundle: TransactionBundle,
  stepId: string,
  status: BundleStepStatus,
  details?: { error?: string; txHash?: string },
): void {
  const step = bundle.steps.find((s) => s.id === stepId);
  if (!step) return;
  step.status = status;
  if (details?.error !== undefined) step.error = details.error;
  if (details?.txHash !== undefined) step.txHash = details.txHash;
  bundle.updatedAt = Date.now();
}

/**
 * Recalculate the bundle status from its steps.
 */
export function recalculateBundleStatus(
  bundle: TransactionBundle,
): BundleStatus {
  const statuses = bundle.steps.map((s) => s.status);

  if (statuses.every((s) => s === "completed" || s === "skipped"))
    return "completed";
  if (
    statuses.some((s) => s === "failed") &&
    statuses.some((s) => s === "completed")
  )
    return "partial_failure";
  if (statuses.every((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "recovery")) return "recovery";
  if (statuses.some((s) => s === "running")) return "running";
  return "pending";
}

/**
 * Attempt recovery for failed steps in a bundle.
 * Runs each failed step's recovery function if one is defined.
 */
export async function recoverBundle(
  bundle: TransactionBundle,
): Promise<SorokitResult<TransactionBundle>> {
  const failedSteps = bundle.steps.filter(
    (s) => s.status === "failed" && s.recovery,
  );

  for (const step of failedSteps) {
    updateStepStatus(bundle, step.id, "recovery");
    try {
      const result = await step.recovery!();
      if (result.status === "ok") {
        updateStepStatus(bundle, step.id, "pending");
      } else {
        updateStepStatus(bundle, step.id, "failed", {
          error: result.error.message,
        });
      }
    } catch (cause) {
      updateStepStatus(bundle, step.id, "failed", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  bundle.status = recalculateBundleStatus(bundle);
  return ok(bundle);
}
