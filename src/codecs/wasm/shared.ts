/** Helpers shared by the jSquash-backed codecs. */
import { extractMetadata } from '../../metadata/containers';
import { parseIcc } from '../../metadata/icc';
import { inspect } from '../../inspect';
import { alphaStats } from '../../pixels';
import type { DecodedImage, ImageFormat, ImageMetadata, PixelData } from '../types';

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function compileWasm(b64: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(base64ToBytes(b64));
}

/** Emscripten-style factory + wasm module -> initialised module (mirrors @jsquash utils). */
export function initEmscripten<T>(factory: (opts: Record<string, unknown>) => Promise<T>, wasm: WebAssembly.Module): Promise<T> {
  return factory({
    noInitialRun: true,
    instantiateWasm(imports: WebAssembly.Imports, callback: (i: WebAssembly.Instance) => void) {
      const instance = new WebAssembly.Instance(wasm, imports);
      callback(instance);
      return instance.exports;
    },
  });
}

/** Builds the DecodedImage metadata from the container header, pixel stats and extracted payloads. */
export function buildMetadata(bytes: Uint8Array, format: ImageFormat, pixels: PixelData, extra: Partial<ImageMetadata> = {}): ImageMetadata {
  const header = inspect(bytes);
  const stats = header.metadata.hasAlpha ? alphaStats(pixels) : { hasTransparency: false, hasSemiTransparency: false };
  const payloads = extractMetadata(bytes, format);
  const metadata: ImageMetadata = { ...header.metadata, ...stats, ...payloads, ...extra };
  if (payloads.icc) {
    try {
      const p = parseIcc(payloads.icc);
      metadata.iccKind = p.kind;
      metadata.iccDescription = p.description;
    } catch {
      metadata.iccKind = 'unknown';
    }
  }
  return metadata;
}

export function fromImageData(img: { data: Uint8ClampedArray | Uint8Array; width: number; height: number }): PixelData {
  const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length);
  return { width: img.width, height: img.height, bitDepth: 8, data };
}

export function asDecoded(pixels: PixelData, metadata: ImageMetadata): DecodedImage {
  return { pixels, metadata };
}

export function u8view(px: PixelData): Uint8Array {
  return new Uint8Array(px.data.buffer, px.data.byteOffset, px.data.byteLength);
}

/** Loose typing for emscripten module methods: they accept any typed array view. */
export type Bytes = Uint8Array | Uint8ClampedArray;

export function defaults(meta: { defaultOptions: unknown }): Record<string, unknown> {
  return meta.defaultOptions as Record<string, unknown>;
}
