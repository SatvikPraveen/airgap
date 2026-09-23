/**
 * ICC profile inspection and a matrix/TRC to sRGB transform. Pure.
 *
 * Only matrix/TRC RGB profiles (sRGB, Display P3, Adobe RGB, ProPhoto, ...)
 * are transformed. Anything with LUT-based A2B tags is reported as 'lut' and
 * the caller must refuse to convert rather than approximate.
 */
import type { IccKind, PixelData } from '../codecs/types';
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
  /** True when colorants and curves match sRGB closely: conversion would be a no-op. */
  isSrgb: boolean;
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
  };

  const hasLut = ['A2B0', 'A2B1', 'A2B2', 'B2A0'].some((t) => table.has(t));
  const matrixTags = ['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'];
  const hasMatrix = matrixTags.every((t) => table.has(t));

  if (colorSpace === 'GRAY') {
    profile.kind = 'gray';
  } else if (hasLut) {
    // A LUT-based path takes precedence per ICC; we never approximate it with the matrix.
    profile.kind = 'lut';
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
  }
  return profile;
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
 * Converts pixels tagged with a matrix/TRC profile to sRGB at the same bit
 * depth. Alpha is copied. Out-of-gamut values are clipped. Throws for any
 * other profile kind: the UI must have disabled the option.
 */
export function convertToSrgb(px: PixelData, profile: IccProfile): PixelData {
  if (profile.kind !== 'matrix' || !profile.matrix || !profile.trc) {
    throw new Error(`Cannot convert a '${profile.kind}' ICC profile with the matrix path.`);
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
