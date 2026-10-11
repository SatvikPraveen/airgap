/**
 * Builds ICC v4 RGB input profiles for tests, written from the ICC.1:2022
 * specification independently of src/metadata/icc.ts. Big-endian throughout.
 */
type Bytes = number[];

const u8 = (v: number): Bytes => [v & 255];
const u16 = (v: number): Bytes => [(v >>> 8) & 255, v & 255];
const u32 = (v: number): Bytes => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const s15 = (v: number): Bytes => u32(Math.round(v * 65536) | 0);
const ascii = (s: string): Bytes => [...s].map((c) => c.charCodeAt(0));
/** Appends without spreading (CLUTs have ~100k entries; spread arguments overflow the stack). */
function append(to: Bytes, from: Bytes): Bytes {
  for (let i = 0; i < from.length; i++) to.push(from[i]!);
  return to;
}
const cat = (...parts: Bytes[]): Bytes => parts.reduce((acc, p) => append(acc, p), [] as Bytes);
const pad4 = (b: Bytes): Bytes => {
  while (b.length % 4) b.push(0);
  return b;
};
const q16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
const q8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

export type Fn3 = (r: number, g: number, b: number) => [number, number, number];

/** sRGB-like parametric curve (type 3): device -> linear. */
export const SRGB_PARA = { g: 2.4, a: 1 / 1.055, b: 0.055 / 1.055, c: 1 / 12.92, d: 0.04045 };
export function srgbToLinear(x: number): number {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** Display P3 colorants (D50-adapted, Bradford): linear P3 -> XYZ D50. */
export const P3_TO_XYZ_D50 = [0.515102, 0.291965, 0.157153, 0.241182, 0.692236, 0.0665819, -0.00104941, 0.0418818, 0.784378];
export function p3ToXyz(r: number, g: number, b: number): [number, number, number] {
  const m = P3_TO_XYZ_D50;
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  return [m[0]! * R + m[1]! * G + m[2]! * B, m[3]! * R + m[4]! * G + m[5]! * B, m[6]! * R + m[7]! * G + m[8]! * B];
}
const D50 = [0.9642, 1, 0.8249];
export function xyzToLab([X, Y, Z]: [number, number, number]): [number, number, number] {
  const f = (t: number) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  const fx = f(X / D50[0]!), fy = f(Y / D50[1]!), fz = f(Z / D50[2]!);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** PCS encodings to normalised [0,1]. */
export const enc = {
  xyz: ([X, Y, Z]: [number, number, number]): [number, number, number] => [X / (65535 / 32768), Y / (65535 / 32768), Z / (65535 / 32768)],
  labV4: ([L, a, b]: [number, number, number]): [number, number, number] => [L / 100, (a + 128) / 255, (b + 128) / 255],
  labLegacy16: ([L, a, b]: [number, number, number]): [number, number, number] => [(L * 65280) / 100 / 65535, ((a + 128) * 256) / 65535, ((b + 128) * 256) / 65535],
};

function tag(type: string, body: Bytes): Bytes {
  return cat(ascii(type), [0, 0, 0, 0], body);
}
function xyzTag(x: number, y: number, z: number): Bytes {
  return tag('XYZ ', [...s15(x), ...s15(y), ...s15(z)]);
}
function mluc(text: string): Bytes {
  const utf16 = [...text].flatMap((c) => u16(c.charCodeAt(0)));
  return tag('mluc', [...u32(1), ...u32(12), ...ascii('en'), ...ascii('US'), ...u32(utf16.length), ...u32(28), ...utf16]);
}
function curvTable(fn: (x: number) => number, n: number): Bytes {
  const out: Bytes = [];
  for (let i = 0; i < n; i++) append(out, u16(q16(fn(i / (n - 1)))));
  return tag('curv', cat(u32(n), out));
}
function curvIdentity(): Bytes {
  return tag('curv', u32(0));
}
function paraSrgb(): Bytes {
  const p = SRGB_PARA;
  return tag('para', [...u16(3), 0, 0, ...s15(p.g), ...s15(p.a), ...s15(p.b), ...s15(p.c), ...s15(p.d)]);
}

/** CLUT samples, first input slowest, of `fn` mapped through `pcs` to [0,1]. */
function clutSamples(grid: number, fn: Fn3): number[] {
  const out: number[] = [];
  for (let i = 0; i < grid; i++) for (let j = 0; j < grid; j++) for (let k = 0; k < grid; k++) append(out, fn(i / (grid - 1), j / (grid - 1), k / (grid - 1)));
  return out;
}

/** lut16Type: input tables, CLUT, output tables. `deviceToPcs` must already include any input linearisation the tables do not. */
export function mft2(opts: { grid: number; inTable: (x: number) => number; clut: Fn3; tableSize?: number }): Bytes {
  const n = opts.tableSize ?? 256;
  const body: Bytes = [...u8(3), ...u8(3), ...u8(opts.grid), 0];
  for (const v of [1, 0, 0, 0, 1, 0, 0, 0, 1]) body.push(...s15(v));
  body.push(...u16(n), ...u16(2));
  for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) append(body, u16(q16(opts.inTable(i / (n - 1)))));
  for (const v of clutSamples(opts.grid, opts.clut)) append(body, u16(q16(v)));
  for (let c = 0; c < 3; c++) append(body, cat(u16(0), u16(65535)));
  return tag('mft2', body);
}

/** lut8Type. */
export function mft1(opts: { grid: number; inTable: (x: number) => number; clut: Fn3 }): Bytes {
  const body: Bytes = [...u8(3), ...u8(3), ...u8(opts.grid), 0];
  for (const v of [1, 0, 0, 0, 1, 0, 0, 0, 1]) body.push(...s15(v));
  for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) body.push(...u8(q8(opts.inTable(i / 255))));
  for (const v of clutSamples(opts.grid, opts.clut)) body.push(q8(v));
  for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) body.push(i);
  return tag('mft1', body);
}

