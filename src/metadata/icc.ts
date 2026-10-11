/**
 * ICC profile inspection and transforms to sRGB. Pure.
 *
 * Two paths, both exact evaluations of what the profile says (never an
 * approximation of one by the other):
 *  - matrix/TRC RGB profiles (sRGB, Display P3, Adobe RGB, ProPhoto, ...);
 *  - LUT-based RGB profiles: the A2B1 tag (relative colorimetric) or, absent
 *    that, A2B0, in any of the three LUT encodings (lut8 'mft1', lut16 'mft2',
 *    lutAtoB 'mAB '), with XYZ or Lab connection space. The CLUT is evaluated
 *    with tetrahedral interpolation, as LittleCMS does.
 * Anything else (CMYK, n-channel, BtoA-only, unknown tag types) is reported as
 * not convertible and the caller refuses. tests/unit/icc-lut.test.ts checks
 * both paths against LittleCMS.
 */
import type { IccKind, ImageMetadata, PixelData } from '../codecs/types';
import { allocate, maxValue } from '../pixels';

export type Curve =
  | { kind: 'identity' }
  | { kind: 'gamma'; g: number }
  | { kind: 'table'; table: Float64Array }
  | { kind: 'para'; fn: number; p: number[] };

export interface IccProfile {
  size: number;
  version: number;
  deviceClass: string;
  colorSpace: string;
  pcs: string;
  description: string;
  kind: IccKind;
  tags: string[];
  /** Colorant columns (D50-relative XYZ), only for kind 'matrix'. */
  matrix?: [number, number, number, number, number, number, number, number, number];
  trc?: [Curve, Curve, Curve];
  /** The evaluable A2B pipeline, only for kind 'lut' when every element is supported. */
  lut?: LutPipeline;
  /** Why a 'lut' profile cannot be evaluated, when it cannot. */
  lutUnsupported?: string;
  /** convertToSrgb() can evaluate this profile exactly. */
  convertible: boolean;
  /** True when colorants and curves match sRGB closely: conversion would be a no-op. */
  isSrgb: boolean;
}

/** One processing element of an A2B pipeline, on normalised [0,1] triples. */
export type LutStage =
  | { kind: 'curves'; curves: [Curve, Curve, Curve] }
  | { kind: 'matrix'; m: number[]; offset: [number, number, number] }
  | { kind: 'clut'; grid: [number, number, number]; data: Float64Array };

export interface LutPipeline {
  /** The tag evaluated: 'A2B1' (relative colorimetric) when present, else 'A2B0'. */
  tag: string;
  type: 'mft1' | 'mft2' | 'mAB ';
  stages: LutStage[];
  pcs: 'XYZ ' | 'Lab ';
  /** lut16Type always stores Lab in the legacy (v2) 16-bit encoding; everything else in v4's. */
  labEncoding: 'v4' | 'legacy16';
}

export class IccParseError extends Error {
  override name = 'IccParseError';
}

const td = new TextDecoder('utf-8');

