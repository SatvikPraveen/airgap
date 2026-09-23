/** Promise wrapper around the conversion worker. */
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
  verification: Verification;
}

type Pending = { resolve: (m: FromWorker) => void; reject: (e: Error) => void };

export class WorkerClient {
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  /** Fires whenever the worker reports a new capability table. */
  onCaps: (caps: CapabilityTable) => void = () => {};

  constructor() {
    // Blob-URL bootstrap so the worker inherits the page CSP (see worker-boot.ts),
    // then the real worker module is imported by absolute same-origin URL.
    this.worker = new BootWorker();
    this.worker.postMessage({ type: 'boot', url: new URL(workerModuleUrl, location.href).href });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.dispatch(ev.data);
    this.worker.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(ev.message || 'Worker crashed'));
      this.pending.clear();
    };
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
    return { bytes: m.bytes, mime: m.mime, format: m.format, bitDepth: m.bitDepth, encoderId: m.encoderId, verification: m.verification };
  }

  unload(id: number): void {
    this.worker.postMessage({ type: 'unload', id } satisfies ToWorker);
  }
}
