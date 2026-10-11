/**
 * libjxl 0.12.0, built by Airgap (tools/libjxl: pinned Dockerfile, plain C interface, no embind,
 * single-threaded). Replaces the 2022 libjxl snapshot from @jsquash/jxl, whose decoder was off by
 * one. Lossless and lossy encoding at 8 and 16 bits with exact alpha (invisible pixels kept),
 * ICC / EXIF / XMP embedding, decoding in the image's own colour space, and reversible JPEG
 * recompression (JPEG -> JPEG XL -> the identical JPEG).
 */
import type { AirgapJxlModule } from '../../../vendor/libjxl/airgap_jxl.js';
import type { PixelData } from '../types';
import { compileWasm } from './shared';

let modPromise: Promise<AirgapJxlModule> | undefined;
export function loadLibjxl(): Promise<AirgapJxlModule> {
  return (modPromise ??= Promise.all([import('../../../vendor/libjxl/airgap_jxl.js'), import('../../../vendor/libjxl/airgap_jxl.wasm?b64')]).then(async ([glue, { default: b64 }]) => {
    const wasm = await compileWasm(b64);
    return glue.default({
      instantiateWasm(imports: WebAssembly.Imports, cb: (i: WebAssembly.Instance) => void) {
        const inst = new WebAssembly.Instance(wasm, imports);
        cb(inst);
        return inst.exports;
      },
    });
  }));
}

/** Runs `fn` with `inputs` copied into wasm memory and 16 scratch words for out-parameters. */
function withMemory<T>(m: AirgapJxlModule, inputs: (Uint8Array | undefined)[], fn: (ptrs: number[], out: number) => T): T {
  const ptrs = inputs.map((b) => {
    if (!b || b.length === 0) return 0;
    const p = m._malloc(b.length);
    m.HEAPU8.set(b, p);
    return p;
  });
  const out = m._malloc(64);
  m.HEAPU8.fill(0, out, out + 64);
  try {
    return fn(ptrs, out);
  } finally {
    for (const p of ptrs) if (p) m._free(p);
    m._free(out);
  }
}

const word = (m: AirgapJxlModule, out: number, i: number) => m.HEAPU32[(out >> 2) + i]!;

function take(m: AirgapJxlModule, ptr: number, size: number): Uint8Array {
  const copy = m.HEAPU8.slice(ptr, ptr + size);
  m._ajxl_free(ptr);
  return copy;
}

export function libjxlVersion(m: AirgapJxlModule): string {
  const v = m._ajxl_version();
  return `${Math.floor(v / 1_000_000)}.${Math.floor(v / 1000) % 1000}.${v % 1000}`;
}

/** cjxl's quality-to-distance mapping (quality 0..100). */
export function qualityToDistance(q: number): number {
  return q >= 100 ? 0 : q >= 30 ? 0.1 + (100 - q) * 0.09 : 6.4 + Math.pow(2.5, (30 - q) / 5) / 6.25;
}

export interface JxlEncodeOptions {
  lossless: boolean;
  /** 0..1 */
  quality?: number;
  effort?: number;
  icc?: Uint8Array;
  exif?: Uint8Array;
  xmp?: Uint8Array;
}

export function encodeJxl(m: AirgapJxlModule, px: PixelData, hasAlpha: boolean, o: JxlEncodeOptions): Uint8Array {
  if (px.bitDepth !== 8 && px.bitDepth !== 16) throw new Error(`libjxl wrapper takes 8 or 16-bit input, got ${px.bitDepth}`);
  let samples: Uint8ClampedArray | Uint16Array = px.data;
  if (!hasAlpha) {
    // libjxl wants RGB when there is no alpha channel.
    const n = px.width * px.height;
    const rgb = px.bitDepth === 16 ? new Uint16Array(n * 3) : new Uint8ClampedArray(n * 3);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = px.data[i * 4]!;
      rgb[i * 3 + 1] = px.data[i * 4 + 1]!;
      rgb[i * 3 + 2] = px.data[i * 4 + 2]!;
    }
    samples = rgb;
  }
  const raw = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const distance = o.lossless ? 0 : Math.max(0.1, qualityToDistance(Math.round((o.quality ?? 0.9) * 100)));
  return withMemory(m, [raw, o.icc, o.exif, o.xmp], ([p, icc, exif, xmp], out) => {
    const r = m._ajxl_encode(p!, px.width, px.height, px.bitDepth, hasAlpha ? 1 : 0, o.lossless ? 1 : 0, distance, o.effort ?? 7, icc!, o.icc?.length ?? 0, exif!, o.exif?.length ?? 0, xmp!, o.xmp?.length ?? 0, out);
    if (!r) throw new Error('libjxl could not encode this image.');
    return take(m, r, word(m, out, 0));
  });
}

export interface JxlDecoded {
  pixels: PixelData;
  hasAlpha: boolean;
  /** bits_per_sample as stored in the codestream. */
  storedBits: number;
  /** Profile describing the returned samples (the image's own colour space). */
  icc?: Uint8Array;
}

export function decodeJxl(m: AirgapJxlModule, bytes: Uint8Array): JxlDecoded {
  return withMemory(m, [bytes], ([p], out) => {
    // out words: 0 w, 1 h, 2 bits, 3 alpha, 4 storedBits, 5 icc ptr, 6 icc size, 7 out size
    const r = m._ajxl_decode(p!, bytes.length, out, out + 4, out + 8, out + 12, out + 16, out + 20, out + 24, out + 28);
    if (!r) throw new Error('libjxl could not decode this JPEG XL file.');
    const [w, h, bits, alpha, stored, iccPtr, iccSize, size] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => word(m, out, i)) as number[];
    const raw = take(m, r, size!);
    const data = bits === 16 ? new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2).slice() : new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);
    const icc = iccPtr && iccSize ? take(m, iccPtr, iccSize) : undefined;
    return { pixels: { width: w!, height: h!, bitDepth: bits!, data }, hasAlpha: alpha === 1, storedBits: stored!, ...(icc && { icc }) };
  });
}

/** Lossless JPEG recompression: the result reconstructs the identical JPEG (jxlToJpeg). */
export function jpegToJxl(m: AirgapJxlModule, jpeg: Uint8Array, effort = 7): Uint8Array {
  return withMemory(m, [jpeg], ([p], out) => {
    const r = m._ajxl_jpeg_to_jxl(p!, jpeg.length, effort, out);
    if (!r) throw new Error('libjxl could not recompress this JPEG (progressive or unusual JPEGs can be refused).');
    return take(m, r, word(m, out, 0));
  });
}

/** Rebuilds the original JPEG from a recompressed JPEG XL; null when the file carries no reconstruction data. */
export function jxlToJpeg(m: AirgapJxlModule, jxl: Uint8Array): Uint8Array | null {
  return withMemory(m, [jxl], ([p], out) => {
    const r = m._ajxl_jxl_to_jpeg(p!, jxl.length, out);
    return r ? take(m, r, word(m, out, 0)) : null;
  });
}
