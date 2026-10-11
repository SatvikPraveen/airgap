import { server } from 'vitest/browser';
import type { DecodedImage, PixelData } from '../../src/codecs/types';

/** The engine this browser-mode run is in: 'chromium', 'firefox' or 'webkit'. */
export const ENGINE = server.browser as 'chromium' | 'firefox' | 'webkit';

/**
 * WebKit on macOS decodes and encodes images through Apple's ImageIO / CoreGraphics; the
 * Linux WebKit port (what CI runs) uses libjpeg-turbo, libwebp and its own canvas. The two
 * behave differently, so expectations are keyed on this, not on the engine name alone.
 */
export const IMAGEIO = ENGINE === 'webkit' && server.platform === 'darwin';

/** Canvases that reach a fixed point after one premultiplied PNG round trip (measured). */
export const CANVAS_SETTLES = ENGINE === 'chromium' || IMAGEIO;
import { allocate } from '../../src/pixels';

export async function fixtureBytes(name: string): Promise<Uint8Array> {
  const url = new URL(`../fixtures/${name}`, import.meta.url).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Exact per-channel comparison. Returns the first mismatch, or null if identical. */
export function firstMismatch(a: ArrayLike<number>, b: ArrayLike<number>): { index: number; a: number; b: number } | null {
  if (a.length !== b.length) return { index: -1, a: a.length, b: b.length };
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return { index: i, a: a[i]!, b: b[i]! };
  return null;
}

export function maxChannelDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > m) m = d;
  }
  return m;
}

export function rasterFrom(dims: { width: number; height: number }, fill: (x: number, y: number) => number[], bitDepth = 8): PixelData {
  const px = allocate(dims.width, dims.height, bitDepth);
  const max = (1 << bitDepth) - 1;
  for (let y = 0; y < dims.height; y++) {
    for (let x = 0; x < dims.width; x++) {
      const [r, g, b, a = max] = fill(x, y);
      px.data.set([r!, g!, b!, a], (y * dims.width + x) * 4);
    }
  }
  return px;
}

export function asImage(px: PixelData, over: Partial<DecodedImage['metadata']> = {}): DecodedImage {
  return {
    pixels: px,
    metadata: {
      bitDepth: px.bitDepth,
      hasAlpha: true,
      hasTransparency: true,
      hasSemiTransparency: true,
      hasExif: false,
      hasGps: false,
      hasIcc: false,
      hasXmp: false,
      isAnimated: false,
      ...over,
    },
  };
}

/** Max channel difference over pixels that are fully opaque in `a` (premultiplied canvases only promise these). */
export function maxOpaqueDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] !== 255) continue;
    for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(a[i + c]! - b[i + c]!));
  }
  return m;
}
