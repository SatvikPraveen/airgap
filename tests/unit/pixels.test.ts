import { describe, expect, it } from 'vitest';
import { flattenPixels, flattenRgba, unpremultiply, WHITE } from '../../src/flatten';
import { applyOrientation } from '../../src/orientation';
import { alphaStats, comparePixels, convertBitDepth, probeImage } from '../../src/pixels';
import * as P from '../fixtures/pattern.mjs';
import { pixelsFrom, rasterFrom } from './helpers';

describe('applyOrientation', () => {
  // 3x2 image, pixels labelled by value: [0 1 2 / 3 4 5] in the red channel.
  const img = pixelsFrom([0, 0, 0, 255, 1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255], 3, 2);
  const reds = (p: ReturnType<typeof applyOrientation>) => Array.from({ length: p.width * p.height }, (_, i) => p.data[i * 4]);
  const cases: [number, number, number, number[]][] = [
    [1, 3, 2, [0, 1, 2, 3, 4, 5]],
    [2, 3, 2, [2, 1, 0, 5, 4, 3]],
    [3, 3, 2, [5, 4, 3, 2, 1, 0]],
    [4, 3, 2, [3, 4, 5, 0, 1, 2]],
    [5, 2, 3, [0, 3, 1, 4, 2, 5]],
    [6, 2, 3, [3, 0, 4, 1, 5, 2]],
    [7, 2, 3, [5, 2, 4, 1, 3, 0]],
    [8, 2, 3, [2, 5, 1, 4, 0, 3]],
  ];
  for (const [o, w, h, want] of cases) {
    it(`orientation ${o}`, () => {
      const out = applyOrientation(img, o);
      expect([out.width, out.height]).toEqual([w, h]);
      expect(reds(out)).toEqual(want);
    });
  }
  it('orientation 6 on the quadrant fixture pattern: bottom-left becomes top-left', () => {
    const src = rasterFrom(P.ORIENT, (x, y) => P.quadrantPixel(x, y));
    const out = applyOrientation(src, 6);
    expect([out.width, out.height]).toEqual([P.ORIENT.height, P.ORIENT.width]);
    const at = (x: number, y: number) => Array.from(out.data.slice((y * out.width + x) * 4, (y * out.width + x) * 4 + 3));
    expect(at(0, 0)).toEqual([30, 60, 220]); // blue (was bottom-left)
    expect(at(out.width - 1, 0)).toEqual([220, 30, 30]); // red (was top-left)
    expect(at(out.width - 1, out.height - 1)).toEqual([30, 200, 40]); // green (was top-right)
    expect(at(0, out.height - 1)).toEqual([230, 220, 40]); // yellow (was bottom-right)
  });
  it('is identity for 1 and undefined and works at 16-bit', () => {
    expect(applyOrientation(img, 1)).toBe(img);
    expect(applyOrientation(img, undefined)).toBe(img);
    const px16 = pixelsFrom([1000, 0, 0, 65535, 2000, 0, 0, 65535], 2, 1, 16);
    expect(reds(applyOrientation(px16, 2))).toEqual([2000, 1000]);
  });
});

describe('convertBitDepth', () => {
  it('8 -> 16 is exact bit replication and back is exact', () => {
    const px = pixelsFrom([0, 1, 128, 255], 1, 1);
    const up = convertBitDepth(px, 16);
    expect(Array.from(up.data)).toEqual([0, 257, 32896, 65535]);
    expect(Array.from(convertBitDepth(up, 8).data)).toEqual([0, 1, 128, 255]);
  });
  it('16 -> 8 rounds to nearest', () => {
    expect(Array.from(convertBitDepth(pixelsFrom([12345, 999, 31, 65535], 1, 1, 16), 8).data)).toEqual([48, 4, 0, 255]);
  });
  it('10 -> 12 -> 10 is exact', () => {
    const px = pixelsFrom([0, 1, 512, 1023], 1, 1, 10);
    const up = convertBitDepth(px, 12);
    expect(up.bitDepth).toBe(12);
    expect(Array.from(convertBitDepth(up, 10).data)).toEqual([0, 1, 512, 1023]);
  });
});

describe('flatten', () => {
  it('8-bit: transparent -> background, semi composited, opaque untouched', () => {
    expect(Array.from(flattenRgba(new Uint8ClampedArray([200, 100, 50, 0, 10, 20, 30, 255, 0, 0, 0, 128]), WHITE))).toEqual([255, 255, 255, 255, 10, 20, 30, 255, 127, 127, 127, 255]);
  });
  it('16-bit: background scaled by bit replication', () => {
    const out = flattenPixels(pixelsFrom([1, 2, 3, 0, 0, 0, 0, 32768], 2, 1, 16), { r: 255, g: 0, b: 128 });
    expect(Array.from(out.data.slice(0, 4))).toEqual([65535, 0, 32896, 65535]);
    expect(out.data[4]).toBe(Math.round((65535 * 32767) / 65535));
  });
  it('unpremultiply inverts premultiplication within rounding', () => {
    const out = unpremultiply(pixelsFrom([50, 25, 12, 128], 1, 1));
    expect(Array.from(out.data)).toEqual([100, 50, 24, 128]);
  });
});

describe('alphaStats / comparePixels / probeImage', () => {
  it('probe image has every alpha band and non-zero colour under alpha 0', () => {
    const px = probeImage(24, 8, true);
    const s = alphaStats(px);
    expect(s).toEqual({ hasTransparency: true, hasSemiTransparency: true });
    let colourUnderZero = false;
    for (let i = 0; i < px.data.length; i += 4) if (px.data[i + 3] === 0 && (px.data[i] || px.data[i + 1] || px.data[i + 2])) colourUnderZero = true;
    expect(colourUnderZero).toBe(true);
    expect(alphaStats(probeImage(8, 8, false))).toEqual({ hasTransparency: false, hasSemiTransparency: false });
  });
  it('comparePixels distinguishes visible from hidden differences', () => {
    const a = pixelsFrom([9, 9, 9, 0, 1, 2, 3, 255], 2, 1);
    const b = pixelsFrom([0, 0, 0, 0, 1, 2, 3, 255], 2, 1);
    expect(comparePixels(a, b)).toEqual({ identical: false, differingPixels: 1, differingVisiblePixels: 0, maxChannelDiff: 9 });
    expect(comparePixels(a, a).identical).toBe(true);
  });
});
