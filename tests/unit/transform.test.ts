import { describe, expect, it } from 'vitest';
import type { PixelData } from '../../src/codecs/types';
import { applyOrientation } from '../../src/orientation';
import { probeImage } from '../../src/pixels';
import {
  applyTransform,
  crop,
  isIdentity,
  isResampling,
  lanczos3,
  orientationFor,
  outputSize,
  resampleLanczos3,
  transformError,
  type Rotation,
} from '../../src/transform';
import { rasterFrom } from './helpers';

const at = (px: PixelData, x: number, y: number) => Array.from(px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 4));

/** Reference: mirror and rotate by explicit coordinate mapping, one step at a time. */
function reference(px: PixelData, rotate: Rotation, flipH: boolean, flipV: boolean): PixelData {
  let cur = px;
  if (flipH) cur = applyOrientation(cur, 2);
  if (flipV) cur = applyOrientation(cur, 4);
  for (let r = 0; r < rotate; r += 90) cur = applyOrientation(cur, 6);
  return cur;
}

describe('orientation composition', () => {
  const src = probeImage(7, 16, true); // non-square would hide transposition bugs less; use a 7x5 crop below too
  const rect = crop(src, { x: 0, y: 0, width: 7, height: 5 });
  for (const rotate of [0, 90, 180, 270] as Rotation[]) {
    for (const flipH of [false, true]) {
      for (const flipV of [false, true]) {
        it(`flipH=${flipH} flipV=${flipV} rotate=${rotate} equals mirroring then rotating step by step`, () => {
          const one = applyTransform(rect, { rotate, flipH, flipV });
          const ref = reference(rect, rotate, flipH, flipV);
          expect([one.width, one.height]).toEqual([ref.width, ref.height]);
          expect(Array.from(one.data)).toEqual(Array.from(ref.data));
        });
      }
    }
  }
  it('every combination maps to one of the eight EXIF orientations, each exactly twice', () => {
    const seen = new Map<number, number>();
    for (const rotate of [0, 90, 180, 270] as Rotation[]) for (const flipH of [false, true]) for (const flipV of [false, true]) {
      const o = orientationFor({ rotate, flipH, flipV });
      seen.set(o, (seen.get(o) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...seen.values()].every((n) => n === 2)).toBe(true);
  });
});

describe('crop', () => {
  it('keeps exactly the pixels inside the rectangle, at any depth', () => {
    const src = probeImage(16, 16, true);
    const c = crop(src, { x: 3, y: 5, width: 6, height: 4 });
    expect([c.width, c.height, c.bitDepth]).toEqual([6, 4, 16]);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) expect(at(c, x, y)).toEqual(at(src, x + 3, y + 5));
  });
  it('a full-size crop returns the input unchanged', () => {
    const src = probeImage(4, 8, false);
    expect(crop(src, { x: 0, y: 0, width: 4, height: 4 })).toBe(src);
  });
  it('crop happens in source coordinates before rotation', () => {
    const src = rasterFrom({ width: 4, height: 2 }, (x, y) => [x, y, 0]);
    const out = applyTransform(src, { rotate: 90, flipH: false, flipV: false, crop: { x: 1, y: 0, width: 2, height: 2 } });
    expect([out.width, out.height]).toEqual([2, 2]);
    // Rotating [[1,2],[1,2]] (x values; rows y=0,1) clockwise: top row becomes source column 1 bottom-up.
    expect(at(out, 0, 0).slice(0, 2)).toEqual([1, 1]);
    expect(at(out, 1, 0).slice(0, 2)).toEqual([1, 0]);
    expect(at(out, 0, 1).slice(0, 2)).toEqual([2, 1]);
  });
});

