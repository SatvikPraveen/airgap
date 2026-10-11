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
import { listExifTags } from './metadata/exif-list';
import type { ConvertedPayload, FromWorker, SourceInfo, ToWorker } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const registry = new CodecRegistry();
/** XMP is shown as text in the inspector; cap what travels to the UI. */
const XMP_DISPLAY_LIMIT = 16 * 1024;
const images = new Map<number, { decoded: DecodedImage; format: ImageFormat }>();
/** Newest preview request id seen per image; older queued requests are skipped. */
const latestPreview = new Map<number, number>();

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function fail(id: number | null, err: unknown, requestId?: number): void {
  const e = err instanceof Error ? err : new Error(String(err));
  post({ type: 'error', id, ...(requestId !== undefined && { requestId }), message: e.message, name: e.name });
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
      info.metadata.hasThumbnail = info.exifSummary.hasThumbnail;
      info.exifTags = listExifTags(exif);
    } catch {
      /* unreadable EXIF: facts from the header still stand */
    }
  }
  if (xmp) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(xmp);
    info.xmpBytes = xmp.length;
    if (text.length > XMP_DISPLAY_LIMIT) {
      info.xmpText = text.slice(0, XMP_DISPLAY_LIMIT);
      info.xmpTruncated = true;
    } else info.xmpText = text;
  }
  post({ type: 'loaded', id, info, caps: registry.table() });
}

type Plan = Parameters<typeof convert>[3];

/** Runs the full pipeline (encode, re-decode, compare, re-read metadata) on a loaded image. */
async function runPipeline(id: number, plan: Plan, isCurrent: () => boolean = () => true): Promise<{ payload: ConvertedPayload; transfer: Transferable[] } | null> {
  const entry = images.get(id);
  if (!entry) throw new Error('Image not loaded (or already discarded).');
  const enc = await registry.resolve(plan.target.format, 'encode');
  const ver = await registry.resolve(plan.target.format, 'decode');
  // Codec loading yields to the event loop; a newer request may have arrived meanwhile.
  if (!isCurrent()) return null;
  const dec = registry.table()[entry.format]?.decode;
  const result = await convert(
    { encoder: enc.codec, encoderCaps: enc.resolved.capabilities, decoderCaps: dec?.capabilities ?? ver.resolved.capabilities, verifier: ver.codec },
    entry.decoded,
    entry.format,
    plan,
  );
  const buffer = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer;
  const mask = result.diffMask ? (result.diffMask.buffer.slice(result.diffMask.byteOffset, result.diffMask.byteOffset + result.diffMask.byteLength) as ArrayBuffer) : undefined;
  const payload: ConvertedPayload = {
    bytes: buffer,
    mime: result.mime,
    format: result.format,
    bitDepth: result.bitDepth,
    encoderId: result.encoderId,
    ...(result.colorLayout && { colorLayout: result.colorLayout }),
    width: result.width,
    height: result.height,
    verification: result.verification,
    ...(mask && { diffMask: mask }),
  };
  return { payload, transfer: mask ? [buffer, mask] : [buffer] };
}

async function doConvert(id: number, plan: Plan): Promise<void> {
  const r = await runPipeline(id, plan);
  if (!r) return;
  post({ type: 'converted', id, caps: registry.table(), ...r.payload }, r.transfer);
}

/**
 * The preview is the real pipeline at the real settings, so its numbers are what Convert
 * will produce, not an estimate. Only the newest request per image is worth running.
 */
async function doPreview(id: number, requestId: number, plan: Plan): Promise<void> {
  const isCurrent = () => latestPreview.get(id) === requestId;
  const r = isCurrent() ? await runPipeline(id, plan, isCurrent) : null;
  if (!r) {
    post({ type: 'previewed', id, requestId, stale: true, caps: registry.table() });
    return;
  }
  post({ type: 'previewed', id, requestId, stale: false, caps: registry.table(), ...r.payload }, r.transfer);
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
    case 'preview':
      latestPreview.set(msg.id, msg.requestId);
      doPreview(msg.id, msg.requestId, msg.plan).catch((e) => fail(msg.id, e, msg.requestId));
      break;
    case 'unload':
      images.delete(msg.id);
      latestPreview.delete(msg.id);
      break;
  }
};
