/// <reference lib="webworker" />
/**
 * Conversion worker. Owns decoded images so the UI thread never touches
 * pixel buffers. Runs inside the blob-URL bootstrap (worker-boot.ts), so the
 * page CSP applies here: no fetch, no XHR, no WebSocket is possible.
 */
import { CodecRegistry } from './codecs/registry';
import type { DecodedImage, ImageFormat } from './codecs/types';
import { convert, prepareSource } from './convert';
import { sniffFormat, UnsupportedFormatError } from './inspect';
import { summarizeExif } from './metadata/exif';
import type { FromWorker, SourceInfo, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const registry = new CodecRegistry();
const images = new Map<number, { decoded: DecodedImage; format: ImageFormat }>();

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function fail(id: number | null, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  post({ type: 'error', id, message: e.message, name: e.name });
}

async function init(): Promise<void> {
  post({ type: 'ready', caps: registry.table() });
}

async function ensure(format: ImageFormat, role: 'decode' | 'encode'): Promise<void> {
  try {
    await registry.resolve(format, role);
    post({ type: 'caps', caps: registry.table(), format, role });
  } catch (err) {
    post({ type: 'caps', caps: registry.table(), format, role, error: (err as Error).message });
  }
}

async function load(id: number, buffer: ArrayBuffer): Promise<void> {
  const bytes = new Uint8Array(buffer);
  const format = sniffFormat(bytes);
  if (!format) throw new UnsupportedFormatError('Unrecognised file. Airgap reads PNG, JPEG, WebP, AVIF, JPEG XL and TIFF.');
  const { image, used } = await registry.decode(format, bytes);
  const decoded = prepareSource(image);
  images.set(id, { decoded, format });
  const { exif, icc, xmp, ...facts } = decoded.metadata;
  void icc;
  void xmp;
  const info: SourceInfo = {
    format,
    width: decoded.pixels.width,
    height: decoded.pixels.height,
    metadata: facts,
    decoder: used.resolved,
  };
  if (exif) {
    try {
      info.exifSummary = summarizeExif(exif);
      info.metadata.hasMakerNote = info.exifSummary.hasMakerNote;
      info.metadata.thumbnailHasMetadata = info.exifSummary.thumbnailHasMetadata;
    } catch {
      /* unreadable EXIF: facts from the header still stand */
    }
  }
  post({ type: 'loaded', id, info, caps: registry.table() });
}

async function doConvert(id: number, plan: Parameters<typeof convert>[3]): Promise<void> {
  const entry = images.get(id);
  if (!entry) throw new Error('Image not loaded (or already discarded).');
  const enc = await registry.resolve(plan.target.format, 'encode');
  const ver = await registry.resolve(plan.target.format, 'decode');
  const dec = registry.table()[entry.format]?.decode;
  const result = await convert(
    { encoder: enc.codec, encoderCaps: enc.resolved.capabilities, decoderCaps: dec?.capabilities ?? ver.resolved.capabilities, verifier: ver.codec },
    entry.decoded,
    entry.format,
    plan,
  );
  const buffer = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer;
  post(
    {
      type: 'converted',
      id,
      bytes: buffer,
      mime: result.mime,
      format: result.format,
      bitDepth: result.bitDepth,
      encoderId: result.encoderId,
      verification: result.verification,
      caps: registry.table(),
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
    case 'ensure':
      ensure(msg.format, msg.role).catch((e) => fail(null, e));
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
