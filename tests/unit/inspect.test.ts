import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspect, parseTiff, sniffFormat, UnsupportedFormatError } from '../../src/inspect';
import * as P from '../fixtures/pattern.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => new Uint8Array(readFileSync(join(here, '..', 'fixtures', name)));

describe('inspect: PNG', () => {
  it('rgb8.png: 8-bit, no alpha, no metadata', () => {
    const h = inspect(fx('rgb8.png'));
    expect(h).toMatchObject({
      format: 'png',
      width: P.RGB8.width,
      height: P.RGB8.height,
      metadata: { bitDepth: 8, hasAlpha: false, hasExif: false, hasIcc: false, isAnimated: false },
    });
  });
  it('rgba-partial.png: alpha channel declared', () => {
    expect(inspect(fx('rgba-partial.png')).metadata.hasAlpha).toBe(true);
  });
  it('rgb16.png: 16-bit', () => {
    const h = inspect(fx('rgb16.png'));
    expect(h.metadata.bitDepth).toBe(16);
    expect(h.width).toBe(P.RGB16.width);
  });
  it('one-pixel.png', () => {
    expect(inspect(fx('one-pixel.png'))).toMatchObject({ width: 1, height: 1 });
  });
  it('detects tRNS, iCCP, acTL and eXIf chunks', () => {
    const png = buildPng(4, 3, 8, 2, [
      ['tRNS', new Uint8Array([0, 0, 0, 0, 0, 0])],
      ['iCCP', new Uint8Array([0x61, 0, 0, 0])],
      ['acTL', new Uint8Array(8)],
      ['eXIf', tiffWithGps()],
    ]);
    const h = inspect(png);
    expect(h.metadata).toMatchObject({
      hasAlpha: true,
      hasIcc: true,
      isAnimated: true,
      hasExif: true,
      hasGps: true,
      orientation: 8,
    });
  });
  it('palette PNG with sub-8-bit depth reports 8-bit (palette samples are 8-bit)', () => {
    const png = buildPng(2, 2, 4, 3, [['PLTE', new Uint8Array(6)]]);
    expect(inspect(png).metadata.bitDepth).toBe(8);
  });
});

describe('inspect: JPEG', () => {
  it('exif-gps.jpg: EXIF with GPS, orientation 1, 8-bit, no alpha', () => {
    const h = inspect(fx('exif-gps.jpg'));
    expect(h).toMatchObject({
      format: 'jpeg',
      width: P.EXIF_GPS.width,
      height: P.EXIF_GPS.height,
      metadata: {
        bitDepth: 8,
        hasAlpha: false,
        hasExif: true,
        hasGps: true,
        orientation: 1,
        hasIcc: false,
        hasXmp: false,
        sourceLossless: false,
      },
    });
  });
  it('detects an APP2 ICC_PROFILE segment', () => {
    const src = fx('exif-gps.jpg');
    const icc = new TextEncoder().encode('ICC_PROFILE\0');
    const seg = new Uint8Array(4 + icc.length + 4);
    seg[0] = 0xff;
    seg[1] = 0xe2;
    seg[2] = ((seg.length - 2) >> 8) & 255;
    seg[3] = (seg.length - 2) & 255;
    seg.set(icc, 4);
    const withIcc = new Uint8Array([...src.subarray(0, 2), ...seg, ...src.subarray(2)]);
    expect(inspect(withIcc).metadata.hasIcc).toBe(true);
  });
});

describe('inspect: WebP', () => {
  it('VP8X with alpha + EXIF + ICC flags', () => {
    const bytes = webpVp8x(0x20 | 0x10 | 0x08, 640, 480, 'VP8 ');
    const h = inspect(bytes);
    expect(h).toMatchObject({
      format: 'webp',
      width: 640,
      height: 480,
      metadata: { hasAlpha: true, hasExif: true, hasIcc: true, isAnimated: false, sourceLossless: false },
    });
  });
  it('VP8L simple lossless with alpha bit', () => {
    const bytes = webpVp8l(17, 9, true);
    const h = inspect(bytes);
    expect(h).toMatchObject({
      width: 17,
      height: 9,
      metadata: { hasAlpha: true, sourceLossless: true },
    });
  });
  it('animated flag', () => {
    expect(inspect(webpVp8x(0x02, 2, 2, 'VP8 ')).metadata.isAnimated).toBe(true);
  });
});

