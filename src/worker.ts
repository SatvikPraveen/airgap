/// <reference lib="webworker" />
/**
 * Conversion worker. Owns decoded images so the UI thread never touches
 * pixel buffers. Nothing in here can make a network request: there is no
 * fetch, no XHR, no importScripts, and the page CSP forbids them anyway.
 */
import { createCanvasCodec, probeWebpLossless } from './codecs/canvas';
import type { CapabilityTable, Codec, DecodedImage, ImageFormat } from './codecs/types';
import { convert } from './convert';
import { sniffFormat, UnsupportedFormatError } from './inspect';
import type { FromWorker, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let codecs: Record<ImageFormat, Codec> | null = null;
const images = new Map<number, { decoded: DecodedImage; format: ImageFormat }>();

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function fail(id: number | null, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  post({ type: 'error', id, message: e.message, name: e.name });
}

async function init(): Promise<void> {
  const probe = await probeWebpLossless();
  codecs = {
    png: createCanvasCodec('png'),
    jpeg: createCanvasCodec('jpeg'),
    webp: createCanvasCodec('webp', probe.lossless),
  };
  const caps: CapabilityTable = {
    png: codecs.png.capabilities,
    jpeg: codecs.jpeg.capabilities,
    webp: codecs.webp.capabilities,
  };
  post({ type: 'ready', caps, webpLosslessProbe: probe });
}

async function load(id: number, buffer: ArrayBuffer): Promise<void> {
  if (!codecs) throw new Error('Worker not initialised.');
  const bytes = new Uint8Array(buffer);
  const format = sniffFormat(bytes);
  if (!format) {
    throw new UnsupportedFormatError(
      'Unrecognised file. Phase 1 supports PNG, JPEG and WebP input only.',
    );
  }
  const decoded = await codecs[format].decode(bytes);
  images.set(id, { decoded, format });
  post({
    type: 'loaded',
    id,
    info: {
      format,
      width: decoded.pixels.width,
      height: decoded.pixels.height,
      metadata: decoded.metadata,
    },
  });
}

async function doConvert(id: number, plan: Parameters<typeof convert>[3]): Promise<void> {
  if (!codecs) throw new Error('Worker not initialised.');
  const entry = images.get(id);
  if (!entry) throw new Error('Image not loaded (or already discarded).');
  const result = await convert(codecs, entry.decoded, entry.format, plan);
  const buffer = result.bytes.buffer as ArrayBuffer;
  post(
    {
      type: 'converted',
      id,
      bytes: buffer,
      mime: result.mime,
      format: result.format,
      verification: result.verification,
    },
    [buffer],
  );
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      init().catch((e) => fail(null, e));
      break;
    case 'load':
      load(msg.id, msg.bytes).catch((e) => fail(msg.id, e));
      break;
    case 'convert':
      doConvert(msg.id, msg.plan).catch((e) => fail(msg.id, e));
      break;
    case 'unload':
      images.delete(msg.id);
      break;
  }
};
