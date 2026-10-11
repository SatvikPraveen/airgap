/**
 * LUT-based ICC profiles: Airgap's evaluation (src/metadata/icc.ts) against
 * LittleCMS 2 (lcms-wasm, a dev dependency only; it never ships), the
 * reference colour-management engine, on profiles built independently from
 * the ICC specification (tests/unit/icc-builder.ts). Relative colorimetric
 * intent, no optimisation, double precision, sRGB output, 8-bit compared.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { convertToSrgb, parseIcc } from '../../src/metadata/icc';
import { allocate } from '../../src/pixels';
import { buildProfile, enc, mAB, mft1, mft2, p3ToXyz, srgbToLinear, xyzToLab } from './icc-builder';
import { fixture } from './helpers';

type Lcms = Record<string, (...a: never[]) => unknown> & Record<string, unknown>;
let lcms: Lcms;
let K: Record<string, number>;
let srgb: number;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const main = require.resolve('lcms-wasm');
  const wasm = readFileSync(main.replace(/lcms\.js$/, 'lcms.wasm'));
  const mod = (await import('lcms-wasm')) as unknown as { instantiate(o: object): Promise<Lcms> } & Record<string, number>;
  lcms = await mod.instantiate({ wasmBinary: wasm });
  K = mod; // format and flag constants are module exports
  srgb = (lcms['cmsCreate_sRGBProfile'] as () => number)();
});

/** Every RGB triple on a 9-step grid plus a few hundred pseudo-random ones, 8-bit. */
function samples(): number[] {
  const out: number[] = [];
  for (let r = 0; r <= 8; r++) for (let g = 0; g <= 8; g++) for (let b = 0; b <= 8; b++) out.push(Math.min(255, r * 32), Math.min(255, g * 32), Math.min(255, b * 32));
  let s = 7;
  for (let i = 0; i < 600; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out.push(s >>> 24);
  }
  return out;
}

function viaLcms(profile: Uint8Array, rgb: number[]): number[] {
  const open = lcms['cmsOpenProfileFromMem'] as (b: Uint8Array, n: number) => number;
  const h = open(profile, profile.length);
  expect(h, 'LittleCMS opens the profile').toBeTruthy();
  // 16-bit buffers: the wrapper mishandles double buffers, and 16 bits is ample for an 8-bit comparison.
  const TYPE_RGB_16 = K['TYPE_RGB_16']!;
  const t = (lcms['cmsCreateTransform'] as (...a: number[]) => number)(h, TYPE_RGB_16, srgb, TYPE_RGB_16, K['INTENT_RELATIVE_COLORIMETRIC']!, K['cmsFLAGS_NOOPTIMIZE']! | K['cmsFLAGS_NOCACHE']!);
  expect(t, 'LittleCMS builds the transform').toBeTruthy();
  const input = new Uint16Array(rgb.map((v) => v * 257));
  const out = (lcms['cmsDoTransform'] as (t: number, i: Uint16Array, n: number) => Uint16Array)(t, input, rgb.length / 3);
  (lcms['cmsDeleteTransform'] as (t: number) => void)(t);
  (lcms['cmsCloseProfile'] as (h: number) => void)(h);
  return Array.from(out, (v) => Math.round((v / 65535) * 255));
}

function viaAirgap(profile: Uint8Array, rgb: number[]): number[] {
  const n = rgb.length / 3;
  const px = allocate(n, 1, 8);
  for (let i = 0; i < n; i++) px.data.set([rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!, 255], i * 4);
  const p = parseIcc(profile);
  expect(p.convertible, p.lutUnsupported).toBe(true);
  const out = convertToSrgb(px, p).data;
  const res: number[] = [];
  for (let i = 0; i < n; i++) res.push(out[i * 4]!, out[i * 4 + 1]!, out[i * 4 + 2]!);
  return res;
}

function compare(profile: Uint8Array): { max: number; over1: number; exact: number; total: number } {
  const rgb = samples();
  const a = viaAirgap(profile, rgb);
  const b = viaLcms(profile, rgb);
  let max = 0;
  let over1 = 0;
  let exact = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    max = Math.max(max, d);
    if (d > 1) over1++;
    if (d === 0) exact++;
  }
  if (process.env['ICC_REPORT']) console.info(`[icc-vs-lcms] max ${max}, exact ${exact}/${a.length}`);
  return { max, over1, exact, total: a.length };
}

