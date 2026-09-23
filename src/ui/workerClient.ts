/** Promise wrapper around the conversion worker. */
import type { CapabilityTable } from '../codecs/types';
import type { ConversionPlan, Verification } from '../convert';
import type { FromWorker, SourceInfo, ToWorker, WebpProbeResult } from '../protocol';

export interface ConvertedMessage {
  bytes: ArrayBuffer;
  mime: string;
  format: string;
  verification: Verification;
}

export interface Ready {
  caps: CapabilityTable;
  webpLosslessProbe: WebpProbeResult;
}

export class WorkerClient {
  private worker: Worker;
  private pending = new Map<number | null, { resolve: (m: FromWorker) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.dispatch(ev.data);
    this.worker.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(ev.message || 'Worker crashed'));
      this.pending.clear();
    };
  }

  private dispatch(msg: FromWorker): void {
    const key = msg.type === 'ready' ? null : msg.id;
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    if (msg.type === 'error') {
      const e = new Error(msg.message);
      e.name = msg.name;
      p.reject(e);
    } else {
      p.resolve(msg);
    }
  }

  private send(msg: ToWorker, key: number | null, transfer: Transferable[] = []): Promise<FromWorker> {
    return new Promise((resolve, reject) => {
      this.pending.set(key, { resolve, reject });
      this.worker.postMessage(msg, transfer);
    });
  }

  async init(): Promise<Ready> {
    const m = await this.send({ type: 'init' }, null);
    if (m.type !== 'ready') throw new Error('unexpected worker reply');
    return { caps: m.caps, webpLosslessProbe: m.webpLosslessProbe };
  }

  async load(bytes: ArrayBuffer): Promise<{ id: number; info: SourceInfo }> {
    const id = this.nextId++;
    const m = await this.send({ type: 'load', id, bytes }, id, [bytes]);
    if (m.type !== 'loaded') throw new Error('unexpected worker reply');
    return { id, info: m.info };
  }

  async convert(id: number, plan: ConversionPlan): Promise<ConvertedMessage> {
    const m = await this.send({ type: 'convert', id, plan }, id);
    if (m.type !== 'converted') throw new Error('unexpected worker reply');
    return { bytes: m.bytes, mime: m.mime, format: m.format, verification: m.verification };
  }

  unload(id: number): void {
    this.worker.postMessage({ type: 'unload', id } satisfies ToWorker);
  }
}
