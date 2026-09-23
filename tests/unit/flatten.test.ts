import { describe, expect, it } from 'vitest';
import { alphaStats, flattenRgba, parseHexColor, toHexColor, WHITE } from '../../src/flatten';
import * as P from '../fixtures/pattern.mjs';

describe('flattenRgba', () => {
  it('opaque pixels pass through unchanged, alpha forced to 255', () => {
    const src = new Uint8ClampedArray([10, 20, 30, 255]);
    expect(Array.from(flattenRgba(src, { r: 0, g: 0, b: 0 }))).toEqual([10, 20, 30, 255]);
  });
  it('fully transparent pixels become the background exactly, never black by default', () => {
    const src = new Uint8ClampedArray([200, 100, 50, 0]);
    expect(Array.from(flattenRgba(src, WHITE))).toEqual([255, 255, 255, 255]);
    expect(Array.from(flattenRgba(src, { r: 255, g: 0, b: 0 }))).toEqual([255, 0, 0, 255]);
  });
  it('semi-transparent pixels composite with round-to-nearest', () => {
    // 50% of (0,0,0) over white -> 127.5 -> rounds to 128 with +127 bias? (0*128 + 255*127 + 127)/255 = 127.49 -> 127
    const half = new Uint8ClampedArray([0, 0, 0, 128]);
    expect(Array.from(flattenRgba(half, WHITE))).toEqual([127, 127, 127, 255]);
    const q = new Uint8ClampedArray([255, 0, 0, 64]);
    // r: (255*64 + 255*191 + 127)/255 = 255 ; g: (0 + 255*191 + 127)/255 = 191.5 -> 191 (integer division via clamped array floors)
    const out = flattenRgba(q, WHITE);
    expect(out[0]).toBe(255);
    expect(out[1]).toBeGreaterThanOrEqual(191);
    expect(out[1]).toBeLessThanOrEqual(192);
    expect(out[3]).toBe(255);
  });
  it('does not mutate the input', () => {
    const src = new Uint8ClampedArray([1, 2, 3, 0, 4, 5, 6, 128]);
    const copy = new Uint8ClampedArray(src);
    flattenRgba(src, WHITE);
    expect(Array.from(src)).toEqual(Array.from(copy));
  });
  it('the fixture pattern: transparent band becomes background, opaque band untouched', () => {
    const { width, height } = P.RGBA_PARTIAL;
    const noise = P.lcg(2);
    const src = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        src.set(P.rgbaPixel(x, y, noise), (y * width + x) * 4);
      }
    }
    const bg = { r: 12, g: 34, b: 56 };
    const out = flattenRgba(src, bg);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        expect(out[i + 3]).toBe(255);
        if (y < 12) expect(Array.from(out.slice(i, i + 3))).toEqual(Array.from(src.slice(i, i + 3)));
        if (y >= 24 && y < 36) expect(Array.from(out.slice(i, i + 3))).toEqual([12, 34, 56]);
      }
    }
  });
});

describe('alphaStats', () => {
  it('classifies opaque / binary / semi', () => {
    expect(alphaStats(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]))).toEqual({
      hasTransparency: false,
      hasSemiTransparency: false,
    });
    expect(alphaStats(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]))).toEqual({
      hasTransparency: true,
      hasSemiTransparency: false,
    });
    expect(alphaStats(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 7]))).toEqual({
      hasTransparency: true,
      hasSemiTransparency: true,
    });
  });
});

describe('hex colours', () => {
  it('round-trips', () => {
    expect(parseHexColor('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseHexColor('FF8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(toHexColor({ r: 255, g: 128, b: 0 })).toBe('#ff8000');
    expect(() => parseHexColor('#fff')).toThrow();
  });
});