const lab = (r: number, g: number, b: number) => xyzToLab(p3ToXyz(r, g, b));

/** Measured: 98.8-99.1% of samples identical, the rest one level apart (LittleCMS rounds its 16-bit output). */
function expectAgreement(r: { max: number; exact: number; total: number }): void {
  expect(r.max).toBeLessThanOrEqual(1);
  expect(r.exact / r.total).toBeGreaterThanOrEqual(0.98);
}

describe('LUT profiles against LittleCMS (8-bit sRGB output)', () => {
  it('lut16 (mft2), XYZ PCS, 2-point CLUT of a linear map after linearising tables', () => {
    // The CLUT receives linear values, so the device->XYZ map it holds is the linear P3 matrix.
    const m = [0.515102, 0.291965, 0.157153, 0.241182, 0.692236, 0.0665819, -0.00104941, 0.0418818, 0.784378];
    const linear = (r: number, g: number, b: number): [number, number, number] => [m[0]! * r + m[1]! * g + m[2]! * b, m[3]! * r + m[4]! * g + m[5]! * b, m[6]! * r + m[7]! * g + m[8]! * b];
    const profile = buildProfile('XYZ ', { A2B0: mft2({ grid: 2, inTable: srgbToLinear, tableSize: 4096, clut: (r, g, b) => enc.xyz(linear(r, g, b)) }) });
    expectAgreement(compare(profile));
  });
  it('lut16 (mft2), Lab PCS (legacy 16-bit encoding), 17-point CLUT', () => {
    const profile = buildProfile('Lab ', { A2B0: mft2({ grid: 17, inTable: (x) => x, clut: (r, g, b) => enc.labLegacy16(lab(r, g, b)) }) });
    expectAgreement(compare(profile));
  });
  it('lut8 (mft1), Lab PCS (v4 8-bit encoding), 17-point CLUT', () => {
    const profile = buildProfile('Lab ', { A2B0: mft1({ grid: 17, inTable: (x) => x, clut: (r, g, b) => enc.labV4(lab(r, g, b)) }) });
    expectAgreement(compare(profile));
  });
  it('lutAtoB (mAB), Lab PCS, sRGB parametric A curves, uneven 9x7x5 CLUT, M curves, matrix with offset', () => {
    // CLUT holds Lab of P3 at *linear* inputs (A curves linearise); M curves are a gamma; the matrix
    // and its offset are applied after, so the profile's meaning is defined by the pipeline itself.
    const profile = buildProfile('Lab ', {
      A2B0: mAB({
        grid: [9, 7, 5],
        aCurves: 'srgb',
        clut: (r, g, b) => enc.labV4(lab(r ** (1 / 2.2), g ** (1 / 2.2), b ** (1 / 2.2))),
        mCurve: (x) => x ** 1.1,
        matrix: [0.95, 0.03, 0.02, 0.01, 0.97, 0.02, 0.0, 0.04, 0.96],
        offset: [0.01, -0.005, 0.0],
      }),
    });
    expectAgreement(compare(profile));
  });
  it('A2B1 (relative colorimetric) is used over A2B0 when both exist, as LittleCMS does for this intent', () => {
    const a2b0 = mft2({ grid: 2, inTable: (x) => x, clut: () => enc.xyz([0.2, 0.2, 0.2]) });
    const a2b1 = mft2({ grid: 17, inTable: (x) => x, clut: (r, g, b) => enc.xyz(p3ToXyz(r, g, b)) });
    const profile = buildProfile('XYZ ', { A2B0: a2b0, A2B1: a2b1 });
    expect(parseIcc(profile).lut?.tag).toBe('A2B1');
    expectAgreement(compare(profile));
  });
  it('the matrix/TRC path agrees with LittleCMS too (Display P3 fixture profile)', () => {
    expectAgreement(compare(fixture('display-p3.icc')));
  });
  it('a LUT profile encoding the same P3 transform as the matrix profile gives the same pixels', () => {
    const lutProfile = buildProfile('Lab ', { A2B0: mft2({ grid: 33, inTable: (x) => x, clut: (r, g, b) => enc.labLegacy16(lab(r, g, b)) }) });
    const rgb = samples();
    const a = viaAirgap(lutProfile, rgb);
    const b = viaAirgap(fixture('display-p3.icc'), rgb);
    let max = 0;
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
    expect(max).toBeLessThanOrEqual(1);
  });
});