function sig(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function u16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function s15f16(b: Uint8Array, o: number): number {
  return (u32(b, o) | 0) / 65536;
}

export function parseIcc(bytes: Uint8Array): IccProfile {
  if (bytes.length < 132) throw new IccParseError('ICC profile too short');
  if (sig(bytes, 36) !== 'acsp') throw new IccParseError("Not an ICC profile (missing 'acsp')");
  const size = u32(bytes, 0);
  const version = bytes[8]!;
  const deviceClass = sig(bytes, 12);
  const colorSpace = sig(bytes, 16);
  const pcs = sig(bytes, 20);
  const count = u32(bytes, 128);
  const table = new Map<string, { offset: number; size: number }>();
  for (let i = 0; i < count; i++) {
    const e = 132 + i * 12;
    if (e + 12 > bytes.length) break;
    const offset = u32(bytes, e + 4);
    const tsize = u32(bytes, e + 8);
    if (offset + tsize <= bytes.length) table.set(sig(bytes, e), { offset, size: tsize });
  }
  const tags = [...table.keys()];

  const profile: IccProfile = {
    size,
    version,
    deviceClass,
    colorSpace,
    pcs,
    description: readDescription(bytes, table.get('desc')),
    kind: 'unknown',
    tags,
    isSrgb: false,
    convertible: false,
  };

  const hasLut = ['A2B0', 'A2B1', 'A2B2', 'B2A0'].some((t) => table.has(t));
  const matrixTags = ['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'];
  const hasMatrix = matrixTags.every((t) => table.has(t));

  if (colorSpace === 'GRAY') {
    profile.kind = 'gray';
  } else if (hasLut) {
    // A LUT-based path takes precedence per ICC; we never approximate it with the matrix.
    profile.kind = 'lut';
    const tag = table.has('A2B1') ? 'A2B1' : table.has('A2B0') ? 'A2B0' : undefined;
    if (colorSpace !== 'RGB ') profile.lutUnsupported = `colour space '${colorSpace.trim()}' (only RGB input is evaluated)`;
    else if (pcs !== 'XYZ ' && pcs !== 'Lab ') profile.lutUnsupported = `connection space '${pcs.trim()}'`;
    else if (!tag) profile.lutUnsupported = 'no A2B0/A2B1 tag (BtoA only)';
    else {
      try {
        profile.lut = readLut(bytes, table.get(tag)!, tag, pcs);
        profile.convertible = true;
      } catch (err) {
        profile.lutUnsupported = (err as Error).message;
      }
    }
  } else if (colorSpace === 'RGB ' && hasMatrix) {
    profile.kind = 'matrix';
    const xyz = (t: string) => {
      const e = table.get(t)!;
      if (sig(bytes, e.offset) !== 'XYZ ') throw new IccParseError(`${t} is not an XYZ tag`);
      return [s15f16(bytes, e.offset + 8), s15f16(bytes, e.offset + 12), s15f16(bytes, e.offset + 16)];
    };
    const r = xyz('rXYZ');
    const g = xyz('gXYZ');
    const b = xyz('bXYZ');
    profile.matrix = [r[0]!, g[0]!, b[0]!, r[1]!, g[1]!, b[1]!, r[2]!, g[2]!, b[2]!];
    profile.trc = [readCurve(bytes, table.get('rTRC')!), readCurve(bytes, table.get('gTRC')!), readCurve(bytes, table.get('bTRC')!)];
    profile.isSrgb = looksLikeSrgb(profile);
    profile.convertible = true;
  }
  return profile;
}

/** The metadata facts derived from an ICC payload, shared by every decoder. */
export function iccFacts(icc: Uint8Array): Pick<ImageMetadata, 'iccKind' | 'iccDescription' | 'iccConvertible'> {
  try {
    const p = parseIcc(icc);
    return { iccKind: p.kind, iccDescription: p.description, iccConvertible: p.convertible };
  } catch {
    return { iccKind: 'unknown', iccConvertible: false };
  }
}

// ---------------------------------------------------------------- LUT tags

function readLut(b: Uint8Array, e: { offset: number; size: number }, tag: string, pcs: string): LutPipeline {
  const o = e.offset;
  const type = sig(b, o);
  const inCh = b[o + 8]!;
  const outCh = b[o + 9]!;
  if (inCh !== 3 || outCh !== 3) throw new IccParseError(`${tag} has ${inCh} inputs and ${outCh} outputs (3 and 3 are evaluated)`);
  const end = o + e.size;
  const need = (n: number) => {
    if (n > end) throw new IccParseError(`${tag} is truncated`);
  };
  const base = { tag, pcs: pcs as 'XYZ ' | 'Lab ' };
  if (type === 'mft1' || type === 'mft2') {
    const wide = type === 'mft2';
    const grid = b[o + 10]!;
    if (grid < 2) throw new IccParseError(`${tag} CLUT has ${grid} grid points`);
    // The 3x3 matrix at o+12 applies only when the input space is XYZ; for RGB it is ignored.
    let p = o + 48;
    const inN = wide ? u16(b, p) : 256;
    const outN = wide ? u16(b, p + 2) : 256;
    if (wide) p += 4;
    if (inN < 2 || outN < 2) throw new IccParseError(`${tag} has a table with fewer than 2 entries`);
    const sample = wide ? (q: number) => u16(b, q) / 65535 : (q: number) => b[q]! / 255;
    const step = wide ? 2 : 1;
    const table = (n: number): Curve => {
      need(p + n * step);
      const t = new Float64Array(n);
      for (let i = 0; i < n; i++) t[i] = sample(p + i * step);
      p += n * step;
      return { kind: 'table', table: t };
    };
    const input = [table(inN), table(inN), table(inN)] as [Curve, Curve, Curve];
    const count = grid * grid * grid * 3;
    need(p + count * step);
    const data = new Float64Array(count);
    for (let i = 0; i < count; i++) data[i] = sample(p + i * step);
    p += count * step;
    const output = [table(outN), table(outN), table(outN)] as [Curve, Curve, Curve];
    return {
      ...base,
      type,
      stages: [
        { kind: 'curves', curves: input },
        { kind: 'clut', grid: [grid, grid, grid], data },
        { kind: 'curves', curves: output },
      ],
      labEncoding: wide ? 'legacy16' : 'v4',
    };
  }
  if (type === 'mAB ') {
    const offB = u32(b, o + 12);
    const offMatrix = u32(b, o + 16);
    const offM = u32(b, o + 20);
    const offClut = u32(b, o + 24);
    const offA = u32(b, o + 28);
    if (!offB) throw new IccParseError(`${tag} (lutAtoB) has no B curves`);
    const curves = (at: number): [Curve, Curve, Curve] => {
      let q = o + at;
      const out: Curve[] = [];
      for (let i = 0; i < 3; i++) {
        need(q + 12);
        const c = readCurve(b, { offset: q, size: end - q });
        out.push(c);
        const t = sig(b, q);
        const len = t === 'curv' ? 12 + 2 * u32(b, q + 8) : 12 + 4 * [1, 3, 4, 5, 7][u16(b, q + 8)]!;
        q += (len + 3) & ~3; // elements are 4-byte aligned
      }
      return out as [Curve, Curve, Curve];
    };
    const stages: LutStage[] = [];
    if (offA) stages.push({ kind: 'curves', curves: curves(offA) });
    if (offClut) {
      const q = o + offClut;
      need(q + 20);
      const grid: [number, number, number] = [b[q]!, b[q + 1]!, b[q + 2]!];
      if (grid.some((g) => g < 2)) throw new IccParseError(`${tag} CLUT has a dimension with fewer than 2 grid points`);
      const precision = b[q + 16]!;
      if (precision !== 1 && precision !== 2) throw new IccParseError(`${tag} CLUT precision ${precision}`);
      const count = grid[0] * grid[1] * grid[2] * 3;
      need(q + 20 + count * precision);
      const data = new Float64Array(count);
      for (let i = 0; i < count; i++) data[i] = precision === 2 ? u16(b, q + 20 + i * 2) / 65535 : b[q + 20 + i]! / 255;
      stages.push({ kind: 'clut', grid, data });
    } else if (offA) {
      // Without a CLUT the A curves feed the M curves directly (allowed when in == out).
    }
    if (offM) stages.push({ kind: 'curves', curves: curves(offM) });
    if (offMatrix) {
      const q = o + offMatrix;
      need(q + 48);
      const m: number[] = [];
      for (let i = 0; i < 9; i++) m.push(s15f16(b, q + i * 4));
      stages.push({ kind: 'matrix', m, offset: [s15f16(b, q + 36), s15f16(b, q + 40), s15f16(b, q + 44)] });
    }
    stages.push({ kind: 'curves', curves: curves(offB) });
    return { ...base, type, stages, labEncoding: 'v4' };
  }
  throw new IccParseError(`${tag} has unsupported type '${type}'`);
}

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/**
 * Tetrahedral interpolation in a 3-input, 3-output CLUT. The first input varies
 * slowest (ICC order). The cube cell is split along its main diagonal into six
 * tetrahedra; the one containing the point is the order of its fractions.
 */
export function tetrahedral(grid: [number, number, number], data: Float64Array, x: number, y: number, z: number, out: Float64Array): void {
  const [g0, g1, g2] = grid;
  const px = clamp01(x) * (g0 - 1);
  const py = clamp01(y) * (g1 - 1);
  const pz = clamp01(z) * (g2 - 1);
  const x0 = Math.min(Math.floor(px), g0 - 2);
  const y0 = Math.min(Math.floor(py), g1 - 2);
  const z0 = Math.min(Math.floor(pz), g2 - 2);
  const fx = px - x0;
  const fy = py - y0;
  const fz = pz - z0;
  const sx = g1 * g2 * 3;
  const sy = g2 * 3;
  const sz = 3;
  const c000 = (x0 * g1 + y0) * sy + z0 * sz;
  // Walk 000 -> (largest fraction's axis) -> (+ second) -> 111.
  let a: number, b2: number, fa: number, fb: number, fc: number;
  if (fx >= fy) {
    if (fy >= fz) (a = sx), (b2 = sx + sy), (fa = fx), (fb = fy), (fc = fz);
    else if (fx >= fz) (a = sx), (b2 = sx + sz), (fa = fx), (fb = fz), (fc = fy);
    else (a = sz), (b2 = sz + sx), (fa = fz), (fb = fx), (fc = fy);
  } else {
    if (fx >= fz) (a = sy), (b2 = sy + sx), (fa = fy), (fb = fx), (fc = fz);
    else if (fy >= fz) (a = sy), (b2 = sy + sz), (fa = fy), (fb = fz), (fc = fx);
    else (a = sz), (b2 = sz + sy), (fa = fz), (fb = fy), (fc = fx);
  }
  const c111 = sx + sy + sz;
  for (let k = 0; k < 3; k++) {
    const v0 = data[c000 + k]!;
    const va = data[c000 + a + k]!;
    const vb = data[c000 + b2 + k]!;
    const v1 = data[c000 + c111 + k]!;
    out[k] = v0 + fa * (va - v0) + fb * (vb - va) + fc * (v1 - vb);
  }
}

const D50 = [0.9642, 1.0, 0.8249];

/** Runs the pipeline on a normalised device triple and returns PCS XYZ (D50, Y of white = 1). */
export function evalLut(lut: LutPipeline, r: number, g: number, b: number, tmp = new Float64Array(3)): [number, number, number] {
  let v0 = r;
  let v1 = g;
  let v2 = b;
  for (const s of lut.stages) {
    if (s.kind === 'curves') {
      v0 = evalCurve(s.curves[0], clamp01(v0));
      v1 = evalCurve(s.curves[1], clamp01(v1));
      v2 = evalCurve(s.curves[2], clamp01(v2));
    } else if (s.kind === 'clut') {
      tetrahedral(s.grid, s.data, v0, v1, v2, tmp);
      v0 = tmp[0]!;
      v1 = tmp[1]!;
      v2 = tmp[2]!;
    } else {
      const m = s.m;
      const a = m[0]! * v0 + m[1]! * v1 + m[2]! * v2 + s.offset[0];
      const c = m[3]! * v0 + m[4]! * v1 + m[5]! * v2 + s.offset[1];
      const d = m[6]! * v0 + m[7]! * v1 + m[8]! * v2 + s.offset[2];
      v0 = a;
      v1 = c;
      v2 = d;
    }
  }
  if (lut.pcs === 'XYZ ') {
    const k = 65535 / 32768; // PCS XYZ encoding: 1.0 + 32767/32768 at full scale
    return [v0 * k, v1 * k, v2 * k];
  }
  // Lab (D50) to XYZ.
  let L: number, A: number, B: number;
  if (lut.labEncoding === 'legacy16') {
    L = (v0 * 65535 * 100) / 65280;
    A = (v1 * 65535) / 256 - 128;
    B = (v2 * 65535) / 256 - 128;
  } else {
    L = v0 * 100;
    A = v1 * 255 - 128;
    B = v2 * 255 - 128;
  }
  const fy = (L + 16) / 116;
  const fx = fy + A / 500;
  const fz = fy - B / 200;
  const inv = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
  return [D50[0]! * inv(fx), D50[1]! * inv(fy), D50[2]! * inv(fz)];
}

function readDescription(bytes: Uint8Array, e: { offset: number; size: number } | undefined): string {
  if (!e) return '';
  const type = sig(bytes, e.offset);
  if (type === 'desc') {
    const n = u32(bytes, e.offset + 8);
    const s = bytes.subarray(e.offset + 12, e.offset + 12 + Math.max(0, n - 1));
    return td.decode(s).replace(/\0+$/, '');
  }
  if (type === 'mluc') {
    const records = u32(bytes, e.offset + 8);
    if (records === 0) return '';
    const len = u32(bytes, e.offset + 16 + 4);
    const off = u32(bytes, e.offset + 16 + 8);
    const s = bytes.subarray(e.offset + off, e.offset + off + len);
    let out = '';
    for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode((s[i]! << 8) | s[i + 1]!);
    return out.replace(/\0+$/, '');
  }
  return '';
}

function readCurve(bytes: Uint8Array, e: { offset: number; size: number }): Curve {
  const type = sig(bytes, e.offset);
  if (type === 'curv') {
    const n = u32(bytes, e.offset + 8);
    if (n === 0) return { kind: 'identity' };
    if (n === 1) return { kind: 'gamma', g: u16(bytes, e.offset + 12) / 256 };
    const table = new Float64Array(n);
    for (let i = 0; i < n; i++) table[i] = u16(bytes, e.offset + 12 + i * 2) / 65535;
    return { kind: 'table', table };
  }
  if (type === 'para') {
    const fn = u16(bytes, e.offset + 8);
    const counts = [1, 3, 4, 5, 7];
    const n = counts[fn];
    if (n === undefined) throw new IccParseError(`Unknown parametric curve type ${fn}`);
    const p: number[] = [];
    for (let i = 0; i < n; i++) p.push(s15f16(bytes, e.offset + 12 + i * 4));
    return { kind: 'para', fn, p };
  }
  throw new IccParseError(`Unsupported TRC tag type '${type}'`);
}

/** Device value (0..1) -> linear light (0..1). */
export function evalCurve(c: Curve, x: number): number {
  switch (c.kind) {
    case 'identity':
      return x;
    case 'gamma':
      return Math.pow(x, c.g);
    case 'table': {
      const t = c.table;
      const pos = x * (t.length - 1);
      const i = Math.floor(pos);
      if (i >= t.length - 1) return t[t.length - 1]!;
      const f = pos - i;
      return t[i]! * (1 - f) + t[i + 1]! * f;
    }
    case 'para': {
      const [g, a = 1, b = 0, cc = 0, d = 0, e = 0, f = 0] = c.p as [number, number?, number?, number?, number?, number?, number?];
      switch (c.fn) {
        case 0:
          return Math.pow(x, g);
        case 1:
          return x >= -b / a ? Math.pow(a * x + b, g) : 0;
        case 2:
          return x >= -b / a ? Math.pow(a * x + b, g) + cc : cc;
        case 3:
          return x >= d ? Math.pow(a * x + b, g) : cc * x;
        default:
          return x >= d ? Math.pow(a * x + b, g) + e : cc * x + f;
      }
    }
  }
}

// sRGB colorants adapted to D50 (ICC v4 / Bradford), as found in standard sRGB profiles.
const SRGB_D50: [number, number, number, number, number, number, number, number, number] = [
  0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733,
];
// Inverse of the above: XYZ(D50) -> linear sRGB.
const XYZ_D50_TO_SRGB = [
  3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427,
];

function srgbEncode(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
function srgbDecode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function looksLikeSrgb(p: IccProfile): boolean {
  if (!p.matrix || !p.trc) return false;
  for (let i = 0; i < 9; i++) if (Math.abs(p.matrix[i]! - SRGB_D50[i]!) > 0.003) return false;
  for (const c of p.trc) {
    for (const x of [0.02, 0.1, 0.25, 0.5, 0.75, 0.9]) {
      if (Math.abs(evalCurve(c, x) - srgbDecode(x)) > 0.004) return false;
    }
  }
  return true;
}

/**
 * Converts pixels tagged with a matrix/TRC or an evaluable LUT profile to sRGB
 * at the same bit depth. Alpha is copied. Out-of-gamut values are clipped.
 * Throws for any other profile: the UI must have disabled the option.
 */
export function convertToSrgb(px: PixelData, profile: IccProfile): PixelData {
  if (profile.kind === 'lut' && profile.lut) return convertLutToSrgb(px, profile.lut);
  if (profile.kind !== 'matrix' || !profile.matrix || !profile.trc) {
    throw new Error(`Cannot convert a '${profile.kind}' ICC profile${profile.lutUnsupported ? ` (${profile.lutUnsupported})` : ''}.`);
  }
  const max = maxValue(px.bitDepth);
  const out = allocate(px.width, px.height, px.bitDepth);
  // Per-channel linearisation tables.
  const lin = profile.trc.map((c) => {
    const t = new Float64Array(max + 1);
    for (let v = 0; v <= max; v++) t[v] = evalCurve(c, v / max);
    return t;
  }) as [Float64Array, Float64Array, Float64Array];
  const M = profile.matrix;
  const N = XYZ_D50_TO_SRGB;
  // Combined matrix: linear device RGB -> XYZ(D50) -> linear sRGB.
  const C = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] = N[r * 3]! * M[c]! + N[r * 3 + 1]! * M[3 + c]! + N[r * 3 + 2]! * M[6 + c]!;
    }
  }
  // Output encoding cache keyed by quantised linear value (65536 steps).
  const enc = new Float64Array(65537);
  for (let i = 0; i <= 65536; i++) enc[i] = srgbEncode(i / 65536);
  const encode = (v: number) => {
    if (v <= 0) return 0;
    if (v >= 1) return max;
    return Math.round(enc[Math.round(v * 65536)]! * max);
  };
  const src = px.data;
  const dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    const r = lin[0][src[i]!]!;
    const g = lin[1][src[i + 1]!]!;
    const b = lin[2][src[i + 2]!]!;
    dst[i] = encode(C[0]! * r + C[1]! * g + C[2]! * b);
    dst[i + 1] = encode(C[3]! * r + C[4]! * g + C[5]! * b);
    dst[i + 2] = encode(C[6]! * r + C[7]! * g + C[8]! * b);
    dst[i + 3] = src[i + 3]!;
  }
  return out;
}

