/// <reference lib="webworker" />
/**
 * Bootstrap worker. This file is inlined into the main bundle and started
 * from a blob: URL, so it INHERITS THE PAGE'S CONTENT SECURITY POLICY. A
 * worker started from a same-origin URL would instead take its CSP from the
 * HTTP response headers, which GitHub Pages does not send, leaving worker
 * code uncovered by the meta-tag policy. (Verified in Chromium; see README.)
 *
 * It does one thing: import the real worker module (src/worker.ts) by its
 * absolute same-origin URL, which `script-src 'self'` permits, and replay any
 * messages that arrived while that import was in flight.
 */
export {};

declare const self: DedicatedWorkerGlobalScope;

const queue: unknown[] = [];

self.onmessage = async (ev: MessageEvent<{ type: string; url?: string }>) => {
  if (ev.data?.type === 'boot' && typeof ev.data.url === 'string') {
    await import(/* @vite-ignore */ ev.data.url);
    for (const data of queue) self.dispatchEvent(new MessageEvent('message', { data }));
    queue.length = 0;
  } else {
    queue.push(ev.data);
  }
};
