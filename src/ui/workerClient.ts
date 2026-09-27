/**
 * Promise wrapper around the conversion worker, with recovery: a wasm codec
 * that aborts or hangs cannot be interrupted from inside the worker, so
 * cancelling (or a crash) terminates the worker and starts a fresh one. The
 * app then re-probes codecs on demand and reloads the current source.
 */
import type { CapabilityTable, ImageFormat } from '../codecs/types';
import type { ConversionPlan, Verification } from '../convert';
import type { FromWorker, SourceInfo, ToWorker } from '../protocol';
import BootWorker from '../worker-boot.ts?worker&inline';
import workerModuleUrl from '../worker.ts?worker&url';

export interface ConvertedMessage {
  bytes: ArrayBuffer;
  mime: string;
  format: ImageFormat;
  bitDepth: number;
  encoderId: string;
  colorLayout?: string;
  verification: Verification;
  diffMask?: Uint8Array;
}

export class WorkerCancelledError extends Error {
  override name = 'WorkerCancelledError';
}

export class WorkerCrashedError extends Error {
  override name = 'WorkerCrashedError';
}

type Pending = { resolve: (m: FromWorker) => void; reject: (e: Error) => void };

export class WorkerClient {
  private worker!: Worker;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  /** Bumped on every restart; a message from an old worker instance is ignored. */
  private generation = 0;
  /** Fires whenever the worker reports a new capability table. */
  onCaps: (caps: CapabilityTable) => void = () => {};
  /** Fires when the worker died on its own (not via cancel()). The app decides what to reload. */
  onCrash: (error: Error) => void = () => {};

  constructor() {
    this.spawn();
  }

  private spawn(): void {
    const gen = ++this.generation;
    // Blob-URL bootstrap so the worker inherits the page CSP (see worker-boot.ts),
    // then the real worker module is imported by absolute same-origin URL.
    const w = new BootWorker();
    w.postMessage({ type: 'boot', url: new URL(workerModuleUrl, location.href).href });
    w.onmessage = (ev: MessageEvent<FromWorker>) => {
      if (gen === this.generation) this.dispatch(ev.data);
    };
    w.onerror = (ev) => {
      if (gen !== this.generation) return;
      const err = new WorkerCrashedError(ev.message || 'The conversion worker crashed.');
      this.rejectAll(err);
      this.onCrash(err);
    };
    this.worker = w;
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Terminates the current worker (whatever it is doing) and starts a fresh one. */
  restart(reason = 'Cancelled.'): void {
    this.worker.terminate();
    this.rejectAll(new WorkerCancelledError(reason));
    this.spawn();
  }

  /** True while any request is outstanding. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  private dispatch(msg: FromWorker): void {
    if ('caps' in msg && msg.caps) this.onCaps(msg.caps);
    const key =
      msg.type === 'ready' ? 'init' : msg.type === 'caps' ? `ensure:${msg.format}:${msg.role}` : msg.id === null ? 'init' : `id:${msg.id}`;
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    if (msg.type === 'error') {
      const e = new Error(msg.message);
      e.name = msg.name;
      p.reject(e);
    } else if (msg.type === 'caps' && msg.error) {
      p.reject(new Error(msg.error));
    } else {
      p.resolve(msg);
    }
  }

  private send(msg: ToWorker, key: string, transfer: Transferable[] = []): Promise<FromWorker> {
    return new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
      this.worker.postMessage(msg, transfer);
    });
  }

  async init(): Promise<CapabilityTable> {
    const m = await this.send({ type: 'init' }, 'init');
    if (m.type !== 'ready') throw new Error('unexpected worker reply');
    return m.caps;
  }

  async ensure(format: ImageFormat, role: 'decode' | 'encode'): Promise<CapabilityTable> {
    const m = await this.send({ type: 'ensure', format, role }, `ensure:${format}:${role}`);
    if (m.type !== 'caps') throw new Error('unexpected worker reply');
    return m.caps;
  }

  async load(bytes: ArrayBuffer): Promise<{ id: number; info: SourceInfo }> {
    const id = this.nextId++;
    const m = await this.send({ type: 'load', id, bytes }, `id:${id}`, [bytes]);
    if (m.type !== 'loaded') throw new Error('unexpected worker reply');
    return { id, info: m.info };
  }

  async convert(id: number, plan: ConversionPlan): Promise<ConvertedMessage> {
    const m = await this.send({ type: 'convert', id, plan }, `id:${id}`);
    if (m.type !== 'converted') throw new Error('unexpected worker reply');
    return {
      bytes: m.bytes,
      mime: m.mime,
      format: m.format,
      bitDepth: m.bitDepth,
      encoderId: m.encoderId,
      ...(m.colorLayout && { colorLayout: m.colorLayout }),
      verification: m.verification,
      ...(m.diffMask && { diffMask: new Uint8Array(m.diffMask) }),
    };
  }

  unload(id: number): void {
    this.worker.postMessage({ type: 'unload', id } satisfies ToWorker);
  }
}
