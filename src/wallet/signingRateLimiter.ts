import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface SigningRateLimiterConfig {
  /** Maximum signing requests per second (default: 1) */
  requestsPerSecond?: number;
  /** Maximum allowed queue size (default: 100) */
  maxQueueSize?: number;
}

export interface QueuedSigningItem<T> {
  id: string;
  execute: () => Promise<SorokitResult<T>>;
  resolve: (value: SorokitResult<T>) => void;
  reject: (reason?: any) => void;
  addedAt: number;
}

export interface QueueState {
  pendingCount: number;
  queueLength: number;
  activeRequests: number;
}

export class SigningRateLimiter {
  private _intervalMs: number;
  private _maxQueueSize: number;
  private _queue: Array<QueuedSigningItem<any>> = [];
  private _lastProcessedAt = 0;
  private _timer: any = null;
  private _activeCount = 0;
  private _nextId = 1;

  constructor(config?: SigningRateLimiterConfig) {
    const rate = config?.requestsPerSecond ?? 1;
    this._intervalMs = 1000 / Math.max(0.1, rate);
    this._maxQueueSize = config?.maxQueueSize ?? 100;
  }

  get queueLength(): number {
    return this._queue.length;
  }

  get activeCount(): number {
    return this._activeCount;
  }

  /**
   * Get current position (1-indexed) of a request in the queue. Returns -1 if not found.
   */
  getPosition(requestId: string): number {
    const idx = this._queue.findIndex((item) => item.id === requestId);
    return idx === -1 ? -1 : idx + 1;
  }

  /**
   * Get queue state snapshot.
   */
  getQueueState(): QueueState {
    return {
      pendingCount: this._queue.length,
      queueLength: this._queue.length,
      activeRequests: this._activeCount,
    };
  }

  /**
   * Cancel a queued request by ID.
   */
  cancel(
    requestId: string,
    reason = "Signing request cancelled by caller.",
  ): boolean {
    const idx = this._queue.findIndex((item) => item.id === requestId);
    if (idx !== -1) {
      const item = this._queue[idx];
      if (item) {
        this._queue.splice(idx, 1);
        item.resolve(err(SorokitErrorCode.WALLET_SIGN_REJECTED, reason));
        return true;
      }
    }
    return false;
  }

  /**
   * Enqueue a signing operation for rate-limited execution.
   */
  enqueue<T>(
    execute: () => Promise<SorokitResult<T>>,
  ): { requestId: string; promise: Promise<SorokitResult<T>> } {
    if (this._queue.length >= this._maxQueueSize) {
      return {
        requestId: "",
        promise: Promise.resolve(
          err(
            SorokitErrorCode.WALLET_SIGN_FAILED,
            "Signing rate limiter queue capacity exceeded.",
          ),
        ),
      };
    }

    const id = `sig-req-${this._nextId++}-${Date.now()}`;
    let resolvePromise!: (val: SorokitResult<T>) => void;
    let rejectPromise!: (err: any) => void;

    const promise = new Promise<SorokitResult<T>>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const item: QueuedSigningItem<T> = {
      id,
      execute,
      resolve: resolvePromise,
      reject: rejectPromise,
      addedAt: Date.now(),
    };

    this._queue.push(item);
    this._processNext();

    return { requestId: id, promise };
  }

  private _processNext(): void {
    if (this._timer || this._queue.length === 0) return;

    const now = Date.now();
    const elapsed = now - this._lastProcessedAt;
    const waitMs = Math.max(0, this._intervalMs - elapsed);

    this._timer = setTimeout(async () => {
      this._timer = null;
      if (this._queue.length === 0) return;

      const item = this._queue.shift()!;
      this._lastProcessedAt = Date.now();
      this._activeCount++;

      try {
        const result = await item.execute();
        item.resolve(result);
      } catch (cause) {
        item.reject(cause);
      } finally {
        this._activeCount--;
        this._processNext();
      }
    }, waitMs);
  }

  /**
   * Clear all pending queued items.
   */
  clear(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    for (const item of this._queue) {
      item.resolve(
        err(SorokitErrorCode.WALLET_SIGN_REJECTED, "Signing queue cleared."),
      );
    }
    this._queue = [];
  }
}
