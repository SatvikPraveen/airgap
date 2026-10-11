/**
 * Geometric edits applied before encoding: crop, the eight right-angle
 * orientations (rotate by 90° steps, mirror), and resampling. Pure; any bit
 * depth; no canvas (a canvas would premultiply alpha and clamp to 8 bits).
 *
 * Order, always: crop (in the upright source's coordinates, as the source
 * thumbnail shows it) -> rotate/mirror -> resize to the requested output size.
 *
 * Crop and rotate/mirror move or drop pixels but never change a value; resize
 * computes new values. capabilities.ts reports them accordingly (geometry vs
 * pixels severity), so "Lossless only" allows crop/rotate and excludes resize.
 */
import type { PixelData } from './codecs/types';
import { applyOrientation } from './orientation';
import { allocate, maxValue } from './pixels';

export type Rotation = 0 | 90 | 180 | 270;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TransformSpec {
  /** Clockwise, applied after the mirrors. */
  rotate: Rotation;
  /** Mirror left-right, applied before the rotation. */
  flipH: boolean;
  /** Mirror top-bottom, applied before the rotation. */
  flipV: boolean;
  crop?: CropRect;
  /** Final output size. Absent, or equal to the size after crop and rotation, means no resampling. */
  resize?: { width: number; height: number };
}

export const IDENTITY: TransformSpec = { rotate: 0, flipH: false, flipV: false };

/**
 * The single EXIF orientation value (1..8) equivalent to mirroring then rotating.
 * Mirroring both ways is a 180° rotation, and a vertical mirror is a horizontal one
 * plus 180°, so every combination reduces to (flipH?, rotation): the dihedral group D4.
 */
export function orientationFor(spec: Pick<TransformSpec, 'rotate' | 'flipH' | 'flipV'>): number {
  let rot = spec.rotate as number;
  let flip = spec.flipH;
  if (spec.flipV) {
    flip = !flip;
    rot = (rot + 180) % 360;
  }
  const table = flip ? { 0: 2, 90: 7, 180: 4, 270: 5 } : { 0: 1, 90: 6, 180: 3, 270: 8 };
  return table[rot as Rotation];
}

/** Size after crop and rotation, before any resize. */
export function orientedSize(width: number, height: number, spec: TransformSpec): { width: number; height: number } {
  const w = spec.crop ? spec.crop.width : width;
  const h = spec.crop ? spec.crop.height : height;
  return spec.rotate === 90 || spec.rotate === 270 ? { width: h, height: w } : { width: w, height: h };
}

/** Final output size. */
export function outputSize(width: number, height: number, spec: TransformSpec): { width: number; height: number } {
  return spec.resize ?? orientedSize(width, height, spec);
}

export function isCropping(width: number, height: number, spec: TransformSpec): boolean {
  const c = spec.crop;
  return !!c && (c.x !== 0 || c.y !== 0 || c.width !== width || c.height !== height);
}

export function isResampling(width: number, height: number, spec: TransformSpec): boolean {
  if (!spec.resize) return false;
  const o = orientedSize(width, height, spec);
  return spec.resize.width !== o.width || spec.resize.height !== o.height;
}

/** True when the transform changes nothing at all. */
export function isIdentity(width: number, height: number, spec: TransformSpec): boolean {
  return orientationFor(spec) === 1 && !isCropping(width, height, spec) && !isResampling(width, height, spec);
}

/** Largest dimension the resize accepts; the memory guard still applies to the product. */
export const MAX_RESIZE_SIDE = 65535;

/** Why this transform cannot run on a width x height image, or null. */
export function transformError(width: number, height: number, spec: TransformSpec): string | null {
  const int = (n: number) => Number.isInteger(n);
  const c = spec.crop;
  if (c) {
    if (![c.x, c.y, c.width, c.height].every(int)) return 'Crop values must be whole pixels.';
    if (c.width < 1 || c.height < 1) return 'The crop must be at least 1 × 1 pixel.';
    if (c.x < 0 || c.y < 0 || c.x + c.width > width || c.y + c.height > height) return `The crop must lie inside the ${width} × ${height} image.`;
  }
  const r = spec.resize;
  if (r) {
    if (!int(r.width) || !int(r.height)) return 'The output size must be whole pixels.';
    if (r.width < 1 || r.height < 1) return 'The output must be at least 1 × 1 pixel.';
    if (r.width > MAX_RESIZE_SIDE || r.height > MAX_RESIZE_SIDE) return `The output side is limited to ${MAX_RESIZE_SIDE} pixels.`;
  }
  if (![0, 90, 180, 270].includes(spec.rotate)) return 'Rotation must be 0, 90, 180 or 270 degrees.';
  return null;
}

export function crop(px: PixelData, c: CropRect): PixelData {
  if (c.x === 0 && c.y === 0 && c.width === px.width && c.height === px.height) return px;
  const out = allocate(c.width, c.height, px.bitDepth);
  for (let y = 0; y < c.height; y++) {
    const from = ((c.y + y) * px.width + c.x) * 4;
    out.data.set(px.data.subarray(from, from + c.width * 4), y * c.width * 4);
  }
  return out;
}

/** Applies the whole transform. Throws if `transformError` would report a problem. */
export function applyTransform(px: PixelData, spec: TransformSpec): PixelData {
  const err = transformError(px.width, px.height, spec);
  if (err) throw new Error(err);
  let out = spec.crop ? crop(px, spec.crop) : px;
  out = applyOrientation(out, orientationFor(spec));
  if (spec.resize && (spec.resize.width !== out.width || spec.resize.height !== out.height)) out = resampleLanczos3(out, spec.resize.width, spec.resize.height);
  return out;
}

