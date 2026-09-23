/**
 * Transaction scheduler — supports one-time and recurring execution.
 *
 * Schedules are persisted via a pluggable store and executed automatically
 * when their trigger time arrives. Execution is idempotent: re-running a
 * schedule that has already completed is a no-op.
 */

import { err, ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ScheduleStatus = "pending" | "executed" | "failed" | "cancelled";

export interface TransactionSchedule {
  /** Unique schedule identifier. */
  id: string;
  /** Transaction payload (opaque to the scheduler). */
  payload: unknown;
  /** When to execute: Unix epoch milliseconds. */
  executeAt: number;
  /** `null` for one-time schedules; interval in ms for recurring. */
  recurrenceMs: number | null;
  /** Current lifecycle status. */
  status: ScheduleStatus;
  /** Unix epoch ms when the schedule was created. */
  createdAt: number;
  /** Unix epoch ms of the last execution attempt. */
  lastExecutedAt?: number;
  /** Number of consecutive execution failures. */
  failureCount: number;
  /** Error message from the most recent failed execution. */
  lastError?: string;
}

export interface ScheduleStore {
  /** Return all schedules, or filter by status. */
  list(status?: ScheduleStatus): TransactionSchedule[];
  /** Retrieve a single schedule by id. */
  get(id: string): TransactionSchedule | undefined;
  /** Persist a new or updated schedule. */
  save(schedule: TransactionSchedule): void;
  /** Delete a schedule by id. */
  delete(id: string): boolean;
}

export interface SchedulerConfig {
  store: ScheduleStore;
  /** Maximum consecutive failures before a schedule is auto-cancelled. */
  maxRetries?: number;
  /** Default recurrence interval in ms when none is specified. */
  defaultRecurrenceMs?: number;
}

export interface ScheduleResult {
  scheduleId: string;
}

export type ExecuteCallback = (payload: unknown) => Promise<void>;

// ─── In-memory store ─────────────────────────────────────────────────────────

export class InMemoryScheduleStore implements ScheduleStore {
  private schedules = new Map<string, TransactionSchedule>();

  list(status?: ScheduleStatus): TransactionSchedule[] {
    const all = Array.from(this.schedules.values());
    return status ? all.filter((s) => s.status === status) : all;
  }

  get(id: string): TransactionSchedule | undefined {
    return this.schedules.get(id);
  }

  save(schedule: TransactionSchedule): void {
    this.schedules.set(schedule.id, { ...schedule });
  }

  delete(id: string): boolean {
    return this.schedules.delete(id);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let idCounter = 0;
function generateId(): string {
  return `sched_${Date.now()}_${++idCounter}`;
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Schedule a transaction for future (or immediate) execution.
 *
 * @param payload  - Arbitrary transaction data passed to the execute callback.
 * @param executeAt - Unix epoch ms when the transaction should run.
 * @param recurrenceMs - Interval for recurring schedules, or `null` for one-shot.
 * @param config   - Scheduler configuration including the persistence store.
 */
export function scheduleTransaction(
  payload: unknown,
  executeAt: number,
  recurrenceMs: number | null,
  config: SchedulerConfig,
): SorokitResult<ScheduleResult> {
  if (executeAt < Date.now() && recurrenceMs === null) {
    return err(
      "SCHEDULE_INVALID_TIME" as never,
      "executeAt must be in the future for one-time schedules",
    );
  }

  const schedule: TransactionSchedule = {
    id: generateId(),
    payload,
    executeAt,
    recurrenceMs,
    status: "pending",
    createdAt: Date.now(),
    failureCount: 0,
  };

  config.store.save(schedule);
  return ok({ scheduleId: schedule.id });
}

/**
 * Cancel a pending schedule. Already-executed or failed schedules cannot be
 * cancelled.
 */
export function cancelSchedule(
  scheduleId: string,
  config: SchedulerConfig,
): SorokitResult<void> {
  const schedule = config.store.get(scheduleId);
  if (!schedule) {
    return err("SCHEDULE_NOT_FOUND" as never, `Schedule ${scheduleId} not found`);
  }
  if (schedule.status !== "pending") {
    return err(
      "SCHEDULE_NOT_CANCELLABLE" as never,
      `Cannot cancel schedule in status: ${schedule.status}`,
    );
  }

  schedule.status = "cancelled";
  config.store.save(schedule);
  return ok(undefined);
}

/**
 * Retrieve a schedule by id.
 */
export function getSchedule(
  scheduleId: string,
  config: SchedulerConfig,
): SorokitResult<TransactionSchedule> {
  const schedule = config.store.get(scheduleId);
  if (!schedule) {
    return err("SCHEDULE_NOT_FOUND" as never, `Schedule ${scheduleId} not found`);
  }
  return ok(schedule);
}

/**
 * List all schedules, optionally filtered by status.
 */
export function listSchedules(
  config: SchedulerConfig,
  status?: ScheduleStatus,
): TransactionSchedule[] {
  return config.store.list(status);
}

/**
 * Process all due schedules. Intended to be called periodically (e.g. via a
 * timer loop or cron job). Returns the number of successfully executed
 * schedules.
 */
export async function processDueSchedules(
  config: SchedulerConfig,
  execute: ExecuteCallback,
): Promise<number> {
  const now = Date.now();
  const pending = config.store.list("pending");
  const maxRetries = config.maxRetries ?? 3;
  let executed = 0;

  for (const schedule of pending) {
    if (schedule.executeAt > now) continue;

    try {
      await execute(schedule.payload);
      executed++;

      if (schedule.recurrenceMs !== null) {
        // Reschedule for next occurrence
        schedule.executeAt = now + schedule.recurrenceMs;
        schedule.lastExecutedAt = now;
        schedule.failureCount = 0;
        delete schedule.lastError;
        config.store.save(schedule);
      } else {
        schedule.status = "executed";
        schedule.lastExecutedAt = now;
        config.store.save(schedule);
      }
    } catch (cause) {
      schedule.failureCount += 1;
      schedule.lastError = cause instanceof Error ? cause.message : String(cause);
      schedule.lastExecutedAt = now;

      if (schedule.failureCount >= maxRetries) {
        schedule.status = "failed";
      }

      config.store.save(schedule);
    }
  }

  return executed;
}
