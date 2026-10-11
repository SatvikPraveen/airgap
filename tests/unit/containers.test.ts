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

describe('JPEG XL container metadata', () => {
  it('reads EXIF (after the 4-byte TIFF offset) and XMP from Exif / xml boxes', () => {
    const jxl = fixture('exif-gps.jxl');
    const h = inspect(jxl);
    expect(h.format).toBe('jxl');
    expect(h.metadata).toMatchObject({ hasExif: true, hasGps: true, hasXmp: true });
    expect(h.metadata.exifOpaque).toBeUndefined();
    const m = extractMetadata(jxl, 'jxl');
    // The fixture script wrote the same TIFF into exif-gps.jpg's APP1: byte-identical payloads.
    expect(Array.from(m.exif!)).toEqual(Array.from(extractMetadata(fixture('exif-gps.jpg'), 'jpeg').exif!));
    expect(new TextDecoder().decode(m.xmp!)).toContain('CreatorTool="Airgap fixtures"');
  });
  it('a bare codestream has no boxes and no payloads', () => {
    expect(extractMetadata(fixture('rgba-partial.jxl'), 'jxl')).toEqual({});
  });
  it('Brotli-compressed (brob) Exif / xml boxes are flagged opaque, never ignored', () => {
    const box = (type: string, payload: number[]) => {
      const b = new Uint8Array(8 + payload.length);
      new DataView(b.buffer).setUint32(0, b.length);
      b.set(new TextEncoder().encode(type), 4);
      b.set(payload, 8);
      return Array.from(b);
    };
    const codestream = Array.from(fixture('rgba-partial.jxl'));
    const file = new Uint8Array([
      ...[0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a],
      ...box('ftyp', [0x6a, 0x78, 0x6c, 0x20, 0, 0, 0, 0, 0x6a, 0x78, 0x6c, 0x20]),
      ...box('brob', [...new TextEncoder().encode('Exif'), 1, 2, 3, 4]),
      ...box('brob', [...new TextEncoder().encode('xml '), 5, 6]),
      ...box('jxlc', codestream),
    ]);
    const h = inspect(file);
    expect(h.metadata).toMatchObject({ hasExif: true, exifOpaque: true, hasXmp: true, xmpOpaque: true, hasGps: false });
    expect(extractMetadata(file, 'jxl')).toEqual({});
  });
});
