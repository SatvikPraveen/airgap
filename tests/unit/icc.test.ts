import { describe, expect, it } from 'vitest';
import { convertToSrgb, evalCurve, parseIcc } from '../../src/metadata/icc';
import { extractMetadata } from '../../src/metadata/containers';
import * as P from '../fixtures/pattern.mjs';
import { fixture, pixelsFrom } from './helpers';

const p3 = parseIcc(fixture('display-p3.icc'));

describe('parseIcc', () => {
  it('Display P3 fixture is a matrix/TRC profile, not sRGB', () => {
    expect(p3.kind).toBe('matrix');
    expect(p3.deviceClass).toBe('mntr');
    expect(p3.description).toBe('Display P3 (fixture)');
    expect(p3.isSrgb).toBe(false);
    expect(p3.matrix![0]).toBeCloseTo(0.51512, 3);
    expect(p3.trc![0].kind).toBe('para');
  });
  it('LUT fixture is classified lut even though it has a white point', () => {
    const lut = parseIcc(extractMetadata(fixture('icc-lut.jpg'), 'jpeg').icc!);
    expect(lut.kind).toBe('lut');
    expect(lut.tags).toContain('A2B0');
    expect(lut.matrix).toBeUndefined();
  });
  it('a profile with both matrix and A2B0 tags is treated as lut (never approximated)', () => {
    const src = fixture('display-p3.icc');
    // Rename the cprt tag to A2B0 in the tag table: presence is all the classifier looks at.
    const b = new Uint8Array(src);
    const count = new DataView(b.buffer).getUint32(128);
    for (let i = 0; i < count; i++) {
      const e = 132 + i * 12;
      if (String.fromCharCode(...b.subarray(e, e + 4)) === 'cprt') b.set([0x41, 0x32, 0x42, 0x30], e);
    }
    expect(parseIcc(b).kind).toBe('lut');
  });
  it('sRGB-like matrix/TRC is detected', () => {
    const b = new Uint8Array(fixture('display-p3.icc'));
    const dv = new DataView(b.buffer);
    const count = dv.getUint32(128);
    const write = (sig: string, xyz: [number, number, number]) => {
      for (let i = 0; i < count; i++) {
        const e = 132 + i * 12;
        if (String.fromCharCode(...b.subarray(e, e + 4)) === sig) {
          const off = dv.getUint32(e + 4);
          xyz.forEach((v, k) => dv.setInt32(off + 8 + k * 4, Math.round(v * 65536)));
        }
      }
    };
    write('rXYZ', [0.4361, 0.2225, 0.0139]);
    write('gXYZ', [0.3851, 0.7169, 0.0971]);
    write('bXYZ', [0.1431, 0.0606, 0.7141]);
    expect(parseIcc(b).isSrgb).toBe(true);
  });
  it('rejects non-ICC bytes', () => {
    expect(() => parseIcc(new Uint8Array(200))).toThrow(/ICC/);
  });
});

describe('evalCurve', () => {
  it('parametric sRGB curve matches the closed form', () => {
    const c = p3.trc![0];
    const srgb = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    for (const x of [0, 0.01, 0.04045, 0.2, 0.5, 1]) expect(evalCurve(c, x)).toBeCloseTo(srgb(x), 5);
  });
  it('gamma and table curves', () => {
    expect(evalCurve({ kind: 'gamma', g: 2.2 }, 0.5)).toBeCloseTo(Math.pow(0.5, 2.2), 6);
    expect(evalCurve({ kind: 'table', table: new Float64Array([0, 0.25, 1]) }, 0.25)).toBeCloseTo(0.125, 6);
    expect(evalCurve({ kind: 'identity' }, 0.3)).toBe(0.3);
  });
});

describe('convertToSrgb (Display P3 -> sRGB)', () => {
  // Independent reference: published linear P3 -> linear sRGB matrix (D65), then sRGB encoding.
  const P3_TO_SRGB = [1.2249401, -0.2249404, 0, -0.0420569, 1.0420571, 0, -0.0196376, -0.0786361, 1.0982735];
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const enc = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255));
  const reference = ([r, g, b]: number[]) => {
    const l = [lin(r! / 255), lin(g! / 255), lin(b! / 255)];
    return [0, 1, 2].map((row) => enc(P3_TO_SRGB[row * 3]! * l[0]! + P3_TO_SRGB[row * 3 + 1]! * l[1]! + P3_TO_SRGB[row * 3 + 2]! * l[2]!));
  };

  it('matches the published matrix within 2/255 on every fixture patch, alpha untouched', () => {
    const px = pixelsFrom(P.P3_PATCHES.flatMap((p) => [...p, 200]), P.P3_PATCHES.length, 1);
    const out = convertToSrgb(px, p3);
    P.P3_PATCHES.forEach((patch, i) => {
      const got = Array.from(out.data.slice(i * 4, i * 4 + 4));
      const want = reference(patch);
      for (let c = 0; c < 3; c++) expect(Math.abs(got[c]! - want[c]!), `patch ${i} ch ${c}: got ${got} want ${want}`).toBeLessThanOrEqual(2);
      expect(got[3]).toBe(200);
    });
  });
  it('neutral greys stay neutral and white stays white', () => {
    const out = convertToSrgb(pixelsFrom([128, 128, 128, 255, 255, 255, 255, 255, 0, 0, 0, 255], 3, 1), p3);
    expect(Array.from(out.data)).toEqual([128, 128, 128, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  });
  it('works at 16-bit', () => {
    const out = convertToSrgb(pixelsFrom([32768, 32768, 32768, 65535], 1, 1, 16), p3);
    expect(out.bitDepth).toBe(16);
    expect(Math.abs(out.data[0]! - 32768)).toBeLessThanOrEqual(1);
  });
  it('refuses LUT profiles', () => {
    const lut = parseIcc(extractMetadata(fixture('icc-lut.jpg'), 'jpeg').icc!);
    expect(() => convertToSrgb(pixelsFrom([1, 2, 3, 255], 1, 1), lut)).toThrow(/lut/);
  });
});
