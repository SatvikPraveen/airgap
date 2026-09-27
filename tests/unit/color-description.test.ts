/**
 * CICP colour descriptions: read from AVIF `colr`/nclx, PNG `cICP` and the
 * JPEG XL codestream; reported as a loss when not sRGB-like.
 */
import { describe, expect, it } from 'vitest';
import { computeLosses, DEFAULT_MODES, describeColor, isHdr, isSrgbLike } from '../../src/capabilities';
import { cicp, inspect } from '../../src/inspect';
import { caps, fixture, META } from './helpers';

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...Array.from(type).map((c) => c.charCodeAt(0)), ...body];
}
const fourcc = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

/** Minimal AVIF: ftyp + meta(iprp(ipco(ispe, colr nclx))). Enough for the header inspector. */
function avifWithNclx(primaries: number, transfer: number, matrix: number, fullRange: boolean): Uint8Array {
  const ispe = box('ispe', [0, 0, 0, 0], u32(8), u32(8));
  const colr = box('colr', fourcc('nclx'), [primaries >> 8, primaries & 255, transfer >> 8, transfer & 255, matrix >> 8, matrix & 255, fullRange ? 0x80 : 0]);
  const meta = box('meta', [0, 0, 0, 0], box('iprp', box('ipco', ispe, colr)));
  return new Uint8Array([...box('ftyp', fourcc('avif'), u32(0), fourcc('avif'), fourcc('mif1')), ...meta]);
}

/** PNG signature + IHDR + optional cICP + IEND (no pixel data needed by the inspector). */
function pngWithCicp(cicpBytes: number[] | null): Uint8Array {
  const crc = [0, 0, 0, 0];
  const chunk = (type: string, data: number[]) => [...u32(data.length), ...fourcc(type), ...data, ...crc];
  const ihdr = chunk('IHDR', [...u32(4), ...u32(4), 8, 2, 0, 0, 0]);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...(cicpBytes ? chunk('cICP', cicpBytes) : []), ...chunk('IEND', [])]);
}

describe('reading colour descriptions', () => {
  it('cicp(): unspecified primaries and transfer carry no information', () => {
    expect(cicp(2, 2)).toBeUndefined();
    expect(cicp(0, 0)).toBeUndefined();
    expect(cicp(1, 13)).toEqual({ primaries: 1, transfer: 13 });
    expect(cicp(9, 16, 9, true)).toEqual({ primaries: 9, transfer: 16, matrix: 9, fullRange: true });
  });
  it('AVIF fixture (lossless, unspecified/identity nclx) reports nothing', () => {
    expect(inspect(fixture('rgba-partial.avif')).metadata.colorDescription).toBeUndefined();
  });
  it('AVIF colr/nclx with BT.2020 + PQ is read as HDR', () => {
    const m = inspect(avifWithNclx(9, 16, 9, true)).metadata;
    expect(m.colorDescription).toEqual({ primaries: 9, transfer: 16, matrix: 9, fullRange: true });
    expect(isHdr(m.colorDescription!)).toBe(true);
    expect(isSrgbLike(m.colorDescription!)).toBe(false);
    expect(describeColor(m.colorDescription!)).toBe('BT.2020 primaries and PQ transfer (HDR)');
  });
  it('AVIF colr/nclx with sRGB primaries and transfer is sRGB-like', () => {
    const m = inspect(avifWithNclx(1, 13, 1, true)).metadata;
    expect(m.colorDescription).toEqual({ primaries: 1, transfer: 13, matrix: 1, fullRange: true });
    expect(isSrgbLike(m.colorDescription!)).toBe(true);
  });
  it('PNG cICP chunk: Display P3 + sRGB transfer is wide gamut, absent chunk reports nothing', () => {
    const m = inspect(pngWithCicp([12, 13, 0, 1])).metadata;
    expect(m.colorDescription).toEqual({ primaries: 12, transfer: 13, matrix: 0, fullRange: true });
    expect(isSrgbLike(m.colorDescription!)).toBe(false);
    expect(isHdr(m.colorDescription!)).toBe(false);
    expect(inspect(pngWithCicp(null)).metadata.colorDescription).toBeUndefined();
  });
  it('JPEG XL fixture (sRGB) reports nothing and still parses the rest of the header', () => {
    const m = inspect(fixture('rgba-partial.jxl')).metadata;
    expect(m.colorDescription).toBeUndefined();
    expect(m.bitDepthUncertain).toBeUndefined();
    expect(m.hasAlpha).toBe(true);
  });
});

describe('colour description losses', () => {
  const hdr = { ...META, colorDescription: { primaries: 9, transfer: 16 } };
  const p3 = { ...META, colorDescription: { primaries: 12, transfer: 13 } };
  const srgb = { ...META, colorDescription: { primaries: 1, transfer: 13 } };
  const target = { format: 'png' as const, lossless: true, ...DEFAULT_MODES };

  it('HDR source through a decoder that keeps values: a metadata-severity loss that names HDR', () => {
    const l = computeLosses({ format: 'avif', metadata: hdr }, target, { decoder: caps(), encoder: caps() });
    const cd = l.find((x) => x.kind === 'color-description');
    expect(cd?.severity).toBe('metadata');
    expect(cd?.message).toMatch(/BT\.2020 primaries and PQ transfer \(HDR\)/);
    expect(cd?.message).toMatch(/dark and desaturated/);
    expect(l.some((x) => x.kind === 'color-convert')).toBe(false);
  });
  it('wide-gamut source through a decoder that converts to sRGB itself: a pixels-severity loss', () => {
    const l = computeLosses({ format: 'jxl', metadata: p3 }, target, { decoder: caps({ decodeAppliesIcc: true }), encoder: caps() });
    const cc = l.find((x) => x.kind === 'color-convert');
    expect(cc?.severity).toBe('pixels');
    expect(cc?.message).toMatch(/Display P3 primaries/);
    expect(l.some((x) => x.kind === 'color-description')).toBe(false);
  });
  it('an sRGB description is not a loss', () => {
    const l = computeLosses({ format: 'avif', metadata: srgb }, target, { decoder: caps(), encoder: caps() });
    expect(l.filter((x) => x.kind === 'color-description' || x.kind === 'color-convert')).toEqual([]);
  });
});
