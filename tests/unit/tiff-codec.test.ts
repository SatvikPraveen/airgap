/**
 * The TIFF writer is validated against TWO independent readers (utif and
 * image-js `tiff`), never only against our own parser. Fixture TIFFs were
 * written by a third, independent writer in scripts/make-fixtures.mjs.
 */
import { describe, expect, it } from 'vitest';
import UTIF from 'utif';
import { decode as decodeImageJs } from 'tiff';
import { createTiffCodec, encodeTiff } from '../../src/codecs/tiff';
import { inspect } from '../../src/inspect';
import { extractMetadata } from '../../src/metadata/containers';
import { summarizeExif } from '../../src/metadata/exif';
import * as P from '../fixtures/pattern.mjs';
import { fixture, META, rasterFrom } from './helpers';

const codec = createTiffCodec();

function decoded(px: ReturnType<typeof rasterFrom>, hasAlpha: boolean) {
  return { pixels: px, metadata: { ...META, bitDepth: px.bitDepth, hasAlpha, hasTransparency: hasAlpha, hasSemiTransparency: hasAlpha } };
}

describe('TIFF writer validated by independent readers', () => {
  it('8-bit RGBA with straight alpha: image-js reads unassociated alpha and identical samples', () => {
    const noise = P.lcg(2);
    const px = rasterFrom(P.RGBA_PARTIAL, (x, y) => P.rgbaPixel(x, y, noise));
    const bytes = encodeTiff(decoded(px, true), {});
    const pages = decodeImageJs(bytes);
    expect(pages.length).toBe(1);
    const p = pages[0]!;
    expect([p.width, p.height, p.bitsPerSample, p.samplesPerPixel]).toEqual([64, 48, 8, 4]);
    expect(p.alpha).toBe(true);
    expect(p.associatedAlpha, 'ExtraSamples must be 2 (unassociated)').toBe(false);
    expect(Array.from(p.data)).toEqual(Array.from(px.data));
    // utif agrees
    const ifds = UTIF.decode(bytes);
    UTIF.decodeImage(bytes, ifds[0]!, ifds);
    expect(Array.from(UTIF.toRGBA8(ifds[0]!))).toEqual(Array.from(px.data));
  });
  it('8-bit RGB (no alpha): 3 samples per pixel', () => {
    const noise = P.lcg(1);
    const px = rasterFrom(P.RGB8, (x, y) => P.rgb8Pixel(x, y, noise));
    const bytes = encodeTiff(decoded(px, false), {});
    const p = decodeImageJs(bytes)[0]!;
    expect(p.samplesPerPixel).toBe(3);
    expect(p.alpha).toBe(false);
    const rgb: number[] = [];
    for (let i = 0; i < px.data.length; i += 4) rgb.push(px.data[i]!, px.data[i + 1]!, px.data[i + 2]!);
    expect(Array.from(p.data)).toEqual(rgb);
  });
  it('16-bit RGBA: image-js reads Uint16 samples identical to the input', () => {
    const px = rasterFrom(P.RGBA16, (x, y) => P.rgba16Pixel(x, y), 16);
    const bytes = encodeTiff(decoded(px, true), {});
    const p = decodeImageJs(bytes)[0]!;
    expect(p.bitsPerSample).toBe(16);
    expect(p.data).toBeInstanceOf(Uint16Array);
    expect(Array.from(p.data)).toEqual(Array.from(px.data));
  });
  it('embeds EXIF (with GPS sub-IFD), ICC and XMP where both readers and inspect() find them', () => {
    const exif = extractMetadata(fixture('exif-gps.jpg'), 'jpeg').exif!;
    const icc = fixture('display-p3.icc');
    const xmp = new TextEncoder().encode('<x:xmpmeta/>');
    const px = rasterFrom({ width: 4, height: 3 }, () => [1, 2, 3, 255]);
    const bytes = encodeTiff(decoded(px, false), { exif, icc, xmp });
    const h = inspect(bytes).metadata;
    expect([h.hasExif, h.hasGps, h.hasIcc, h.hasXmp]).toEqual([true, true, true, true]);
    const ifd = UTIF.decode(bytes)[0]!;
    expect(ifd.t271, 'Make').toEqual(['Airgap Fixtures']);
    expect(ifd.t34675, 'ICC bytes via utif').toBeDefined();
    expect(Array.from(ifd.t34675 as Uint8Array)).toEqual(Array.from(icc));
    expect(ifd.t34665, 'ExifIFD pointer').toBeDefined();
    expect(ifd.t34853, 'GPS pointer').toBeDefined();
    const p = decodeImageJs(bytes)[0]!;
    expect(p.width).toBe(4);
  });
});

describe('TIFF codec decode (utif) on independently written fixtures', () => {
  it('rgb8.tif decodes to the exact pattern', async () => {
    const img = await codec.decode(fixture('rgb8.tif'));
    const noise = P.lcg(1);
    const want = rasterFrom(P.RGB8, (x, y) => P.rgb8Pixel(x, y, noise));
    expect(img.pixels.bitDepth).toBe(8);
    expect(Array.from(img.pixels.data)).toEqual(Array.from(want.data));
    expect(img.metadata.hasAlpha).toBe(false);
  });
  it('rgba-partial.tif (ExtraSamples=2) decodes exact RGBA including RGB under alpha 0', async () => {
    const img = await codec.decode(fixture('rgba-partial.tif'));
    const noise = P.lcg(2);
    const want = rasterFrom(P.RGBA_PARTIAL, (x, y) => P.rgbaPixel(x, y, noise));
    expect(img.metadata.hasAlpha).toBe(true);
    expect(img.metadata.alphaAssociated).toBeUndefined();
    expect(Array.from(img.pixels.data)).toEqual(Array.from(want.data));
  });
  it('rgb16.tif decodes to exact 16-bit samples', async () => {
    const img = await codec.decode(fixture('rgb16.tif'));
    expect(img.pixels.bitDepth).toBe(16);
    const want = rasterFrom(P.RGB16, (x, y) => P.rgb16Pixel(x, y), 16);
    expect(Array.from(img.pixels.data)).toEqual(Array.from(want.data));
  });
  it('full round trip through the codec is exact and metadata survives', async () => {
    const src = await codec.decode(fixture('rgba-partial.tif'));
    const exif = extractMetadata(fixture('exif-gps.jpg'), 'jpeg').exif!;
    const bytes = await codec.encode(src, { lossless: true, exif });
    const back = await codec.decode(bytes);
    expect(Array.from(back.pixels.data)).toEqual(Array.from(src.pixels.data));
    expect(back.metadata.hasExif).toBe(true);
    expect(summarizeExif(back.metadata.exif!).hasGps).toBe(true);
    expect(summarizeExif(back.metadata.exif!).make).toBe('Airgap Fixtures');
  });
});
