/**
 * Animated WebP (src/codecs/webp-anim.ts) against libwebp's own animation decoder
 * (WebPAnimDecoder, anim_decode.c, via wasm-webp: a dev dependency only). Frames are
 * encoded for the writer tests with the same @jsquash/webp encoder the app uses.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Animation, PixelData } from '../../src/codecs/types';
import { blendNonPremult, decodeAnimatedWebp, delaysFitMs, delayToMs, encodeAnimatedWebp, parseAnimatedWebp } from '../../src/codecs/webp-anim';
import { probeImage } from '../../src/pixels';
import { fixture } from './helpers';

type Ref = {
  decodeAnimation(d: Uint8Array, alpha: boolean): { width: number; height: number; data: Uint8Array; duration: number }[];
  decodeRGBA(d: Uint8Array): { width: number; height: number; data: Uint8Array };
};
let ref: Ref;
let encodeLossless: (px: PixelData) => Promise<Uint8Array>;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const factory = (await import('wasm-webp/dist/esm/webp-wasm.js' as string)).default as (o: object) => Promise<Ref>;
  ref = await factory({ wasmBinary: readFileSync(require.resolve('wasm-webp/dist/esm/webp-wasm.wasm')) });
  const meta = await import('@jsquash/webp/meta.js');
  const encFactory = (await import('@jsquash/webp/codec/enc/webp_enc.js')).default as unknown as (o: object) => Promise<{ encode(d: Uint8ClampedArray, w: number, h: number, o: object): Uint8Array }>;
  const wasm = readFileSync(require.resolve('@jsquash/webp/codec/enc/webp_enc.wasm'));
  const enc = await encFactory({
    noInitialRun: true,
    instantiateWasm(imports: WebAssembly.Imports, cb: (i: WebAssembly.Instance) => void) {
      const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports);
      cb(inst);
      return inst.exports;
    },
  });
  encodeLossless = async (px) => new Uint8Array(enc.encode(px.data as Uint8ClampedArray, px.width, px.height, { ...meta.defaultOptions, lossless: 1, exact: 1, quality: 100 }));
});

/** libwebp's still decoder for the frames (the compositing is what is under test). */
const still = async (webp: Uint8Array): Promise<PixelData> => {
  const r = ref.decodeRGBA(webp);
  return { width: r.width, height: r.height, bitDepth: 8, data: new Uint8ClampedArray(r.data) };
};

describe('animated WebP decoding against libwebp WebPAnimDecoder', () => {
  for (const name of ['webp-ops.webp', 'webp-libwebp.webp']) {
    it(`${name}: every composited frame matches libwebp sample for sample`, async () => {
      const bytes = fixture(name);
      const ours = (await decodeAnimatedWebp(bytes, still))!;
      const theirs = ref.decodeAnimation(bytes, true);
      expect(ours.frames).toHaveLength(theirs.length);
      ours.frames.forEach((f, i) => {
        expect(Array.from(f.pixels.data), `frame ${i}`).toEqual(Array.from(theirs[i]!.data));
        expect(f.delayNum, `duration ${i}`).toBe(theirs[i]!.duration);
        expect(f.delayDen).toBe(1000);
      });
    });
  }
  it('webp-ops.webp really exercises blending and disposal (libwebp chooses for the other fixture)', () => {
    const s = parseAnimatedWebp(fixture('webp-ops.webp'))!;
    expect(s.frames.map((f) => [f.blend, f.disposeToBackground])).toEqual([
      [false, false],
      [true, true],
      [false, false],
      [true, false],
    ]);
    expect(s.loops).toBe(3);
  });
  it("blendNonPremult reproduces libwebp's integer arithmetic (not the float formula)", () => {
    const dst = new Uint8Array([100, 50, 200, 100]);
    blendNonPremult(new Uint8Array([250, 30, 10, 160]), 0, dst, 0);
    // dst_factor_a = (100 * 96) >> 8 = 37; blend_a = 197; scale = 2^24 / 197 = 85163;
    // R = ((250*160 + 100*37) * 85163) >> 24 = 221 (the float formula would round to 222).
    expect(Array.from(dst)).toEqual([221, 33, 45, 197]); // G = ((30*160 + 50*37) * 85163) >> 24 = 33
    const opaque = new Uint8Array([7, 7, 7, 7]);
    blendNonPremult(new Uint8Array([255, 255, 40, 255]), 0, opaque, 0);
    expect(Array.from(opaque)).toEqual([255, 255, 40, 255]); // copied, as libwebp's row blender does
    const keep = new Uint8Array([1, 2, 3, 4]);
    blendNonPremult(new Uint8Array([9, 9, 9, 0]), 0, keep, 0);
    expect(Array.from(keep)).toEqual([1, 2, 3, 4]);
  });
  it('rejects malformed animations', () => {
    const b = fixture('webp-ops.webp').slice();
    const anmf = Buffer.from(b).indexOf('ANMF');
    b[anmf + 8] = 0xff; // X/2 = 255 -> outside the 32 px canvas
    expect(() => parseAnimatedWebp(b)).toThrow(/outside the canvas/);
    expect(parseAnimatedWebp(fixture('rgba-partial.webp'))).toBeNull();
  });
});

describe('animated WebP writing', () => {
  const anim = (): Animation => {
    const f0 = probeImage(20, 8, true, 5);
    const f1 = { ...f0, data: f0.data.slice() } as PixelData;
    for (let y = 3; y < 8; y++) for (let x = 5; x < 9; x++) f1.data.set([1, 2, 3, 0], (y * 20 + x) * 4); // odd x start: rounded out
    return { frames: [ { pixels: f0, delayNum: 1, delayDen: 10 }, { pixels: f1, delayNum: 70, delayDen: 1000 }, { pixels: probeImage(20, 8, true, 6), delayNum: 1, delayDen: 1 } ], loops: 5, hiddenDefault: false };
  };
  it('lossless round trip: libwebp and Airgap both read back every frame exactly (alpha-0 colour kept), durations and loops', async () => {
    const a = anim();
    const bytes = await encodeAnimatedWebp(a, encodeLossless, true);
    const theirs = ref.decodeAnimation(bytes, true);
    expect(theirs).toHaveLength(3);
    theirs.forEach((f, i) => expect(Array.from(f.data), `libwebp frame ${i}`).toEqual(Array.from(a.frames[i]!.pixels.data)));
    expect(theirs.map((f) => f.duration)).toEqual([100, 70, 1000]);
    const ours = (await decodeAnimatedWebp(bytes, still))!;
    expect(ours.loops).toBe(5);
    ours.frames.forEach((f, i) => expect(Array.from(f.pixels.data), `frame ${i}`).toEqual(Array.from(a.frames[i]!.pixels.data)));
  });
  it('later frames are the changed rectangle with even offsets, written without blending', async () => {
    const s = parseAnimatedWebp(await encodeAnimatedWebp(anim(), encodeLossless, true))!;
    expect(s.frames[1]).toMatchObject({ x: 4, y: 2, width: 5, height: 6, blend: false, disposeToBackground: false });
  });
  it('timing precision: WebP holds whole milliseconds', () => {
    expect(delayToMs({ delayNum: 1, delayDen: 30 })).toBe(33);
    expect(delaysFitMs([{ delayNum: 1, delayDen: 10 }, { delayNum: 7, delayDen: 100 }])).toBe(true);
    expect(delaysFitMs([{ delayNum: 1, delayDen: 30 }])).toBe(false);
  });
});
