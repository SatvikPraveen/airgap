/** Pure helpers on PixelData. No DOM. */
import type { PixelData } from './codecs/types';

export function maxValue(bitDepth: number): number {
  return (1 << bitDepth) - 1;
}

export function allocate(width: number, height: number, bitDepth: number): PixelData {
  const n = width * height * 4;
  return {
    width,
    height,
    bitDepth,
    data: bitDepth === 8 ? new Uint8ClampedArray(n) : new Uint16Array(n),
  };
}

/** Rescales samples to another bit depth with round-to-nearest. Exact when widening by bit replication. */
export function convertBitDepth(px: PixelData, bitDepth: number): PixelData {
  if (px.bitDepth === bitDepth) return px;
  const out = allocate(px.width, px.height, bitDepth);
  const from = maxValue(px.bitDepth);
  const to = maxValue(bitDepth);
  const src = px.data;
  const dst = out.data;
  // Table-driven for sources up to 16 bits.
  const table = new Uint16Array(from + 1);
  for (let v = 0; v <= from; v++) table[v] = Math.round((v * to) / from);
  for (let i = 0; i < src.length; i++) dst[i] = table[src[i]!]!;
  return out;
}

/** Scans alpha once: is any pixel non-opaque, and is any partially so. */
export function alphaStats(px: PixelData): { hasTransparency: boolean; hasSemiTransparency: boolean } {
  const max = maxValue(px.bitDepth);
  const d = px.data;
  let hasTransparency = false;
  let hasSemiTransparency = false;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i]!;
    if (a !== max) {
      hasTransparency = true;
      if (a !== 0) {
        hasSemiTransparency = true;
        break;
      }
    }
  }
  return { hasTransparency, hasSemiTransparency };
}

export interface PixelComparison {
  identical: boolean;
  differingPixels: number;
  /** Pixels differing in alpha, or in RGB while alpha is non-zero. */
  differingVisiblePixels: number;
  maxChannelDiff: number;
}

/** Exact per-channel comparison of two buffers of the same bit depth. */
export function comparePixels(a: PixelData, b: PixelData): PixelComparison {
  if (a.width !== b.width || a.height !== b.height || a.bitDepth !== b.bitDepth) {
    const n = a.width * a.height;
    return { identical: false, differingPixels: n, differingVisiblePixels: n, maxChannelDiff: maxValue(a.bitDepth) };
  }
  const pa = a.data;
  const pb = b.data;
  let differingPixels = 0;
  let differingVisiblePixels = 0;
  let maxChannelDiff = 0;
  for (let i = 0; i < pa.length; i += 4) {
    let pixelDiff = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(pa[i + c]! - pb[i + c]!);
      if (d > pixelDiff) pixelDiff = d;
    }
    if (pixelDiff > 0) {
      differingPixels++;
      if (pixelDiff > maxChannelDiff) maxChannelDiff = pixelDiff;
      if (pa[i + 3] !== pb[i + 3] || pa[i + 3] !== 0) differingVisiblePixels++;
    }
  }
  return { identical: differingPixels === 0, differingPixels, differingVisiblePixels, maxChannelDiff };
}

/** Deterministic test/probe image: opaque noise plus every kind of alpha, with non-zero RGB under alpha 0. */
export function probeImage(size: number, bitDepth: number, withAlpha: boolean, seed = 0x2f6e2b1): PixelData {
  const px = allocate(size, size, bitDepth);
  const max = maxValue(bitDepth);
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % (max + 1);
  };
  const d = px.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      d[i] = rnd();
      d[i + 1] = rnd();
      d[i + 2] = rnd();
      let a = max;
      if (withAlpha) {
        const band = Math.floor((y * 4) / size);
        if (band === 1) a = 0; // fully transparent, RGB above is non-zero and must survive
        else if (band === 2) a = 1 + (rnd() % (max - 1)); // semi-transparent
        else if (band === 3) a = x % 2 === 0 ? 1 : max - 1; // alpha extremes
      }
      d[i + 3] = a;
    }
  }
  return px;
}