describe('validation and sizes', () => {
  it('rejects crops outside the image, fractional values and empty outputs', () => {
    expect(transformError(10, 10, { rotate: 0, flipH: false, flipV: false, crop: { x: 5, y: 5, width: 6, height: 1 } })).toMatch(/inside/);
    expect(transformError(10, 10, { rotate: 0, flipH: false, flipV: false, crop: { x: 0.5, y: 0, width: 1, height: 1 } })).toMatch(/whole/);
    expect(transformError(10, 10, { rotate: 0, flipH: false, flipV: false, resize: { width: 0, height: 3 } })).toMatch(/at least/);
    expect(transformError(10, 10, { rotate: 45 as Rotation, flipH: false, flipV: false })).toMatch(/Rotation/);
    expect(transformError(10, 10, { rotate: 90, flipH: true, flipV: false, crop: { x: 0, y: 0, width: 10, height: 10 }, resize: { width: 3, height: 3 } })).toBeNull();
    expect(() => applyTransform(probeImage(4, 8, false), { rotate: 0, flipH: false, flipV: false, crop: { x: 0, y: 0, width: 9, height: 1 } })).toThrow(/inside/);
  });
  it('output size: crop, then rotation swaps, then resize wins', () => {
    const t = { rotate: 90 as Rotation, flipH: false, flipV: false, crop: { x: 0, y: 0, width: 30, height: 20 } };
    expect(outputSize(100, 50, t)).toEqual({ width: 20, height: 30 });
    expect(outputSize(100, 50, { ...t, resize: { width: 10, height: 15 } })).toEqual({ width: 10, height: 15 });
    expect(isResampling(100, 50, { ...t, resize: { width: 20, height: 30 } })).toBe(false);
    expect(isIdentity(100, 50, { rotate: 0, flipH: true, flipV: true })).toBe(false); // that is a 180° rotation
    expect(isIdentity(100, 50, { rotate: 0, flipH: false, flipV: false, crop: { x: 0, y: 0, width: 100, height: 50 }, resize: { width: 100, height: 50 } })).toBe(true);
  });
});

describe('Lanczos-3 resampling', () => {
  it('the kernel is 1 at 0, 0 at non-zero integers, and 0 outside the support', () => {
    expect(lanczos3(0)).toBe(1);
    for (const n of [1, 2, -1, -2]) expect(Math.abs(lanczos3(n))).toBeLessThan(1e-12);
    expect(lanczos3(3)).toBe(0);
    expect(lanczos3(-3.5)).toBe(0);
  });
  it('a constant image stays exactly constant when down- and upscaled, at 8 and 16 bits', () => {
    for (const depth of [8, 16]) {
      const v = depth === 8 ? [200, 17, 99, 255] : [51234, 7, 65535, 65535];
      const src = rasterFrom({ width: 37, height: 23 }, () => v, depth);
      for (const [w, h] of [[10, 7], [37, 23], [80, 51]]) {
        const out = resampleLanczos3(src, w!, h!);
        for (let i = 0; i < out.data.length; i += 4) expect(Array.from(out.data.subarray(i, i + 4))).toEqual(v);
      }
    }
  });
  it('same size is the identity (weights collapse to 1 on the centre tap)', () => {
    const src = probeImage(12, 8, false);
    expect(Array.from(resampleLanczos3(src, 12, 12).data)).toEqual(Array.from(src.data));
  });
  it('a 2x downscale of a 2x nearest-neighbour upscale returns the original within rounding of ringing', () => {
    const small = rasterFrom({ width: 8, height: 8 }, (x, y) => [x * 30, y * 30, (x + y) * 15]);
    const big = rasterFrom({ width: 16, height: 16 }, (x, y) => at(small, x >> 1, y >> 1));
    const back = resampleLanczos3(big, 8, 8);
    // Interior pixels: within a few levels (Lanczos rings at the steps of a staircase input).
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) for (let c = 0; c < 3; c++) expect(Math.abs(at(back, x, y)[c]! - at(small, x, y)[c]!)).toBeLessThanOrEqual(4);
  });
  it('mean intensity is preserved on a smooth gradient (energy within 0.5 level)', () => {
    const src = rasterFrom({ width: 64, height: 64 }, (x, y) => [x * 4, y * 4, 128]);
    const out = resampleLanczos3(src, 21, 21);
    const mean = (px: PixelData, c: number) => {
      let s = 0;
      for (let i = c; i < px.data.length; i += 4) s += px.data[i]!;
      return s / (px.width * px.height);
    };
    for (const c of [0, 1, 2]) expect(Math.abs(mean(out, c) - mean(src, c))).toBeLessThan(0.5);
  });
  it('premultiplied: hidden colour under alpha 0 does not bleed into visible neighbours', () => {
    // Left half opaque white, right half fully transparent but storing pure red.
    const src = rasterFrom({ width: 16, height: 4 }, (x) => (x < 8 ? [255, 255, 255, 255] : [255, 0, 0, 0]));
    const out = resampleLanczos3(src, 8, 4);
    for (let x = 0; x < 8; x++) {
      const [r, g, b, a] = at(out, x, 1);
      if (a! > 0) {
        expect(g, `x=${x} green`).toBe(r); // no red tint: un-premultiplied colour stays white/grey
        expect(b, `x=${x} blue`).toBe(r);
      } else expect([r, g, b]).toEqual([0, 0, 0]);
    }
  });
});
