import { describe, expect, it } from 'vitest';
import { createPreviewScheduler, type PreviewTimers } from '../../src/ui/preview';

/** Manual timers: `fire()` runs every pending callback in order. */
function fakeTimers(): PreviewTimers & { fire(): void; pending(): number } {
  let seq = 0;
  const q = new Map<number, () => void>();
  return {
    set: (fn) => {
      const id = ++seq;
      q.set(id, fn);
      return id;
    },
    clear: (h) => void q.delete(h as number),
    fire() {
      const fns = [...q.values()];
      q.clear();
      for (const f of fns) f();
    },
    pending: () => q.size,
  };
}

/** A runner whose runs resolve only when the test says so. */
function harness() {
  const timers = fakeTimers();
  const runs: { id: number; plan: string; resolve: (r: string | null) => void; reject: (e: Error) => void }[] = [];
  const results: { key: string; id: number; result: string }[] = [];
  const errors: { key: string; id: number; message: string }[] = [];
  const busyLog: boolean[] = [];
  const s = createPreviewScheduler<string, string>(
    {
      run: (id, plan) =>
        new Promise((resolve, reject) => {
          runs.push({ id, plan, resolve, reject });
        }),
      onResult: (key, id, result) => results.push({ key, id, result }),
      onError: (key, id, e) => errors.push({ key, id, message: e.message }),
      onBusy: (b) => busyLog.push(b),
    },
    { debounceMs: 250, timers },
  );
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  return { s, timers, runs, results, errors, busyLog, settle };
}

describe('preview scheduler', () => {
  it('debounces a burst of requests into one run of the last plan', async () => {
    const { s, timers, runs, results, settle } = harness();
    s.request('q=10', 'q=10');
    s.request('q=20', 'q=20');
    s.request('q=30', 'q=30');
    expect(runs).toHaveLength(0);
    expect(timers.pending()).toBe(1);
    timers.fire();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.plan).toBe('q=30');
    runs[0]!.resolve('30 bytes');
    await settle();
    expect(results).toEqual([{ key: 'q=30', id: 1, result: '30 bytes' }]);
  });

  it('runs at most one preview at a time and drops intermediate requests', async () => {
    const { s, timers, runs, results, settle } = harness();
    s.request('a', 'a');
    timers.fire();
    expect(runs).toHaveLength(1);
    s.request('b', 'b');
    timers.fire();
    s.request('c', 'c');
    timers.fire();
    expect(runs).toHaveLength(1); // b and c wait; only the newest will run
    expect(s.targetKey).toBe('c');
    runs[0]!.resolve('A');
    await settle();
    expect(results).toHaveLength(0); // 'a' was superseded: never shown
    expect(runs).toHaveLength(2);
    expect(runs[1]!.plan).toBe('c');
    runs[1]!.resolve('C');
    await settle();
    expect(results).toEqual([{ key: 'c', id: 2, result: 'C' }]);
  });

  it('a request for the key already shown or in flight is a no-op and cancels a pending debounce', async () => {
    const { s, timers, runs, results, settle } = harness();
    s.request('a', 'a');
    timers.fire();
    runs[0]!.resolve('A');
    await settle();
    expect(results).toHaveLength(1);
    s.request('b', 'b'); // pending debounce for b
    expect(timers.pending()).toBe(1);
    s.request('a', 'a'); // user slid back before the debounce fired
    expect(timers.pending()).toBe(0);
    expect(runs).toHaveLength(1);
    expect(s.targetKey).toBe('a');
  });

  it('sliding back to the in-flight key clears the waiting request so the flight is shown', async () => {
    const { s, timers, runs, results, settle } = harness();
    s.request('a', 'a');
    timers.fire();
    s.request('b', 'b');
    timers.fire();
    expect(s.targetKey).toBe('b');
    s.request('a', 'a');
    timers.fire();
    expect(s.targetKey).toBe('a');
    runs[0]!.resolve('A');
    await settle();
    expect(results).toEqual([{ key: 'a', id: 1, result: 'A' }]);
    expect(runs).toHaveLength(1);
  });

  it('reports busy from the first run until nothing is waiting', async () => {
    const { s, timers, runs, busyLog, settle } = harness();
    s.request('a', 'a');
    expect(busyLog).toEqual([]);
    timers.fire();
    expect(busyLog).toEqual([true]);
    s.request('b', 'b');
    timers.fire();
    runs[0]!.resolve('A');
    await settle();
    expect(busyLog).toEqual([true]); // still busy: b is running now
    runs[1]!.resolve('B');
    await settle();
    expect(busyLog).toEqual([true, false]);
    expect(s.busy).toBe(false);
  });

  it('errors reach onError only for the newest request', async () => {
    const { s, timers, runs, errors, results, settle } = harness();
    s.request('a', 'a');
    timers.fire();
    s.request('b', 'b');
    timers.fire();
    runs[0]!.reject(new Error('encoder exploded'));
    await settle();
    expect(errors).toHaveLength(0);
    runs[1]!.reject(new Error('still broken'));
    await settle();
    expect(errors).toEqual([{ key: 'b', id: 2, message: 'still broken' }]);
    expect(results).toHaveLength(0);
  });

  it('reset discards an in-flight result and forgets what was shown', async () => {
    const { s, timers, runs, results, busyLog, settle } = harness();
    s.request('a', 'a');
    timers.fire();
    s.reset();
    expect(s.busy).toBe(false);
    expect(busyLog).toEqual([true, false]);
    runs[0]!.resolve('A');
    await settle();
    expect(results).toHaveLength(0);
    expect(s.targetKey).toBeNull();
    s.request('a', 'a'); // same key as before the reset: must run again
    timers.fire();
    expect(runs).toHaveLength(2);
  });

  it('a null result (worker skipped as stale) shows nothing and ends busy', async () => {
    const { s, timers, runs, results, errors, settle } = harness();
    s.request('a', 'a');
    timers.fire();
    runs[0]!.resolve(null);
    await settle();
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(s.busy).toBe(false);
  });
});