function convertLutToSrgb(px: PixelData, lut: LutPipeline): PixelData {
  const max = maxValue(px.bitDepth);
  const out = allocate(px.width, px.height, px.bitDepth);
  const N = XYZ_D50_TO_SRGB;
  const encode = (v: number) => Math.round(srgbEncode(v) * max);
  const src = px.data;
  const dst = out.data;
  const tmp = new Float64Array(3);
  // 8-bit sources repeat colours a lot; memoise per packed RGB.
  const memo = px.bitDepth === 8 ? new Map<number, number>() : null;
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i]!;
    const g = src[i + 1]!;
    const b = src[i + 2]!;
    const key = memo ? (r << 16) | (g << 8) | b : 0;
    const hit = memo?.get(key);
    if (hit !== undefined) {
      dst[i] = hit >>> 16;
      dst[i + 1] = (hit >>> 8) & 255;
      dst[i + 2] = hit & 255;
    } else {
      const [X, Y, Z] = evalLut(lut, r / max, g / max, b / max, tmp);
      const R = encode(N[0]! * X + N[1]! * Y + N[2]! * Z);
      const G = encode(N[3]! * X + N[4]! * Y + N[5]! * Z);
      const B = encode(N[6]! * X + N[7]! * Y + N[8]! * Z);
      dst[i] = R;
      dst[i + 1] = G;
      dst[i + 2] = B;
      if (memo && memo.size < 1 << 20) memo.set(key, (R << 16) | (G << 8) | B);
    }
    dst[i + 3] = src[i + 3]!;
  }
  return out;
}

export function iccKindLabel(kind: IccKind): string {
  switch (kind) {
    case 'matrix':
      return 'matrix/TRC (RGB)';
    case 'lut':
      return 'LUT-based';
    case 'gray':
      return 'grayscale';
    default:
      return 'unrecognised';
  }
}
