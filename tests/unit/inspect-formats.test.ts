import { describe, expect, it } from 'vitest';
import { inspect, sniffFormat } from '../../src/inspect';
import { fixture } from './helpers';

describe('inspect: new formats and fields', () => {
  it('JPEG fixtures: EXIF facts, XMP absent, orientation 6', () => {
    const o = inspect(fixture('exif-orient6.jpg'));
    expect(o.metadata.orientation).toBe(6);
    expect(o.metadata.hasGps).toBe(true);
    expect([o.width, o.height]).toEqual([48, 32]);
    expect(inspect(fixture('icc-lut.jpg')).metadata.hasIcc).toBe(true);
  });
  it('PNG: iCCP and 16-bit RGBA', () => {
    expect(inspect(fixture('icc-p3.png')).metadata.hasIcc).toBe(true);
    const m = inspect(fixture('rgba16.png')).metadata;
    expect([m.bitDepth, m.hasAlpha]).toEqual([16, true]);
  });
  it('WebP fixtures: VP8L alpha; extended container flags', () => {
    const s = inspect(fixture('rgba-partial.webp'));
    expect(s.format).toBe('webp');
    expect(s.metadata.hasAlpha).toBe(true);
    expect(s.metadata.sourceLossless).toBe(true);
    const x = inspect(fixture('exif-icc.webp')).metadata;
    expect([x.hasExif, x.hasGps, x.hasIcc, x.hasXmp]).toEqual([true, true, true, false]);
  });
  it('AVIF: dimensions, 8-bit from av1C, alpha auxiliary item', () => {
    const a = inspect(fixture('rgba-partial.avif'));
    expect(a.format).toBe('avif');
    expect([a.width, a.height]).toEqual([64, 48]);
    expect(a.metadata.bitDepth).toBe(8);
    expect(a.metadata.bitDepthUncertain).toBeUndefined();
    expect(a.metadata.hasAlpha).toBe(true);
    expect(a.metadata.hasExif).toBe(false);
  });
  it('JPEG XL: codestream header gives size, 8-bit, alpha', () => {
    const j = inspect(fixture('rgba-partial.jxl'));
    expect(j.format).toBe('jxl');
    expect([j.width, j.height]).toEqual([64, 48]);
    expect(j.metadata.bitDepth).toBe(8);
    expect(j.metadata.bitDepthUncertain).toBeUndefined();
    expect(j.metadata.hasAlpha).toBe(true);
  });
  it('TIFF fixtures: depth, alpha, ExtraSamples, big-endian', () => {
    const t = inspect(fixture('rgba-partial.tif'));
    expect(t.format).toBe('tiff');
    expect([t.width, t.height, t.metadata.bitDepth, t.metadata.hasAlpha]).toEqual([64, 48, 8, true]);
    expect(t.metadata.alphaAssociated).toBeUndefined();
    expect(inspect(fixture('rgb16.tif')).metadata.bitDepth).toBe(16);
    expect(inspect(fixture('rgb8.tif')).metadata.hasAlpha).toBe(false);
  });
  it('sniffFormat covers every fixture', () => {
    const want: Record<string, string> = {
      'rgb8.png': 'png', 'exif-gps.jpg': 'jpeg', 'rgba-partial.webp': 'webp', 'rgba-partial.avif': 'avif', 'rgba-partial.jxl': 'jxl', 'rgb8.tif': 'tiff',
    };
    for (const [f, fmt] of Object.entries(want)) expect(sniffFormat(fixture(f)), f).toBe(fmt);
  });
});
