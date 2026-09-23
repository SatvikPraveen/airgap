/**
 * The wasm codecs in real Chromium. Alpha assertions are EXACT over the full
 * RGBA tuple, transparent pixels included. The probes here are the same ones
 * the app runs; a format whose probe fails must not claim lossless.
 */
import { describe, expect, it } from 'vitest';
import { decode as decodeImageJs } from 'tiff';
import { createCanvasCodec } from '../../src/codecs/canvas';
import { probeCodec } from '../../src/codecs/probe';
import { createTiffCodec } from '../../src/codecs/tiff';
import type { Codec } from '../../src/codecs/types';
import { createWasmAvifCodec } from '../../src/codecs/wasm/avif';
import { createWasmJpegCodec } from '../../src/codecs/wasm/jpeg';
import { createWasmJxlCodec } from '../../src/codecs/wasm/jxl';
import { createWasmPngCodec } from '../../src/codecs/wasm/png';
import { createWasmWebpCodec } from '../../src/codecs/wasm/webp';
import { convertBitDepth, probeImage } from '../../src/pixels';
import * as P from '../fixtures/pattern.mjs';
import { asImage, firstMismatch, fixtureBytes, maxChannelDiff, rasterFrom } from './helpers';

const codecs: Record<string, Promise<Codec>> = {
  png: createWasmPngCodec(),
  jpeg: createWasmJpegCodec(),
  webp: createWasmWebpCodec(),
  avif: createWasmAvifCodec(),
  jxl: createWasmJxlCodec(),
  tiff: Promise.resolve(createTiffCodec()),
};

const rgba8 = () => {
  const noise = P.lcg(2);
  return rasterFrom(P.RGBA_PARTIAL, (x, y) => P.rgbaPixel(x, y, noise));
};
const rgba16 = () => rasterFrom(P.RGBA16, (x, y) => P.rgba16Pixel(x, y), 16);

describe('probes (the same ones the app runs)', () => {
  it('jxl: the @jsquash/jxl encoder+decoder pair is NOT exact in this browser; the probe must refuse lossless', async () => {
    const r = await probeCodec(await codecs.jxl!);
    console.log('[probe jxl]', r.probe.detail, JSON.stringify(r.probe.checks));
    expect(r.probe.ok).toBe(true);
    // Documented finding: max channel difference 1 on a handful of pixels. If this ever flips
    // to verified, the README statement about JPEG XL must be updated.
    expect(r.capabilities.lossless).toBe(false);
    expect(r.capabilities.exactAlpha).toBe(false);
    expect(r.capabilities.decodeExact).toBe(false);
    expect(r.probe.detail).toMatch(/max diff 1\b/);
  });
  for (const name of ['png', 'webp', 'avif', 'tiff'] as const) {
    it(`${name}: lossless and exactAlpha verified in this browser`, async () => {
      const codec = await codecs[name]!;
      const r = await probeCodec(codec, name === 'tiff' ? undefined : createCanvasCodec(name));
      console.log(`[probe ${name}]`, r.probe.detail, JSON.stringify(r.probe.checks));
      expect(r.probe.ok, r.probe.detail).toBe(true);
      expect(r.capabilities.lossless, 'lossless').toBe(true);
      expect(r.capabilities.exactAlpha, 'exactAlpha').toBe(true);
      expect(r.probe.checks['exactAlpha']).toEqual({ claimed: true, verified: true });
      expect(r.capabilities.decodeExact).toBe(true);
      if (name !== 'tiff') expect(r.probe.checks['independentDecode']).toEqual({ claimed: true, verified: true });
    });
  }
  it('png: 16-bit verified; avif: 10 and 12-bit verified; metadata claims verified for png/webp/jpeg/tiff', async () => {
    const png = await probeCodec(await codecs.png!);
    expect(png.capabilities.encodeBitDepths).toEqual([8, 16]);
    expect(png.capabilities.metadata).toEqual({ exif: true, icc: true, xmp: true });
    const avif = await probeCodec(await codecs.avif!);
    expect(avif.capabilities.encodeBitDepths).toEqual([8, 10, 12]);
    const webp = await probeCodec(await codecs.webp!);
    expect(webp.capabilities.metadata).toEqual({ exif: true, icc: true, xmp: true });
    const jpeg = await probeCodec(await codecs.jpeg!);
    expect(jpeg.capabilities.lossless).toBe(false);
    expect(jpeg.capabilities.metadata).toEqual({ exif: true, icc: true, xmp: true });
    const tiff = await probeCodec(await codecs.tiff!);
    expect(tiff.capabilities.encodeBitDepths).toEqual([8, 16]);
    expect(tiff.capabilities.metadata).toEqual({ exif: true, icc: true, xmp: true });
  });
});

