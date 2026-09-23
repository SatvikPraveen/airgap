import { describe, expect, it } from 'vitest';
import { inspect } from '../../src/inspect';
import { extractMetadata, injectMetadata } from '../../src/metadata/containers';
import { summarizeExif } from '../../src/metadata/exif';
import { parseIcc } from '../../src/metadata/icc';
import { fixture } from './helpers';

const exif = extractMetadata(fixture('exif-gps.jpg'), 'jpeg').exif!;
const icc = fixture('display-p3.icc');
const xmp = new TextEncoder().encode('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>');

describe('extractMetadata', () => {
  it('JPEG: EXIF from APP1, ICC from APP2', () => {
    expect(summarizeExif(extractMetadata(fixture('exif-gps.jpg'), 'jpeg').exif!).hasGps).toBe(true);
    const lut = extractMetadata(fixture('icc-lut.jpg'), 'jpeg');
    expect(parseIcc(lut.icc!).kind).toBe('lut');
    expect(lut.exif).toBeUndefined();
  });
  it('PNG: iCCP is inflated', () => {
    const m = extractMetadata(fixture('icc-p3.png'), 'png');
    expect(Array.from(m.icc!)).toEqual(Array.from(icc));
    expect(parseIcc(m.icc!).description).toBe('Display P3 (fixture)');
  });
  it('WebP: EXIF and ICCP chunks', () => {
    const m = extractMetadata(fixture('exif-icc.webp'), 'webp');
    expect(summarizeExif(m.exif!).make).toBe('Airgap Fixtures');
    expect(Array.from(m.icc!)).toEqual(Array.from(icc));
  });
  it('plain files have nothing', () => {
    expect(extractMetadata(fixture('rgb8.png'), 'png')).toEqual({});
    expect(extractMetadata(fixture('rgba-partial.webp'), 'webp')).toEqual({});
  });
});

describe('injectMetadata round trips', () => {
  const cases: [string, 'png' | 'jpeg' | 'webp'][] = [
    ['rgb8.png', 'png'],
    ['exif-gps.jpg', 'jpeg'],
    ['rgba-partial.webp', 'webp'],
    ['exif-icc.webp', 'webp'],
  ];
  for (const [name, format] of cases) {
    it(`${name}: inject exif+icc+xmp, header sees them, extract returns identical payloads`, () => {
      const out = injectMetadata(fixture(name), format, { exif, icc, xmp });
      const h = inspect(out);
      expect(h.format).toBe(format);
      expect(h.metadata.hasExif).toBe(true);
      expect(h.metadata.hasGps).toBe(true);
      expect(h.metadata.hasIcc).toBe(true);
      expect(h.metadata.hasXmp).toBe(true);
      const back = extractMetadata(out, format);
      expect(Array.from(back.exif!)).toEqual(Array.from(exif));
      expect(Array.from(back.icc!)).toEqual(Array.from(icc));
      expect(Array.from(back.xmp!)).toEqual(Array.from(xmp));
      // Dimensions and alpha flags survive the container rewrite.
      const orig = inspect(fixture(name));
      expect([h.width, h.height, h.metadata.hasAlpha]).toEqual([orig.width, orig.height, orig.metadata.hasAlpha]);
    });
    it(`${name}: inject nothing strips everything`, () => {
      const stripped = injectMetadata(injectMetadata(fixture(name), format, { exif, icc, xmp }), format, {});
      const h = inspect(stripped).metadata;
      expect([h.hasExif, h.hasIcc, h.hasXmp]).toEqual([false, false, false]);
      expect(extractMetadata(stripped, format)).toEqual({});
    });
  }
  it('JPEG: replacing existing EXIF leaves exactly one APP1 Exif segment', () => {
    const out = injectMetadata(fixture('exif-gps.jpg'), 'jpeg', { exif });
    let count = 0;
    let off = 2;
    while (off + 4 <= out.length && out[off] === 0xff) {
      const marker = out[off + 1]!;
      if (marker === 0xda) break;
      const len = (out[off + 2]! << 8) | out[off + 3]!;
      if (marker === 0xe1 && String.fromCharCode(...out.subarray(off + 4, off + 8)) === 'Exif') count++;
      off += 2 + len;
    }
    expect(count).toBe(1);
  });
  it('JPEG: ICC larger than one segment is split and reassembled', () => {
    const big = new Uint8Array(150_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255;
    const out = injectMetadata(fixture('exif-gps.jpg'), 'jpeg', { icc: big });
    expect(Array.from(extractMetadata(out, 'jpeg').icc!)).toEqual(Array.from(big));
  });
  it('WebP: a simple VP8L file with no metadata stays a simple file', () => {
    const out = injectMetadata(fixture('rgba-partial.webp'), 'webp', {});
    expect(String.fromCharCode(...out.subarray(12, 16))).toBe('VP8L');
  });
  it('WebP: VP8X alpha flag reflects the bitstream', () => {
    const out = injectMetadata(fixture('rgba-partial.webp'), 'webp', { exif });
    expect(String.fromCharCode(...out.subarray(12, 16))).toBe('VP8X');
    expect(out[20]! & 0x10, 'alpha flag').toBe(0x10);
    expect(inspect(out).metadata.hasAlpha).toBe(true);
  });
});
