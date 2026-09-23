/**
 * Canvas codec tests. These run in real headless Chromium via Vitest browser
 * mode because there is no faithful stand-in for the browser's encoders.
 */
import { describe, expect, it } from 'vitest';
import { createCanvasCodec, probeWebpLossless } from '../../src/codecs/canvas';
import { convert } from '../../src/convert';
import { flattenRgba } from '../../src/flatten';
import * as P from '../fixtures/pattern.mjs';
import { firstMismatch, fixtureBytes, maxChannelDiff } from './helpers';

const png = createCanvasCodec('png');
const jpeg = createCanvasCodec('jpeg');

function expectedRgb8(): Uint8ClampedArray {
  const { width, height } = P.RGB8;
  const noise = P.lcg(1);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = P.rgb8Pixel(x, y, noise);
      const i = (y * width + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
  return out;
}

function expectedRgba(): Uint8ClampedArray {
  const { width, height } = P.RGBA_PARTIAL;
  const noise = P.lcg(2);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = P.rgbaPixel(x, y, noise);
      const i = (y * width + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = a;
    }
  }
  return out;
}

describe('PNG decode', () => {
  it('decodes rgb8.png to exactly the generated pattern (no decoder drift)', async () => {
    const img = await png.decode(await fixtureBytes('rgb8.png'));
    expect(img.pixels.width).toBe(P.RGB8.width);
    expect(img.pixels.height).toBe(P.RGB8.height);
    expect(firstMismatch(img.pixels.data, expectedRgb8())).toBeNull();
    expect(img.metadata.hasAlpha).toBe(false);
    expect(img.metadata.bitDepth).toBe(8);
  });

  it('decodes one-pixel.png exactly', async () => {
    const img = await png.decode(await fixtureBytes('one-pixel.png'));
    expect(img.pixels.width).toBe(1);
    expect(Array.from(img.pixels.data)).toEqual([...P.ONE_PIXEL.rgb, 255]);
  });

  it('reports 16-bit source depth but yields 8-bit pixels', async () => {
    const img = await png.decode(await fixtureBytes('rgb16.png'));
    expect(img.metadata.bitDepth).toBe(16);
    expect(img.bitDepth).toBe(8);
    expect(img.pixels.width).toBe(P.RGB16.width);
  });
});

describe('PNG -> PNG round trip', () => {
  for (const name of ['rgb8.png', 'one-pixel.png', 'rgb16.png']) {
    it(`${name}: decode -> encode -> decode is pixel-identical (per-channel diff exactly 0)`, async () => {
      const a = await png.decode(await fixtureBytes(name));
      const bytes = await png.encode(a, { lossless: true });
      const b = await png.decode(bytes);
      expect(b.pixels.width).toBe(a.pixels.width);
      expect(b.pixels.height).toBe(a.pixels.height);
      expect(maxChannelDiff(a.pixels.data, b.pixels.data)).toBe(0);
      expect(firstMismatch(a.pixels.data, b.pixels.data)).toBeNull();
    });
  }

  it('rgba-partial.png: characterises what the premultiplied canvas does to transparency', async () => {
    const expected = expectedRgba();
    const a = await png.decode(await fixtureBytes('rgba-partial.png'));
    expect(a.metadata.hasAlpha).toBe(true);
    expect(a.metadata.hasTransparency).toBe(true);
    expect(a.metadata.hasSemiTransparency).toBe(true);

    // Alpha channel itself: exact.
    for (let i = 3; i < expected.length; i += 4) {
      expect(a.pixels.data[i]).toBe(expected[i]);
    }
    // Fully opaque pixels: exact.
    for (let i = 0; i < expected.length; i += 4) {
      if (expected[i + 3] === 255) {
        expect(a.pixels.data.slice(i, i + 3)).toEqual(expected.slice(i, i + 3));
      }
    }
    // Semi-transparent and fully transparent pixels: measure the damage.
    let semiMax = 0;
    let transparentMax = 0;
    for (let i = 0; i < expected.length; i += 4) {
      const alpha = expected[i + 3]!;
      const d = Math.max(
        Math.abs(expected[i]! - a.pixels.data[i]!),
        Math.abs(expected[i + 1]! - a.pixels.data[i + 1]!),
        Math.abs(expected[i + 2]! - a.pixels.data[i + 2]!),
      );
      if (alpha === 0) transparentMax = Math.max(transparentMax, d);
      else if (alpha < 255) semiMax = Math.max(semiMax, d);
    }
    // Documented limitation of the canvas codec (see capabilities.ts
    // 'premultiplied-alpha'). If either assertion ever fails because the
    // diff became 0, the browser fixed it and the warning can be narrowed.
    expect(semiMax, 'semi-transparent RGB is rounded by premultiplication').toBeGreaterThan(0);
    expect(transparentMax, 'RGB under alpha=0 is discarded').toBeGreaterThan(0);

    // And a second pass through the codec is stable: no further drift.
    const b = await png.decode(await png.encode(a, { lossless: true }));
    expect(firstMismatch(a.pixels.data, b.pixels.data)).toBeNull();
  });
});

