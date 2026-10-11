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

export const RGBA16 = { width: 24, height: 20 };
export const ORIENT = { width: 48, height: 32 };
export const ICC_P3 = { width: 16, height: 16 };

/** 16-bit RGBA with values not representable in 8 bits, and every alpha band (opaque, semi, zero-with-colour, 1). */
export function rgba16Pixel(x, y) {
  const r = (x * 2741 + 517) & 0xffff;
  const g = (y * 4099 + 3) & 0xffff;
  const b = ((x + y) * 1237 + 12345) & 0xffff;
  let a;
  if (y < 5) a = 0xffff;
  else if (y < 10) a = 1 + ((x * 3001) % 0xfffe);
  else if (y < 15) a = 0;
  else a = 1;
  return [r, g, b, a];
}

/** Four flat quadrants: TL red, TR green, BL blue, BR yellow. Used with EXIF Orientation=6. */
export function quadrantPixel(x, y) {
  const right = x >= ORIENT.width / 2;
  const bottom = y >= ORIENT.height / 2;
  if (!right && !bottom) return [220, 30, 30];
  if (right && !bottom) return [30, 200, 40];
  if (!right && bottom) return [30, 60, 220];
  return [230, 220, 40];
}

/** Display-P3-tagged test image: a few flat patches with known device values. */
export const P3_PATCHES = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [128, 128, 128],
  [200, 120, 60],
  [40, 160, 200],
  [255, 255, 255],
  [0, 0, 0],
];
export function p3Pixel(x, y) {
  const i = Math.floor(x / 2) % P3_PATCHES.length;
  return P3_PATCHES[i];
}

/**
 * One location, written into every place metadata can hide it. The raw-byte
 * needles below are what a "strip GPS only" output must never contain.
 */
export const LOCATION = {
  lat: [[28, 1], [3, 1], [3132, 100]], // 28 deg 3' 31.32" N
  lon: [[82, 1], [24, 1], [5004, 100]], // 82 deg 24' 50.04" W
  decimalLat: '28.058700',
  decimalLon: '-82.413900',
  xmpLat: '28,3.522N',
  xmpLon: '82,24.834W',
  makerAscii: 'GEO lat=28.058700 lon=-82.413900',
};

/** Byte patterns that identify the coordinates regardless of container. */
export function locationNeedles() {
  const enc = (s) => Array.from(new TextEncoder().encode(s));
  const rat = (pairs, le) => {
    const out = [];
    for (const [n, d] of pairs) {
      const b = new Uint8Array(8);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, n, le);
      dv.setUint32(4, d, le);
      out.push(Array.from(b));
    }
    return out;
  };
  return [
    { name: 'decimal latitude text', bytes: enc(LOCATION.decimalLat) },
    { name: 'decimal longitude text', bytes: enc(LOCATION.decimalLon) },
    { name: 'XMP latitude text', bytes: enc(LOCATION.xmpLat) },
    { name: 'XMP longitude text', bytes: enc(LOCATION.xmpLon) },
    { name: 'maker note text', bytes: enc(LOCATION.makerAscii) },
    { name: 'lat seconds rational BE', bytes: rat([LOCATION.lat[2]], false)[0] },
    { name: 'lat seconds rational LE', bytes: rat([LOCATION.lat[2]], true)[0] },
    { name: 'lon seconds rational BE', bytes: rat([LOCATION.lon[2]], false)[0] },
    { name: 'lon seconds rational LE', bytes: rat([LOCATION.lon[2]], true)[0] },
    { name: 'lat DMS rationals BE (24 bytes)', bytes: rat(LOCATION.lat, false).flat() },
    { name: 'lat DMS rationals LE (24 bytes)', bytes: rat(LOCATION.lat, true).flat() },
    { name: 'lon DMS rationals BE (24 bytes)', bytes: rat(LOCATION.lon, false).flat() },
    { name: 'lon DMS rationals LE (24 bytes)', bytes: rat(LOCATION.lon, true).flat() },
  ];
}

/** Indices of every needle found in `bytes`, by name. */
export function findLocationNeedles(bytes) {
  const hits = [];
  for (const n of locationNeedles()) {
    outer: for (let i = 0; i + n.bytes.length <= bytes.length; i++) {
      for (let k = 0; k < n.bytes.length; k++) if (bytes[i + k] !== n.bytes[k]) continue outer;
      hits.push(`${n.name}@${i}`);
      break;
    }
  }
  return hits;
}

/**
 * apng-ops.png: four frames exercising every dispose_op and blend_op. OVER is used only with
 * source alpha 0 or 255, so the composited result involves no rounding.
 */
export const APNG_OPS = {
  width: 32,
  height: 24,
  plays: 3,
  frames: [
    { x: 0, y: 0, w: 32, h: 24, delay: [1, 10], dispose: 0, blend: 0, fill: (x, y) => [x * 8, y * 10, 128, y >= 8 && y < 12 ? 100 : 255] },
    { x: 4, y: 3, w: 10, h: 8, delay: [7, 100], dispose: 1, blend: 1, fill: (x, y) => ((x + y) % 3 === 0 ? [250, 10, 10, 0] : [20, 220, 40, 255]) },
    { x: 12, y: 6, w: 9, h: 10, delay: [250, 1000], dispose: 2, blend: 0, fill: (x, y) => [10 * x, 200, 10 * y, 40 + 20 * ((x + y) % 5)] },
    { x: 20, y: 14, w: 6, h: 5, delay: [0, 0], dispose: 0, blend: 1, fill: (x) => [255, 255, (x * 40) % 256, 255] },
  ],
};

/**
 * The specification's compositing for APNG_OPS, written out directly from its definition
 * (independent of src/codecs/apng.ts): the canvas starts transparent black; OVER with alpha 0
 * keeps the destination and with alpha 255 replaces it; dispose BACKGROUND clears the frame's
 * rectangle; dispose PREVIOUS restores it to what it was before the frame was drawn.
 */
export function apngOpsExpectedFrames() {
  const { width: W, frames } = APNG_OPS;
  const canvas = new Uint8Array(W * APNG_OPS.height * 4);
  const out = [];
  for (const f of frames) {
    const before = canvas.slice();
    for (let y = 0; y < f.h; y++)
      for (let x = 0; x < f.w; x++) {
        const px = f.fill(x, y);
        const i = ((f.y + y) * W + f.x + x) * 4;
        if (f.blend === 0 || px[3] === 255) canvas.set(px, i);
        else if (px[3] !== 0) throw new Error('fixture uses OVER with partial alpha');
      }
    out.push(canvas.slice());
    for (let y = 0; y < f.h; y++)
      for (let x = 0; x < f.w; x++) {
        const i = ((f.y + y) * W + f.x + x) * 4;
        if (f.dispose === 1) canvas.fill(0, i, i + 4);
        else if (f.dispose === 2) canvas.set(before.subarray(i, i + 4), i);
      }
  }
  return out;
}
