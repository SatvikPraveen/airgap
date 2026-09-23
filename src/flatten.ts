/**
 * Pure alpha flattening. Composites non-premultiplied RGBA over an opaque
 * background using "source over", with rounding to nearest.
 *
 * Never called implicitly: convert() refuses to encode RGBA into an
 * alpha-less format unless the caller supplied a background.
 */
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

/** Returns a new RGBA buffer with alpha = 255 everywhere. Input is not modified. */
export function flattenRgba(
  src: Uint8ClampedArray,
  background: RGB,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(src.length);
  const bg = [background.r, background.g, background.b];
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]!;
    if (a === 255) {
      out[i] = src[i]!;
      out[i + 1] = src[i + 1]!;
      out[i + 2] = src[i + 2]!;
    } else if (a === 0) {
      out[i] = bg[0]!;
      out[i + 1] = bg[1]!;
      out[i + 2] = bg[2]!;
    } else {
      const ia = 255 - a;
      // Round to nearest: (x*a + bg*(255-a) + 127) / 255
      out[i] = (src[i]! * a + bg[0]! * ia + 127) / 255;
      out[i + 1] = (src[i + 1]! * a + bg[1]! * ia + 127) / 255;
      out[i + 2] = (src[i + 2]! * a + bg[2]! * ia + 127) / 255;
    }
    out[i + 3] = 255;
  }
  return out;
}

/** Scans an RGBA buffer once: is any pixel non-opaque, and is any partially so. */
export function alphaStats(px: Uint8ClampedArray): {
  hasTransparency: boolean;
  hasSemiTransparency: boolean;
} {
  let hasTransparency = false;
  let hasSemiTransparency = false;
  for (let i = 3; i < px.length; i += 4) {
    const a = px[i]!;
    if (a !== 255) {
      hasTransparency = true;
      if (a !== 0) {
        hasSemiTransparency = true;
        break;
      }
    }
  }
  return { hasTransparency, hasSemiTransparency };
}
