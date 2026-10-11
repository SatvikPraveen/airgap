/**
 * libavif 1.4.2 + libaom 3.15.2, built by Airgap (tools/libavif: pinned Dockerfile, plain C
 * interface, single-threaded). Reads and writes stills and image sequences (animated AVIF) at
 * 8, 10 and 12 bits. Lossless: 4:4:4, identity matrix, lossless quantiser.
 */
import type { AirgapAvifModule } from '../../../vendor/libavif/airgap_avif.js';
import type { Animation, PixelData } from '../types';
import { compileWasm } from './shared';

let modPromise: Promise<AirgapAvifModule> | undefined;
export function loadLibavif(): Promise<AirgapAvifModule> {
  return (modPromise ??= Promise.all([import('../../../vendor/libavif/airgap_avif.js'), import('../../../vendor/libavif/airgap_avif.wasm?b64')]).then(async ([glue, { default: b64 }]) => {
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

export function libavifVersion(m: AirgapAvifModule): string {
  return m.UTF8ToString(m._aavif_version());
}

export interface AvifDecoded {
  /** Every frame (one for a still), at the stored depth. */
  frames: PixelData[];
  hasAlpha: boolean;
  depth: number;
  /** Per-frame durations as exact fractions of a second: num / timescale. */
  durations: number[];
  timescale: number;
  /** Total plays, APNG semantics: 0 = forever. (libavif counts repeats after the first play.) */
  loops: number;
}

export function decodeAvif(m: AirgapAvifModule, bytes: Uint8Array): AvifDecoded {
  const p = m._malloc(bytes.length);
  m.HEAPU8.set(bytes, p);
  const out = m._malloc(128);
  m.HEAPU8.fill(0, out, out + 128);
  try {
    // out: 0 w, 4 h, 8 depth, 12 bits, 16 alpha, 20 frames, 24 loops, 32 timescale (f64), 40 durations ptr, 44 size
    const r = m._aavif_decode_frames(p, bytes.length, out, out + 4, out + 8, out + 12, out + 16, out + 20, out + 24, out + 32, out + 40, out + 44);
    if (!r) throw new Error('libavif could not decode this AVIF.');
    const u = (o: number) => m.HEAPU32[(out + o) >> 2]!;
    const w = u(0);
    const h = u(4);
    const depth = u(8);
    const bits = u(12);
    const frameCount = u(20);
    const loops = m.HEAPU32[(out + 24) >> 2]! | 0;
    const timescale = m.HEAPF64[(out + 32) >> 3]!;
    const durPtr = u(40);
    const size = u(44);
    const raw = m.HEAPU8.slice(r, r + size);
    const durations = Array.from(m.HEAPF64.subarray(durPtr >> 3, (durPtr >> 3) + frameCount));
    m._aavif_free(r);
    m._aavif_free(durPtr);
    const per = size / frameCount;
    const frames: PixelData[] = [];
    for (let i = 0; i < frameCount; i++) {
      const slice = raw.slice(i * per, (i + 1) * per);
      frames.push({ width: w, height: h, bitDepth: depth, data: bits === 16 ? new Uint16Array(slice.buffer) : new Uint8ClampedArray(slice.buffer) });
    }
    // libavif: -1 infinite, -2 unknown (no edit list: play once), n >= 0 repeats after the first play.
    const plays = loops === -1 ? 0 : loops < 0 ? 1 : loops + 1;
    return { frames, hasAlpha: u(16) === 1, depth, durations, timescale, loops: plays };
  } finally {
    m._free(p);
    m._free(out);
  }
}

export interface AvifEncodeOptions {
  lossless: boolean;
  /** 0..1 */
  quality?: number;
  /** libaom speed 0 (slowest) .. 10 */
  speed?: number;
}

/**
 * Encodes one still (frames.length 1) or a sequence. Durations: exact fractions num/timescale.
 * `loops` follows APNG semantics: 0 = forever.
 */
export function encodeAvif(m: AirgapAvifModule, frames: PixelData[], hasAlpha: boolean, o: AvifEncodeOptions, timing?: { timescale: number; durations: number[]; loops: number }): Uint8Array {
  const f0 = frames[0]!;
  const depth = f0.bitDepth;
  if (![8, 10, 12].includes(depth)) throw new Error(`AVIF takes 8, 10 or 12-bit input, got ${depth}`);
  const bytesPer = f0.data.byteLength;
  const p = m._malloc(bytesPer * frames.length);
  frames.forEach((f, i) => m.HEAPU8.set(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength), p + i * bytesPer));
  const dur = m._malloc(4 * frames.length);
  const durations = timing?.durations ?? frames.map(() => 1);
  durations.forEach((d, i) => (m.HEAPU32[(dur >> 2) + i] = d));
  const out = m._malloc(8);
  try {
    const quality = Math.round(Math.min(1, Math.max(0, o.quality ?? 0.6)) * 100);
    // Plays (0 = forever) to libavif repeats (-1 = forever).
    const loops = timing ? (timing.loops === 0 ? -1 : timing.loops - 1) : -1;
    const r = m._aavif_encode_frames(p, f0.width, f0.height, depth, hasAlpha ? 1 : 0, frames.length, timing?.timescale ?? 1000, dur, loops, o.lossless ? 1 : 0, quality, o.speed ?? 6, out);
    if (!r) throw new Error('libavif encoding failed');
    const size = m.HEAPU32[out >> 2]!;
    const bytes = m.HEAPU8.slice(r, r + size);
    m._aavif_free(r);
    return bytes;
  } finally {
    m._free(p);
    m._free(dur);
    m._free(out);
  }
}

/**
 * An Animation's delays as one integer timescale: the least common multiple of the delay
 * denominators (APNG's are 16-bit), so every delay is exact; capped, and the caller is told.
 */
export function animationTiming(anim: Animation): { timescale: number; durations: number[]; exact: boolean } {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  let ts = 1;
  for (const f of anim.frames) {
    const den = f.delayDen || 100;
    ts = (ts / gcd(ts, den)) * den;
    if (ts > 1_000_000) {
      ts = 1000;
      break;
    }
  }
  const durations = anim.frames.map((f) => Math.round((f.delayNum * ts) / (f.delayDen || 100)));
  const exact = anim.frames.every((f, i) => durations[i]! * (f.delayDen || 100) === f.delayNum * ts);
  return { timescale: ts, durations, exact };
}
