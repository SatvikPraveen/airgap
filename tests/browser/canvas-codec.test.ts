/**
 * Canvas fallback codec, under the Phase 3 interface. Its declared
 * exactAlpha:false must be borne out by the probe, and its metadata carrying
 * (via the container layer) must work.
 */
import { describe, expect, it } from 'vitest';
import { createCanvasCodec } from '../../src/codecs/canvas';
import { probeCodec } from '../../src/codecs/probe';
import { summarizeExif } from '../../src/metadata/exif';
import { extractMetadata } from '../../src/metadata/containers';
import * as P from '../fixtures/pattern.mjs';
import { firstMismatch, fixtureBytes, maxChannelDiff, rasterFrom } from './helpers';

const png = createCanvasCodec('png');
const jpeg = createCanvasCodec('jpeg');
const webp = createCanvasCodec('webp');

describe('canvas codec declarations vs probe', () => {
  it('declares exactAlpha false and the probe agrees (RGB under alpha 0 is lost)', async () => {
    expect(png.capabilities.exactAlpha).toBe(false);
    const r = await probeCodec(png);
    expect(r.probe.ok).toBe(true);
    expect(r.capabilities.lossless).toBe(true);
    expect(r.capabilities.exactAlpha).toBe(false);
    expect(r.probe.checks['exactAlpha']).toEqual({ claimed: false, verified: false });
    expect(r.capabilities.metadata).toEqual({ exif: true, icc: true, xmp: true });
  });
  it('WebP: lossless verified in Chromium at quality 1', async () => {
    const r = await probeCodec(webp);
    expect(r.capabilities.lossless).toBe(true);
    expect(r.capabilities.exactAlpha).toBe(false);
  });
  it('JPEG: lossy-only, no alpha', async () => {
    const r = await probeCodec(jpeg);
    expect(r.capabilities.lossless).toBe(false);
    expect(r.capabilities.alpha).toBe(false);
  });
});

describe('canvas decode', () => {
  it('rgb8.png decodes to exactly the generated pattern', async () => {
    const img = await png.decode(await fixtureBytes('rgb8.png'));
    const noise = P.lcg(1);
    expect(firstMismatch(img.pixels.data, rasterFrom(P.RGB8, (x, y) => P.rgb8Pixel(x, y, noise)).data)).toBeNull();
  });
  it('does NOT apply EXIF orientation itself (pipeline does), even though Chromium ignores imageOrientation:none', async () => {
    const img = await jpeg.decode(await fixtureBytes('exif-orient6.jpg'));
    expect([img.pixels.width, img.pixels.height]).toEqual([48, 32]);
    expect(img.metadata.orientation).toBe(6);
    expect(img.metadata.orientationApplied).toBeUndefined();
    expect(summarizeExif(img.metadata.exif!).orientation).toBe(6); // payload still carried
  });
  it('carries EXIF and ICC payloads out of the container', async () => {
    const img = await jpeg.decode(await fixtureBytes('exif-gps.jpg'));
    expect(summarizeExif(img.metadata.exif!).hasGps).toBe(true);
    const p3 = await png.decode(await fixtureBytes('icc-p3.png'));
    expect(p3.metadata.iccKind).toBe('matrix');
    expect(p3.metadata.iccDescription).toBe('Display P3 (fixture)');
  });
});

describe('canvas encode + container metadata', () => {
  it('PNG -> PNG opaque round trip is exact; alpha-0 RGB is lost (documented)', async () => {
    const a = await png.decode(await fixtureBytes('rgba-partial.png'));
    const b = await png.decode(await png.encode(a, { lossless: true }));
    expect(maxChannelDiff(a.pixels.data, b.pixels.data)).toBe(0); // stable after the first pass
    const noise = P.lcg(2);
    const truth = rasterFrom(P.RGBA_PARTIAL, (x, y) => P.rgbaPixel(x, y, noise));
    expect(maxChannelDiff(truth.data, a.pixels.data)).toBeGreaterThan(0); // the decode already lost it
  });
  it('embeds EXIF into a canvas-encoded JPEG/PNG/WebP', async () => {
    const src = await jpeg.decode(await fixtureBytes('exif-gps.jpg'));
    for (const c of [png, jpeg, webp]) {
      const out = await c.encode(src, { lossless: c.format !== 'jpeg', quality: 0.9, exif: src.metadata.exif! });
      const back = extractMetadata(out, c.format);
      expect(summarizeExif(back.exif!).make, c.id).toBe('Airgap Fixtures');
    }
  });
});
