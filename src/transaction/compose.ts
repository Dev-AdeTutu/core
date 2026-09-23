import type { SorokitResult } from "../shared/response";
import { ok, err, SorokitErrorCode } from "../shared/response";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A named operation step in a composed pipeline. */
export interface OperationStep<T = unknown> {
  /** Unique identifier for this step within the pipeline. */
  id: string;
  /** The operation payload or descriptor. Steps are opaque to the composer. */
  operation: T;
  /** IDs of steps that must precede this one. */
  dependsOn?: string[];
  /**
   * Optional predicate evaluated at compose time.
   * When it returns false, the step is excluded from the resolved pipeline.
   * The predicate receives the full step map so it can inspect sibling steps.
   */
  condition?: (steps: ReadonlyMap<string, OperationStep<T>>) => boolean;
}

/** Resolved pipeline returned by compose(). */
export interface ComposedPipeline<T = unknown> {
  /** Operations in deterministic topological order, conditions evaluated. */
  operations: T[];
  /** Step IDs in the same order as operations. */
  stepIds: string[];
  /** Total number of steps before condition filtering. */
  totalSteps: number;
  /** Number of steps excluded by condition predicates. */
  excludedByCondition: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectCycle(
  id: string,
  steps: ReadonlyMap<string, OperationStep>,
  visited: Set<string>,
  stack: Set<string>,
): string | null {
  if (stack.has(id)) return id;
  if (visited.has(id)) return null;

  visited.add(id);
  stack.add(id);

  const step = steps.get(id);
  for (const dep of step?.dependsOn ?? []) {
    const cycle = detectCycle(dep, steps, visited, stack);
    if (cycle !== null) return cycle;
  }

  stack.delete(id);
  return null;
}

function topologicalSort(
  ids: string[],
  steps: ReadonlyMap<string, OperationStep>,
): string[] {
  const order: string[] = [];
  const visited = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const step = steps.get(id)!;
    for (const dep of step.dependsOn ?? []) {
      visit(dep);
    }
    order.push(id);
  }

  for (const id of ids) {
    visit(id);
  }

  return order;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compose a transaction operation pipeline with dependency validation.
 *
 * Validates the operation graph before XDR construction:
 * - Detects unresolved dependencies (references to unknown step IDs)
 * - Detects circular dependencies
 * - Evaluates conditional branches (steps with a `condition` predicate)
 * - Returns operations in deterministic topological order
 *
 * @param steps - Array of named operation steps with optional dependencies and conditions.
 * @returns `ok(ComposedPipeline)` on a valid graph, or `error(TX_BUILD_FAILED)` on invalid graph.
 *
 * @example
 * const result = compose([
 *   { id: "trust", operation: trustlineOp },
 *   { id: "pay",   operation: paymentOp, dependsOn: ["trust"] },
 * ]);
 * if (result.status === "ok") {
 *   // result.data.operations — [trustlineOp, paymentOp]
 * }
 */
export function compose<T>(
  steps: OperationStep<T>[],
): SorokitResult<ComposedPipeline<T>> {
  if (steps.length === 0) {
    return ok({ operations: [], stepIds: [], totalSteps: 0, excludedByCondition: 0 });
  }

  // Build lookup map and check for duplicate IDs
  const stepMap = new Map<string, OperationStep<T>>();
  for (const step of steps) {
    if (!step.id || typeof step.id !== "string") {
      return err(SorokitErrorCode.TX_BUILD_FAILED, "Each step must have a non-empty string id.");
    }
    if (stepMap.has(step.id)) {
      return err(SorokitErrorCode.TX_BUILD_FAILED, `Duplicate step id: "${step.id}".`);
    }
    stepMap.set(step.id, step);
  }

  // Validate all dependency references exist
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!stepMap.has(dep)) {
        return err(
          SorokitErrorCode.TX_BUILD_FAILED,
          `Step "${step.id}" has unresolved dependency: "${dep}".`,
        );
      }
    }
  }

  // Detect circular dependencies
  const visited = new Set<string>();
  const stack = new Set<string>();
  for (const id of stepMap.keys()) {
    const cycle = detectCycle(id, stepMap as ReadonlyMap<string, OperationStep>, visited, stack);
    if (cycle !== null) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `Circular dependency detected involving step "${cycle}".`,
      );
    }
  }

  // Evaluate conditions — steps that fail their predicate are excluded
  const readonlyMap: ReadonlyMap<string, OperationStep<T>> = stepMap;
  const activeIds: string[] = [];
  let excludedByCondition = 0;

  for (const step of steps) {
    if (step.condition && !step.condition(readonlyMap as ReadonlyMap<string, OperationStep<T>>)) {
      excludedByCondition += 1;
    } else {
      activeIds.push(step.id);
    }
  }

  // Topological sort of active steps only
  const activeMap = new Map<string, OperationStep<T>>();
  for (const id of activeIds) {
    const step = stepMap.get(id)!;
    // Filter dependsOn to only active steps
    activeMap.set(id, {
      ...step,
      dependsOn: (step.dependsOn ?? []).filter((dep) => activeMap.has(dep) || activeIds.includes(dep)),
    });
  }

  const sorted = topologicalSort(activeIds, activeMap as ReadonlyMap<string, OperationStep>);

  return ok({
    operations: sorted.map((id) => stepMap.get(id)!.operation),
    stepIds: sorted,
    totalSteps: steps.length,
    excludedByCondition,
  });
}
