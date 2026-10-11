/**
 * Airgap's QOI codec (src/codecs/qoi.ts) against the reference implementation
 * (qoi.h, compiled to wasm in @jsquash/qoi, a dev dependency only): round trips
 * in both directions, byte-identical encoder output, and the edge cases of the
 * format (runs longer than 62, index hits, DIFF/LUMA ranges, alpha 0).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeQoi, encodeQoi, readQoiHeader } from '../../src/codecs/qoi';
import { inspect } from '../../src/inspect';
import { probeImage } from '../../src/pixels';

type RefEnc = { encode(d: Uint8Array, w: number, h: number): Uint8Array };
type RefDec = { decode(d: Uint8Array): { data: Uint8ClampedArray; width: number; height: number } | null };
let refEnc: RefEnc;
let refDec: RefDec;

beforeAll(async () => {
  // The reference decoder returns ImageData, which Node does not have.
  (globalThis as unknown as { ImageData: unknown }).ImageData ??= class {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number,
    ) {}
  };
  const require = createRequire(import.meta.url);
  const init = async <T>(js: string, wasm: string): Promise<T> => {
    const factory = ((await import(js)) as { default: (o: object) => Promise<T> }).default;
    const bytes = readFileSync(require.resolve(wasm));
    return factory({
      noInitialRun: true,
      instantiateWasm(imports: WebAssembly.Imports, cb: (i: WebAssembly.Instance) => void) {
        const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports);
        cb(inst);
        return inst.exports;
      },
    });
  };
  refEnc = await init<RefEnc>('@jsquash/qoi/codec/enc/qoi_enc.js', '@jsquash/qoi/codec/enc/qoi_enc.wasm');
  refDec = await init<RefDec>('@jsquash/qoi/codec/dec/qoi_dec.js', '@jsquash/qoi/codec/dec/qoi_dec.wasm');
});

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24);
}

/** Images that exercise every op: noise (RGB/RGBA ops), flat runs > 62, smooth gradients (DIFF/LUMA), repeats (INDEX), alpha 0 with colour. */
function images(): { name: string; w: number; h: number; data: Uint8ClampedArray }[] {
  const out: { name: string; w: number; h: number; data: Uint8ClampedArray }[] = [];
  const probe = probeImage(24, 8, true);
  out.push({ name: 'probe image (alpha bands, RGB under alpha 0)', w: 24, h: 24, data: probe.data as Uint8ClampedArray });
  const rnd = lcg(3);
  const noise = new Uint8ClampedArray(37 * 29 * 4).map(() => rnd());
  out.push({ name: 'RGBA noise', w: 37, h: 29, data: noise });
  const flat = new Uint8ClampedArray(200 * 3 * 4);
  for (let i = 0; i < flat.length; i += 4) flat.set(i < 300 * 4 ? [10, 20, 30, 255] : [10, 20, 31, 255], i);
  out.push({ name: 'long runs', w: 200, h: 3, data: flat });
  const grad = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) grad.set([x * 4, y * 4, (x + y) * 2, 255], (y * 64 + x) * 4);
  out.push({ name: 'gradient', w: 64, h: 64, data: grad });
  const palette = new Uint8ClampedArray(50 * 50 * 4);
  const colours = [[255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 255, 0], [7, 7, 7, 255]];
  for (let i = 0; i < 2500; i++) palette.set(colours[(i * 7) % 4]!, i * 4);
  out.push({ name: 'repeating palette (INDEX hits)', w: 50, h: 50, data: palette });
  return out;
}

describe('QOI codec against the reference implementation', () => {
  for (const img of images()) {
    it(`${img.name}: own round trip, own->reference and reference->own are all exact; encoders byte-identical`, () => {
      const own = encodeQoi(img.data, img.w, img.h, { channels: 4 });
      expect(Array.from(decodeQoi(own).data)).toEqual(Array.from(img.data));
      const viaRef = refDec.decode(own)!;
      expect(Array.from(viaRef.data)).toEqual(Array.from(img.data));
      const ref = refEnc.encode(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.w, img.h);
      expect(Array.from(decodeQoi(ref).data)).toEqual(Array.from(img.data));
      expect(Buffer.from(own).equals(Buffer.from(ref)), 'byte-identical to the reference encoder').toBe(true);
    });
  }
  it('opaque input is written with 3 channels by default, and decodes identically', () => {
    const img = images()[3]!;
    const own = encodeQoi(img.data, img.w, img.h);
    expect(readQoiHeader(own).channels).toBe(3);
    expect(Array.from(decodeQoi(own).data)).toEqual(Array.from(img.data));
    expect(Array.from(refDec.decode(own)!.data)).toEqual(Array.from(img.data));
  });
  it('rejects truncated data and bad headers', () => {
    const img = images()[1]!;
    const own = encodeQoi(img.data, img.w, img.h);
    expect(() => decodeQoi(own.slice(0, own.length - 20))).toThrow(/truncated/);
    const bad = own.slice();
    bad[12] = 5;
    expect(() => decodeQoi(bad)).toThrow(/channels/);
    expect(() => decodeQoi(new Uint8Array([1, 2, 3]))).toThrow(/Not a QOI/);
  });
  it('inspect() reads the header: size, alpha, lossless, linear colourspace flagged', () => {
    const img = images()[0]!;
    const h = inspect(encodeQoi(img.data, img.w, img.h, { colorspace: 1 }));
    expect(h).toMatchObject({ format: 'qoi', width: 24, height: 24 });
    expect(h.metadata).toMatchObject({ hasAlpha: true, bitDepth: 8, sourceLossless: true, colorDescription: { primaries: 1, transfer: 8 } });
  });
});