describe('RGBA -> JPEG flatten', () => {
  it('flattens onto the chosen background, never black', async () => {
    const src = await png.decode(await fixtureBytes('rgba-partial.png'));
    const bg = { r: 255, g: 0, b: 0 };
    const codecs = { png, jpeg, webp: createCanvasCodec('webp') };
    const result = await convert(codecs, src, 'png', {
      target: { format: 'jpeg', lossless: false },
      quality: 1,
      background: bg,
    });
    expect(result.mime).toBe('image/jpeg');
    expect(result.verification.comparedAgainstFlattened).toBe(true);

    const back = await jpeg.decode(result.bytes);
    const { width } = P.RGBA_PARTIAL;
    // Fully transparent band (rows 24..35) must be the background colour, within JPEG tolerance.
    for (let y = 24; y < 36; y += 3) {
      for (let x = 0; x < width; x += 8) {
        const i = (y * width + x) * 4;
        const [r, g, b] = [back.pixels.data[i]!, back.pixels.data[i + 1]!, back.pixels.data[i + 2]!];
        expect(r, `row ${y} col ${x} red`).toBeGreaterThan(200);
        expect(g, `row ${y} col ${x} green`).toBeLessThan(60);
        expect(b, `row ${y} col ${x} blue`).toBeLessThan(60);
      }
    }
    // The expected flattened image is what the pure flatten produces; JPEG at q=1 stays close.
    const flat = flattenRgba(src.pixels.data, bg);
    expect(maxChannelDiff(flat, back.pixels.data)).toBeLessThan(40);
  });

  it('refuses RGBA -> JPEG without a background colour', async () => {
    const src = await png.decode(await fixtureBytes('rgba-partial.png'));
    const codecs = { png, jpeg, webp: createCanvasCodec('webp') };
    await expect(
      convert(codecs, src, 'png', { target: { format: 'jpeg', lossless: false }, quality: 0.9 }),
    ).rejects.toThrow(/background colour/);
  });
});

describe('WebP', () => {
  it('probe reports whether lossless WebP is reachable in this browser', async () => {
    const probe = await probeWebpLossless();
    console.log('[webp probe]', JSON.stringify(probe));
    expect(probe.supported).toBe(true);
  });

  it('WebP lossless round trip of rgb8.png is pixel-identical when the probe says lossless', async () => {
    const probe = await probeWebpLossless();
    const webp = createCanvasCodec('webp', probe.lossless);
    const a = await png.decode(await fixtureBytes('rgb8.png'));
    const bytes = await webp.encode(a, { lossless: true });
    const b = await webp.decode(bytes);
    const diff = maxChannelDiff(a.pixels.data, b.pixels.data);
    if (probe.lossless) {
      expect(diff).toBe(0);
      expect(b.metadata.sourceLossless, 'container is VP8L').toBe(true);
    } else {
      // Then the codec must NOT claim losslessness.
      expect(webp.capabilities.lossless).toBe(false);
    }
  });

  it('WebP lossy at quality 0.8 is NOT identical (so the lossy label is honest)', async () => {
    const webp = createCanvasCodec('webp');
    const a = await png.decode(await fixtureBytes('rgb8.png'));
    const b = await webp.decode(await webp.encode(a, { lossless: false, quality: 0.8 }));
    expect(maxChannelDiff(a.pixels.data, b.pixels.data)).toBeGreaterThan(0);
  });
});

describe('JPEG decode', () => {
  it('reads EXIF + GPS from the header and decodes 8-bit opaque pixels', async () => {
    const img = await jpeg.decode(await fixtureBytes('exif-gps.jpg'));
    expect(img.metadata.hasExif).toBe(true);
    expect(img.metadata.hasGps).toBe(true);
    expect(img.metadata.orientation).toBe(1);
    expect(img.metadata.hasAlpha).toBe(false);
    expect(img.pixels.width).toBe(P.EXIF_GPS.width);
  });
});