describe('sniffFormat / unsupported', () => {
  it('rejects non-image bytes', () => {
    expect(sniffFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
    expect(() => inspect(new Uint8Array(20))).toThrow(UnsupportedFormatError);
  });
  it('rejects GIF and BMP (not Phase 1)', () => {
    expect(sniffFormat(new TextEncoder().encode('GIF89a' + '\0'.repeat(20)))).toBeNull();
    expect(sniffFormat(new TextEncoder().encode('BM' + '\0'.repeat(20)))).toBeNull();
  });
});

describe('parseTiff', () => {
  it('little-endian with orientation only', () => {
    const t = new Uint8Array([
      0x49, 0x49, 42, 0, 8, 0, 0, 0, // II, 42, IFD0 at 8
      1, 0, // one entry
      0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, // Orientation SHORT = 6
      0, 0, 0, 0,
    ]);
    expect(parseTiff(t)).toEqual({ hasGps: false, orientation: 6 });
  });
  it('garbage is harmless', () => {
    expect(parseTiff(new Uint8Array([1, 2, 3]))).toEqual({ hasGps: false });
    expect(parseTiff(new TextEncoder().encode('XXXXXXXXXXXX'))).toEqual({ hasGps: false });
  });
});

// ---------------------------------------------------------------- builders

function crcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC = crcTable();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function buildPng(
  w: number,
  h: number,
  bitDepth: number,
  colorType: number,
  extra: [string, Uint8Array][],
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra.map(([t, d]) => chunk(t, d)),
    chunk('IDAT', new Uint8Array(0)),
    chunk('IEND', new Uint8Array(0)),
  ];
  return concat(parts);
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function tiffWithGps(): Uint8Array {
  // MM, IFD0 { Orientation=8, GPSInfo -> 0x1a }, GPS IFD { 0 entries }
  const t = new Uint8Array(8 + 2 + 24 + 4 + 2 + 4);
  const dv = new DataView(t.buffer);
  t.set([0x4d, 0x4d, 0, 42], 0);
  dv.setUint32(4, 8);
  dv.setUint16(8, 2);
  dv.setUint16(10, 0x0112);
  dv.setUint16(12, 3);
  dv.setUint32(14, 1);
  dv.setUint16(18, 8);
  dv.setUint16(22, 0x8825);
  dv.setUint16(24, 4);
  dv.setUint32(26, 1);
  dv.setUint32(30, 38);
  dv.setUint32(34, 0);
  dv.setUint16(38, 0);
  return t;
}
function riff(chunks: [string, Uint8Array][]): Uint8Array {
  const body = concat(
    chunks.map(([t, d]) => {
      const c = new Uint8Array(8 + d.length + (d.length & 1));
      c.set(new TextEncoder().encode(t), 0);
      new DataView(c.buffer).setUint32(4, d.length, true);
      c.set(d, 8);
      return c;
    }),
  );
  const head = new Uint8Array(12);
  head.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set(new TextEncoder().encode('WEBP'), 8);
  return concat([head, body]);
}
function webpVp8x(flags: number, w: number, h: number, bitstream: string): Uint8Array {
  const x = new Uint8Array(10);
  x[0] = flags;
  x[4] = (w - 1) & 255;
  x[5] = ((w - 1) >> 8) & 255;
  x[6] = ((w - 1) >> 16) & 255;
  x[7] = (h - 1) & 255;
  x[8] = ((h - 1) >> 8) & 255;
  x[9] = ((h - 1) >> 16) & 255;
  return riff([
    ['VP8X', x],
    [bitstream, new Uint8Array(16)],
  ]);
}
function webpVp8l(w: number, h: number, alpha: boolean): Uint8Array {
  const d = new Uint8Array(6);
  d[0] = 0x2f;
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
  new DataView(d.buffer).setUint32(1, bits >>> 0, true);
  return riff([['VP8L', d]]);
}
