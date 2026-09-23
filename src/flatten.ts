/**
 * Pure alpha flattening. Composites non-premultiplied RGBA over an opaque
 * background using "source over", rounding to nearest, at any bit depth.
 *
 * Never called implicitly: convert() refuses to encode RGBA into an
 * alpha-less format unless the caller supplied a background.
 */
import type { PixelData } from './codecs/types';
import { allocate, maxValue } from './pixels';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export const WHITE: RGB = { r: 255, g: 255, b: 255 };

export function parseHexColor(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a 6-digit hex colour: ${hex}`);
  const v = parseInt(m[1]!, 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

export function toHexColor(c: RGB): string {
  return '#' + [c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Background is given as 8-bit sRGB; it is scaled to the buffer's bit depth by bit replication. */
export function flattenPixels(px: PixelData, background: RGB): PixelData {
  const max = maxValue(px.bitDepth);
  const scale = max / 255;
  const bg = [Math.round(background.r * scale), Math.round(background.g * scale), Math.round(background.b * scale)];
  const out = allocate(px.width, px.height, px.bitDepth);
  const src = px.data;
  const dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]!;
    if (a === max) {
      dst[i] = src[i]!;
      dst[i + 1] = src[i + 1]!;
      dst[i + 2] = src[i + 2]!;
    } else if (a === 0) {
      dst[i] = bg[0]!;
      dst[i + 1] = bg[1]!;
      dst[i + 2] = bg[2]!;
    } else {
      const ia = max - a;
      dst[i] = Math.round((src[i]! * a + bg[0]! * ia) / max);
      dst[i + 1] = Math.round((src[i + 1]! * a + bg[1]! * ia) / max);
      dst[i + 2] = Math.round((src[i + 2]! * a + bg[2]! * ia) / max);
    }
    dst[i + 3] = max;
  }
  return out;
}

/** 8-bit convenience used by tests and the canvas path. */
export function flattenRgba(src: Uint8ClampedArray, background: RGB): Uint8ClampedArray<ArrayBuffer> {
  const n = src.length / 4;
  const out = flattenPixels({ width: n, height: 1, bitDepth: 8, data: src }, background);
  return out.data as Uint8ClampedArray<ArrayBuffer>;
}

/** Undo premultiplication (TIFF associated alpha). Lossy by nature; the caller flags it. */
export function unpremultiply(px: PixelData): PixelData {
  const max = maxValue(px.bitDepth);
  const out = allocate(px.width, px.height, px.bitDepth);
  const src = px.data;
  const dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]!;
    if (a === 0 || a === max) {
      dst[i] = src[i]!;
      dst[i + 1] = src[i + 1]!;
      dst[i + 2] = src[i + 2]!;
    } else {
      dst[i] = Math.min(max, Math.round((src[i]! * max) / a));
      dst[i + 1] = Math.min(max, Math.round((src[i + 1]! * max) / a));
      dst[i + 2] = Math.min(max, Math.round((src[i + 2]! * max) / a));
    }
    dst[i + 3] = a;
  }
  return out;
}
