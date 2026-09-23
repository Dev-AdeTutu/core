/**
 * Operation timeout enforcement (#392).
 *
 * A single mechanism shared by every client operation: an AbortController is
 * armed for the effective timeout window, the timer is always cleaned up, and
 * timeouts are reported as a typed error distinguishable from explicit
 * external cancellation.
 */

/** Thrown (internally) when an operation exceeds its execution window. */
export class OperationTimeoutError extends Error {
  readonly code = "OPERATION_TIMEOUT";
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Operation timed out after ${timeoutMs}ms. Pass a higher timeoutMs to extend the execution window.`,
    );
    this.name = "OperationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isOperationTimeoutError(cause: unknown): cause is OperationTimeoutError {
  return (
    cause instanceof OperationTimeoutError ||
    (cause instanceof Error &&
      (cause as { name?: string }).name === "OperationTimeoutError")
  );
}

/**
 * Run an operation under a timeout window.
 *
 * - `timeoutMs <= 0` disables enforcement entirely.
 * - The provided AbortSignal fires when the window elapses so underlying
 *   network requests can abort where supported.
 * - The timer is cleared as soon as the operation settles.
 * - Timeout produces {@link OperationTimeoutError}; externally-triggered
 *   aborts surface unchanged so callers can tell them apart.
 */
export async function runWithTimeout<T>(
  timeoutMs: number | null | undefined,
  operation: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const effective =
    typeof timeoutMs === "number" && !isNaN(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : undefined;

  if (effective === undefined) {
    return operation(undefined);
  }

  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effective);

  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          if (!timedOut) return; // External cancellation — let the op's own rejection flow.
          reject(new OperationTimeoutError(effective));
        });
      }),
    ]);
  } catch (cause) {
    if (timedOut && isAbortLike(cause)) {
      throw new OperationTimeoutError(effective);
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Distinguish abort-originated failures (timeout) from other errors such as
 * explicit external cancellation or plain network failures.
 */
function isAbortLike(cause: unknown): boolean {
  if (isOperationTimeoutError(cause)) return true;
  if (!(cause instanceof Error)) return false;
  const name = cause.name;
  return name === "AbortError" || name === "TimeoutError";
}
