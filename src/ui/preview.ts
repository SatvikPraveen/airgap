/**
 * Scheduling for the live quality preview. Pure: no DOM, no worker; timers
 * and the runner are injected so the policy is unit-testable.
 *
 * Policy:
 *  - requests are debounced: a burst of slider ticks runs once, after `debounceMs`;
 *  - at most one preview is in flight. wasm encoders cannot be interrupted, so a
 *    request that arrives mid-flight does not start another; it waits, and when the
 *    flight lands only the NEWEST waiting request runs (intermediate ones are dropped);
 *  - a flight that lands while a newer request is waiting is discarded, never shown;
 *  - a request for what is already shown, in flight or waiting is a no-op (and cancels
 *    any pending debounce for something else: the user slid back).
 */

export interface PreviewRunner<P, R> {
  /** Runs one preview. Resolves to null when the worker skipped it as stale. */
  run(requestId: number, plan: P): Promise<R | null>;
  /** The newest request's result. Never called for a superseded request. */
  onResult(key: string, requestId: number, result: R): void;
  /** The newest request failed. Never called for a superseded request. */
  onError(key: string, requestId: number, error: Error): void;
  /** Fires when a run starts and when no run is in flight or waiting any more. */
  onBusy?(busy: boolean): void;
}

export interface PreviewTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface PreviewScheduler<P> {
  /** Ask for the preview described by `key` (a stable serialisation of `plan` plus the source identity). */
  request(key: string, plan: P): void;
  /** Drop everything pending and in flight (the result of an in-flight run is discarded). */
  reset(): void;
  /** The key the UI is heading for: waiting, else in flight, else shown. */
  readonly targetKey: string | null;
  /** True from the start of a run until nothing is in flight or waiting. */
  readonly busy: boolean;
}

export const PREVIEW_DEBOUNCE_MS = 250;

const realTimers: PreviewTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createPreviewScheduler<P, R>(runner: PreviewRunner<P, R>, opts: { debounceMs?: number; timers?: PreviewTimers } = {}): PreviewScheduler<P> {
  const debounceMs = opts.debounceMs ?? PREVIEW_DEBOUNCE_MS;
  const timers = opts.timers ?? realTimers;
  let nextId = 1;
  /** Key whose result is displayed, or whose run is in flight. */
  let shownKey: string | null = null;
  let inFlight: { key: string; id: number } | null = null;
  let waiting: { key: string; plan: P } | null = null;
  let timer: unknown = null;
  let busy = false;

  const setBusy = (b: boolean) => {
    if (b === busy) return;
    busy = b;
    runner.onBusy?.(b);
  };

  const targetKey = () => waiting?.key ?? inFlight?.key ?? shownKey;

  function start(key: string, plan: P): void {
    const id = nextId++;
    inFlight = { key, id };
    shownKey = key;
    setBusy(true);
    runner.run(id, plan).then(
      (result) => land(id, key, result, null),
      (err: unknown) => land(id, key, null, err instanceof Error ? err : new Error(String(err))),
    );
  }

  function land(id: number, key: string, result: R | null, error: Error | null): void {
    if (!inFlight || inFlight.id !== id) return; // reset() happened meanwhile
    inFlight = null;
    if (waiting) {
      // Superseded: the user has moved on. Do not show this; run what they want now.
      const w = waiting;
      waiting = null;
      start(w.key, w.plan);
      return;
    }
    if (error) runner.onError(key, id, error);
    else if (result !== null) runner.onResult(key, id, result);
    // result === null without error: the worker skipped it as stale. With one flight at a
    // time that only happens after reset(); there is nothing newer to show here.
    setBusy(false);
  }

  function accept(key: string, plan: P): void {
    if (inFlight) waiting = key === inFlight.key ? null : { key, plan };
    else if (key !== shownKey) start(key, plan);
  }

  return {
    request(key, plan) {
      if (timer !== null) timers.clear(timer);
      timer = null;
      if (targetKey() === key) return;
      timer = timers.set(() => {
        timer = null;
        accept(key, plan);
      }, debounceMs);
    },
    reset() {
      if (timer !== null) timers.clear(timer);
      timer = null;
      shownKey = null;
      inFlight = null;
      waiting = null;
      setBusy(false);
    },
    get targetKey() {
      return targetKey();
    },
    get busy() {
      return busy;
    },
  };
}