describe('exact RGBA round trips (full tuple, alpha-0 pixels included)', () => {
  it('jxl: round trip is within 1/255 but NOT identical (why it is never offered as lossless)', async () => {
    const codec = await codecs.jxl!;
    const src = rgba8();
    const back = await codec.decode(await codec.encode(asImage(src), { lossless: true }));
    expect(firstMismatch(src.data, back.pixels.data)).not.toBeNull();
    expect(maxChannelDiff(src.data, back.pixels.data)).toBe(1);
  });
  for (const name of ['png', 'webp', 'avif', 'tiff'] as const) {
    it(`${name}: rgba-partial pattern -> encode lossless -> decode is identical`, async () => {
      const codec = await codecs[name]!;
      const src = rgba8();
      const bytes = await codec.encode(asImage(src), { lossless: true });
      const back = await codec.decode(bytes);
      expect(back.pixels.bitDepth).toBe(8);
      expect(firstMismatch(src.data, back.pixels.data)).toBeNull();
    });
  }
  for (const name of ['png', 'tiff'] as const) {
    it(`${name}: 16-bit RGBA round trip is identical`, async () => {
      const codec = await codecs[name]!;
      const src = rgba16();
      const back = await codec.decode(await codec.encode(asImage(src), { lossless: true }));
      expect(back.pixels.bitDepth).toBe(16);
      expect(firstMismatch(src.data, back.pixels.data)).toBeNull();
    });
  }
  for (const depth of [10, 12] as const) {
    it(`avif: ${depth}-bit RGBA round trip is identical`, async () => {
      const codec = await codecs.avif!;
      const src = probeImage(20, depth, true, 99);
      const back = await codec.decode(await codec.encode(asImage(src), { lossless: true }));
      expect(back.pixels.bitDepth).toBe(depth);
      expect(firstMismatch(src.data, back.pixels.data)).toBeNull();
    });
  }
});

describe('decoding the independently written fixtures', () => {
  it('png: rgba-partial.png exact, rgba16.png exact at 16-bit, rgb16.png exact', async () => {
    const png = await codecs.png!;
    const a = await png.decode(await fixtureBytes('rgba-partial.png'));
    expect(firstMismatch(a.pixels.data, rgba8().data)).toBeNull();
    expect(a.metadata.hasSemiTransparency).toBe(true);
    const b = await png.decode(await fixtureBytes('rgba16.png'));
    expect(b.pixels.bitDepth).toBe(16);
    expect(firstMismatch(b.pixels.data, rgba16().data)).toBeNull();
    const c = await png.decode(await fixtureBytes('rgb16.png'));
    expect(firstMismatch(c.pixels.data, rasterFrom(P.RGB16, (x, y) => P.rgb16Pixel(x, y), 16).data)).toBeNull();
  });
  it('webp/avif: the lossless fixtures decode to the exact pattern; jxl is within 1', async () => {
    for (const [name, file] of [['webp', 'rgba-partial.webp'], ['avif', 'rgba-partial.avif']] as const) {
      const img = await (await codecs[name]!).decode(await fixtureBytes(file));
      expect(firstMismatch(img.pixels.data, rgba8().data), file).toBeNull();
      expect(img.metadata.hasAlpha, file).toBe(true);
    }
    const jxl = await (await codecs.jxl!).decode(await fixtureBytes('rgba-partial.jxl'));
    expect(maxChannelDiff(jxl.pixels.data, rgba8().data)).toBeLessThanOrEqual(1);
    expect(jxl.metadata.hasAlpha).toBe(true);
  });
  it('jpeg: exif-gps.jpg decodes with metadata; orientation left to the pipeline', async () => {
    const jpeg = await codecs.jpeg!;
    const img = await jpeg.decode(await fixtureBytes('exif-orient6.jpg'));
    expect([img.pixels.width, img.pixels.height]).toEqual([48, 32]);
    expect(img.metadata.orientation).toBe(6);
    expect(img.metadata.orientationApplied).toBeUndefined();
    expect(img.metadata.hasGps).toBe(true);
  });
  it('tiff: fixtures decode exact and the writer output is readable by image-js in the browser too', async () => {
    const tiff = await codecs.tiff!;
    const img = await tiff.decode(await fixtureBytes('rgba-partial.tif'));
    expect(firstMismatch(img.pixels.data, rgba8().data)).toBeNull();
    const bytes = await tiff.encode(img, { lossless: true });
    const p = decodeImageJs(bytes)[0]!;
    expect(p.associatedAlpha).toBe(false);
    expect(firstMismatch(p.data, rgba8().data)).toBeNull();
  });
});

describe('lossy paths are honestly lossy', () => {
  for (const name of ['webp', 'avif', 'jxl'] as const) {
    it(`${name} lossy at 0.8 changes pixels`, async () => {
      const codec = await codecs[name]!;
      const src = rasterFrom(P.RGB8, (x, y) => P.rgb8Pixel(x, y, P.lcg(1)));
      const back = await codec.decode(await codec.encode(asImage(src, { hasAlpha: false, hasTransparency: false, hasSemiTransparency: false }), { lossless: false, quality: 0.8 }));
      expect(maxChannelDiff(src.data, back.pixels.data)).toBeGreaterThan(0);
    });
  }
  it('jpeg refuses alpha input', async () => {
    const jpeg = await codecs.jpeg!;
    await expect(jpeg.encode(asImage(rgba8()), { quality: 0.9 })).rejects.toThrow(/flatten/i);
  });
});

describe('canvas fallback cross-check', () => {
  it('canvas decodes wasm-encoded PNG/WebP with identical opaque pixels', async () => {
    const src = rasterFrom(P.RGB8, (x, y) => P.rgb8Pixel(x, y, P.lcg(1)));
    for (const name of ['png', 'webp'] as const) {
      const bytes = await (await codecs[name]!).encode(asImage(src, { hasAlpha: false, hasTransparency: false, hasSemiTransparency: false }), { lossless: true });
      const cv = await createCanvasCodec(name).decode(bytes);
      expect(firstMismatch(convertBitDepth(cv.pixels, 8).data, src.data), name).toBeNull();
    }
  });
});