/** lutAtoBType: A curves (sRGB para) -> CLUT (16-bit) -> M curves (tables) -> matrix + offset -> B curves (identity). */
export function mAB(opts: { grid: [number, number, number]; clut: Fn3; mCurve: (x: number) => number; matrix: number[]; offset: [number, number, number]; aCurves?: 'srgb' | 'identity' }): Bytes {
  const header = 32;
  const b = pad4([...curvIdentity(), ...curvIdentity(), ...curvIdentity()]);
  const mat: Bytes = [];
  for (const v of opts.matrix) mat.push(...s15(v));
  for (const v of opts.offset) mat.push(...s15(v));
  const m = pad4([curvTable(opts.mCurve, 1024), curvTable(opts.mCurve, 1024), curvTable(opts.mCurve, 1024)].flatMap(pad4));
  const clutData: Bytes = [];
  const [g0, g1, g2] = opts.grid;
  for (let i = 0; i < g0; i++) for (let j = 0; j < g1; j++) for (let k = 0; k < g2; k++) for (const v of opts.clut(i / (g0 - 1), j / (g1 - 1), k / (g2 - 1))) append(clutData, u16(q16(v)));
  const clut = pad4(cat([g0, g1, g2], new Array(13).fill(0), [2, 0, 0, 0], clutData));
  const aOne = opts.aCurves === 'identity' ? curvIdentity() : paraSrgb();
  const a = pad4([aOne, aOne, aOne].flatMap(pad4));
  const offB = header;
  const offMatrix = offB + b.length;
  const offM = offMatrix + mat.length;
  const offClut = offM + m.length;
  const offA = offClut + clut.length;
  return cat(ascii('mAB '), [0, 0, 0, 0, 3, 3, 0, 0], u32(offB), u32(offMatrix), u32(offM), u32(offClut), u32(offA), b, mat, m, clut, a);
}

/** Assembles a v4.3 'scnr' RGB profile with the given PCS and A2B tags. */
export function buildProfile(pcs: 'XYZ ' | 'Lab ', tags: Record<string, Bytes>, description = 'Airgap test LUT'): Uint8Array {
  const all: [string, Bytes][] = [['desc', mluc(description)], ['wtpt', xyzTag(0.9642, 1, 0.8249)], ['cprt', mluc('none')], ...Object.entries(tags)];
  const tableLen = 4 + all.length * 12;
  let off = 128 + tableLen;
  const table: Bytes = u32(all.length);
  const data: Bytes = [];
  for (const [sig, body] of all) {
    const padded = pad4(body);
    append(table, cat(ascii(sig), u32(off), u32(body.length)));
    append(data, padded);
    off += padded.length;
  }
  const header: Bytes = new Array(128).fill(0);
  const put = (at: number, b: Bytes) => b.forEach((v, i) => (header[at + i] = v));
  put(0, u32(128 + tableLen + data.length));
  put(8, [4, 0x30, 0, 0]);
  put(12, ascii('scnr'));
  put(16, ascii('RGB '));
  put(20, ascii(pcs));
  put(36, ascii('acsp'));
  put(68, [...s15(0.9642), ...s15(1), ...s15(0.8249)]);
  return new Uint8Array(cat(header, table, data));
}