// ---------------------------------------------------------------- resampling

const LANCZOS_A = 3;

function sinc(x: number): number {
  if (x === 0) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

export function lanczos3(x: number): number {
  const ax = Math.abs(x);
  return ax < LANCZOS_A ? sinc(x) * sinc(x / LANCZOS_A) : 0;
}

interface Taps {
  /** First source index for each output index. */
  start: Int32Array;
  /** Number of taps for each output index. */
  count: Int32Array;
  /** Normalised weights, `stride` per output index. */
  weights: Float32Array;
  stride: number;
}

/**
 * Filter taps for one axis. Pixel centres are aligned (output centre x maps to
 * source (x + 0.5) * scale - 0.5); when downscaling, the kernel is widened by
 * the scale so every source pixel contributes (no aliasing). Edge samples are
 * clamped, and each tap set is normalised to sum to exactly 1, so a constant
 * image stays constant.
 */
function taps(srcSize: number, dstSize: number): Taps {
  const scale = srcSize / dstSize;
  const filterScale = Math.max(1, scale);
  const support = LANCZOS_A * filterScale;
  const stride = Math.ceil(support) * 2 + 1;
  const start = new Int32Array(dstSize);
  const count = new Int32Array(dstSize);
  const weights = new Float32Array(dstSize * stride);
  for (let i = 0; i < dstSize; i++) {
    const center = (i + 0.5) * scale - 0.5;
    const lo = Math.ceil(center - support);
    const hi = Math.floor(center + support);
    // Accumulate per clamped source index, so edge taps that clamp to the same pixel merge.
    const first = Math.max(0, lo);
    const last = Math.min(srcSize - 1, hi);
    const n = last - first + 1;
    let sum = 0;
    const w = new Float64Array(n);
    for (let j = lo; j <= hi; j++) {
      const k = lanczos3((j - center) / filterScale);
      const idx = Math.min(srcSize - 1, Math.max(0, j)) - first;
      w[idx]! += k;
      sum += k;
    }
    start[i] = first;
    count[i] = n;
    for (let t = 0; t < n; t++) weights[i * stride + t] = w[t]! / sum;
  }
  return { start, count, weights, stride };
}

/**
 * Lanczos-3, separable, in the stored (gamma-encoded) values, on PREMULTIPLIED
 * alpha so transparent pixels cannot bleed their hidden colour into visible
 * neighbours (edge fringing); un-premultiplied afterwards. The colour under
 * fully transparent output pixels is therefore 0, which the loss list says.
 * Same bit depth in and out; results rounded to nearest and clamped.
 */
export function resampleLanczos3(px: PixelData, dstW: number, dstH: number): PixelData {
  const sw = px.width;
  const sh = px.height;
  const max = maxValue(px.bitDepth);
  const src = px.data;
  const hx = taps(sw, dstW);
  const vy = taps(sh, dstH);

  // Horizontal pass into a float buffer, premultiplying while reading.
  const mid = new Float32Array(dstW * sh * 4);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < dstW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const s0 = hx.start[x]!;
      const n = hx.count[x]!;
      const wo = x * hx.stride;
      for (let t = 0; t < n; t++) {
        const w = hx.weights[wo + t]!;
        const i = row + (s0 + t) * 4;
        const al = src[i + 3]!;
        const pm = (w * al) / max;
        r += src[i]! * pm;
        g += src[i + 1]! * pm;
        b += src[i + 2]! * pm;
        a += w * al;
      }
      const o = (y * dstW + x) * 4;
      mid[o] = r;
      mid[o + 1] = g;
      mid[o + 2] = b;
      mid[o + 3] = a;
    }
  }

  // Vertical pass, then un-premultiply, round and clamp.
  const out = allocate(dstW, dstH, px.bitDepth);
  const dst = out.data;
  const clamp = (v: number) => (v <= 0 ? 0 : v >= max ? max : Math.round(v));
  for (let y = 0; y < dstH; y++) {
    const s0 = vy.start[y]!;
    const n = vy.count[y]!;
    const wo = y * vy.stride;
    for (let x = 0; x < dstW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let t = 0; t < n; t++) {
        const w = vy.weights[wo + t]!;
        const i = ((s0 + t) * dstW + x) * 4;
        r += w * mid[i]!;
        g += w * mid[i + 1]!;
        b += w * mid[i + 2]!;
        a += w * mid[i + 3]!;
      }
      const o = (y * dstW + x) * 4;
      const ac = clamp(a);
      if (ac === 0) {
        dst[o] = 0;
        dst[o + 1] = 0;
        dst[o + 2] = 0;
        dst[o + 3] = 0;
        continue;
      }
      // Un-premultiply by the unclamped coverage so ringing in alpha does not tint colour.
      const k = max / Math.max(a, 1e-9);
      dst[o] = clamp(r * k);
      dst[o + 1] = clamp(g * k);
      dst[o + 2] = clamp(b * k);
      dst[o + 3] = ac;
    }
  }
  return out;
}

/** Human-readable summary, for the loss list and the UI ("cropped to 120 × 80, rotated 90° clockwise, mirrored"). */
export function describeOrientation(spec: Pick<TransformSpec, 'rotate' | 'flipH' | 'flipV'>): string {
  const parts: string[] = [];
  if (spec.flipH) parts.push('mirrored left-right');
  if (spec.flipV) parts.push('mirrored top-bottom');
  if (spec.rotate) parts.push(`rotated ${spec.rotate}° clockwise`);
  return parts.join(', then ');
}
