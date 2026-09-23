/**
 * Deterministic pixel patterns shared by the fixture generator
 * (scripts/make-fixtures.mjs) and the tests, so tests can assert exact
 * expected values without depending on any decoder.
 */

export const RGB8 = { width: 64, height: 48 };
export const RGBA_PARTIAL = { width: 64, height: 48 };
export const RGB16 = { width: 32, height: 32 };
export const EXIF_GPS = { width: 64, height: 48 };
export const ONE_PIXEL = { width: 1, height: 1, rgb: [201, 77, 19] };

/** Small deterministic PRNG so "noise" is reproducible. */
export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24; // 0..255
  };
}

/** 8-bit RGB: gradients plus a noisy band so lossy encoders cannot hide. */
export function rgb8Pixel(x, y, noise) {
  const r = Math.round((x / (RGB8.width - 1)) * 255);
  const g = Math.round((y / (RGB8.height - 1)) * 255);
  const b = y >= 32 ? noise() : (x * 7 + y * 13) & 255;
  return [r, g, b];
}

/**
 * RGBA with four bands of alpha: opaque, semi-transparent gradient, a
 * fully transparent band with NON-ZERO hidden colour, and alpha = 1.
 */
export function rgbaPixel(x, y, noise) {
  const r = noise();
  const g = Math.round((x / (RGBA_PARTIAL.width - 1)) * 255);
  const b = 255 - g;
  let a;
  if (y < 12) a = 255;
  else if (y < 24) a = Math.round((x / (RGBA_PARTIAL.width - 1)) * 253) + 1; // 1..254
  else if (y < 36) a = 0;
  else a = 1;
  return [r, g, b, a];
}

/** 16-bit RGB with values that are NOT multiples of 257 (not 8-bit representable). */
export function rgb16Pixel(x, y) {
  const r = (x * 2039 + 12345) & 0xffff;
  const g = (y * 3571 + 999) & 0xffff;
  const b = ((x * y) * 977 + 31) & 0xffff;
  return [r, g, b];
}
