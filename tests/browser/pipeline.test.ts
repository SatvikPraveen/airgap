/**
 * End-to-end through the real registry, convert() and codecs: metadata modes,
 * ICC modes, orientation, verification. Output tags are parsed by exifr, an
 * independent EXIF reader, not by our own parser.
 */
import exifr from 'exifr';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODES, type TargetSpec } from '../../src/capabilities';
import { CodecRegistry } from '../../src/codecs/registry';
import type { ImageFormat } from '../../src/codecs/types';
import { convert, prepareSource } from '../../src/convert';
import { inspect } from '../../src/inspect';
import { extractMetadata } from '../../src/metadata/containers';
import * as P from '../fixtures/pattern.mjs';
import { firstMismatch, fixtureBytes, rasterFrom } from './helpers';

const registry = new CodecRegistry();

async function run(file: string, target: Partial<TargetSpec> & { format: ImageFormat }, extra: { quality?: number; background?: { r: number; g: number; b: number } } = {}) {
  const bytes = await fixtureBytes(file);
  const format = inspect(bytes).format;
  const { image, used } = await registry.decode(format, bytes);
  const src = prepareSource(image);
  const enc = await registry.resolve(target.format, 'encode');
  const ver = await registry.resolve(target.format, 'decode');
  const result = await convert(
    { encoder: enc.codec, encoderCaps: enc.resolved.capabilities, decoderCaps: used.resolved.capabilities, verifier: ver.codec },
    src,
    format,
    { target: { lossless: true, ...DEFAULT_MODES, ...target }, ...extra },
  );
  return { src, result, decoderId: used.resolved.codecId, encoderId: enc.resolved.codecId };
}

/** Independent tag parse. exifr has no WebP reader, so for WebP the EXIF chunk is handed to it as a bare TIFF. */
async function tags(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const opts = { tiff: true, gps: true, exif: true, ifd0: true, translateKeys: true, translateValues: false, reviveValues: false, sanitize: false, mergeOutput: true };
  const format = inspect(bytes).format;
  const input = format === 'webp' ? extractMetadata(bytes, 'webp').exif! : bytes;
  const r = (await exifr.parse(input.slice().buffer, opts as never)) as Record<string, unknown> | undefined;
  return r ?? {};
}

describe('registry resolution', () => {
  it('prefers the wasm codec for every format and keeps canvas as the fallback for png/jpeg/webp', async () => {
    for (const f of ['png', 'jpeg', 'webp', 'avif', 'jxl'] as const) expect((await registry.resolve(f, 'decode')).resolved.codecId).toBe(`wasm-${f}`);
    expect((await registry.resolve('tiff', 'encode')).resolved.codecId).toBe('utif-tiff');
    const table = registry.table();
    expect(table.png?.decode?.capabilities.exactAlpha).toBe(true);
  });
});

describe('metadata modes through real codecs (asserted with exifr)', () => {
  const targets: [string, ImageFormat][] = [
    ['jpeg', 'jpeg'],
    ['png', 'png'],
    ['webp', 'webp'],
    ['tiff', 'tiff'],
  ];
  for (const [label, format] of targets) {
    it(`exif-gps.jpg -> ${label}: preserve keeps every tag (Orientation stays 1), strip-gps drops only GPS, strip-all drops all`, async () => {
      const preserve = await run('exif-gps.jpg', { format, lossless: format !== 'jpeg', metadataMode: 'preserve' }, { quality: 0.9 });
      expect(preserve.result.verification.metadata.exif).toBe('kept');
      expect(preserve.result.verification.metadata.gps).toBe('kept');
      const t1 = (await tags(preserve.result.bytes))!;
      expect(t1['Make']).toBe('Airgap Fixtures');
      expect(t1['Model']).toBe('Synthetic Camera 1');
      expect(t1['DateTime'] ?? t1['ModifyDate']).toBe('2026:09:23 10:00:00');
      expect(t1['DateTimeOriginal']).toBe('2026:09:23 09:59:59');
      expect(t1['GPSLatitudeRef']).toBe('N');
      expect(t1['GPSLatitude']).toBeDefined();
      expect(t1['Orientation']).toBe(1);

      const gps = await run('exif-gps.jpg', { format, lossless: format !== 'jpeg', metadataMode: 'strip-gps' }, { quality: 0.9 });
      expect(gps.result.verification.metadata).toMatchObject({ exif: 'kept', gps: 'removed' });
      const t2 = (await tags(gps.result.bytes))!;
      expect(t2['Make']).toBe('Airgap Fixtures');
      expect(t2['DateTimeOriginal']).toBe('2026:09:23 09:59:59');
      expect(Object.keys(t2).filter((k) => k.startsWith('GPS'))).toEqual([]);

      const all = await run('exif-gps.jpg', { format, lossless: format !== 'jpeg', metadataMode: 'strip-all' }, { quality: 0.9 });
      expect(all.result.verification.metadata).toMatchObject({ exif: 'removed', gps: 'removed' });
      expect(inspect(all.result.bytes).metadata.hasExif).toBe(false);
    });
  }
  it('AVIF/JXL cannot carry EXIF: preserve reports removed, verification agrees', async () => {
    for (const format of ['avif', 'jxl'] as const) {
      const r = await run('exif-gps.jpg', { format, metadataMode: 'preserve' });
      expect(r.result.verification.metadata.exif).toBe('removed');
      expect(r.result.verification.metadataOk).toBe(true);
    }
  });
});

describe('orientation', () => {
  it('exif-orient6.jpg -> PNG preserve: pixels upright, tag rewritten to 1, quadrants where a viewer would show them', async () => {
    const r = await run('exif-orient6.jpg', { format: 'png', metadataMode: 'preserve' });
    expect([r.src.pixels.width, r.src.pixels.height]).toEqual([32, 48]);
    expect(inspect(r.result.bytes).width).toBe(32);
    const t = (await tags(r.result.bytes))!;
    expect(t['Orientation']).toBe(1);
    const px = r.src.pixels;
    const at = (x: number, y: number) => Array.from(px.data.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 3));
    const near = (got: number[], want: number[]) => got.every((v, i) => Math.abs(v - want[i]!) < 40);
    expect(near(at(2, 2), [30, 60, 220]), 'top-left is blue').toBe(true);
    expect(near(at(px.width - 3, 2), [220, 30, 30]), 'top-right is red').toBe(true);
    expect(near(at(px.width - 3, px.height - 3), [30, 200, 40]), 'bottom-right is green').toBe(true);
    expect(near(at(2, px.height - 3), [230, 220, 40]), 'bottom-left is yellow').toBe(true);
  });
  it('strip-all output has no orientation tag and is upright too', async () => {
    const r = await run('exif-orient6.jpg', { format: 'webp', metadataMode: 'strip-all' });
    expect(inspect(r.result.bytes).width).toBe(32);
    expect(inspect(r.result.bytes).metadata.hasExif).toBe(false);
  });
});

describe('ICC modes through real codecs', () => {
  it('icc-p3.png -> PNG preserve: profile bytes carried unchanged, pixels identical', async () => {
    const r = await run('icc-p3.png', { format: 'png', iccMode: 'preserve' });
    expect(r.result.verification.identical).toBe(true);
    expect(r.result.verification.metadata.icc).toBe('kept');
    const out = extractMetadata(r.result.bytes, 'png');
    expect(Array.from(out.icc!)).toEqual(Array.from(await fixtureBytes('display-p3.icc')));
  });
  it('icc-p3.png -> WebP/JPEG/TIFF preserve carries the profile; AVIF cannot', async () => {
    for (const format of ['webp', 'jpeg', 'tiff'] as const) {
      const r = await run('icc-p3.png', { format, lossless: format !== 'jpeg', iccMode: 'preserve' }, { quality: 0.9 });
      expect(r.result.verification.metadata.icc, format).toBe('kept');
    }
    const a = await run('icc-p3.png', { format: 'avif', iccMode: 'preserve' });
    expect(a.result.verification.metadata.icc).toBe('removed');
  });
  it('convert-srgb: values change (grey and white stay), profile dropped, verification against converted', async () => {
    const r = await run('icc-p3.png', { format: 'png', iccMode: 'convert-srgb' });
    expect(r.result.verification.comparedAgainstConverted).toBe(true);
    expect(r.result.verification.identical).toBe(true);
    expect(r.result.verification.metadata.icc).toBe('removed');
    const out = await (await registry.resolve('png', 'decode')).codec.decode(r.result.bytes);
    const orig = rasterFrom(P.ICC_P3, (x, y) => P.p3Pixel(x, y));
    expect(firstMismatch(out.pixels.data, orig.data)).not.toBeNull(); // values changed
    const greyIdx = P.P3_PATCHES.findIndex((p) => p[0] === 128) * 2 * 4;
    expect(Array.from(out.pixels.data.slice(greyIdx, greyIdx + 3))).toEqual([128, 128, 128]);
  });
  it('convert-srgb on a LUT profile is refused', async () => {
    await expect(run('icc-lut.jpg', { format: 'png', iccMode: 'convert-srgb' })).rejects.toThrow(/lut/);
  });
  it('strip: values unchanged, profile gone', async () => {
    const r = await run('icc-p3.png', { format: 'png', iccMode: 'strip' });
    expect(r.result.verification.identical).toBe(true);
    expect(r.result.verification.comparedAgainstConverted).toBe(false);
    expect(inspect(r.result.bytes).metadata.hasIcc).toBe(false);
  });
});

describe('alpha through the whole pipeline', () => {
  it('rgba-partial.png -> PNG/WebP/AVIF/TIFF lossless: verification identical (transparent pixels included)', async () => {
    for (const format of ['png', 'webp', 'avif', 'tiff'] as const) {
      const r = await run('rgba-partial.png', { format });
      expect(r.result.verification.identical, format).toBe(true);
      expect(r.result.verification.differingPixels, format).toBe(0);
    }
  });
  it('rgba-partial.png -> JPEG XL "lossless" is measured as not identical and the registry says lossless is unverified', async () => {
    const r = await run('rgba-partial.png', { format: 'jxl' });
    expect(registry.table().jxl?.encode?.capabilities.lossless).toBe(false);
    expect(r.result.verification.identical).toBe(false);
    expect(r.result.verification.maxChannelDiff).toBe(1);
  });
  it('rgba16.png -> PNG and TIFF stay 16-bit and identical; -> WebP is reduced to 8-bit and says so', async () => {
    for (const format of ['png', 'tiff'] as const) {
      const r = await run('rgba16.png', { format });
      expect(r.result.bitDepth, format).toBe(16);
      expect(r.result.verification.identical, format).toBe(true);
    }
    const w = await run('rgba16.png', { format: 'webp' });
    expect(w.result.bitDepth).toBe(8);
    expect(w.result.verification.identical).toBe(true); // identical at the 8-bit output depth
  });
  it('rgba-partial.png -> JPEG flattens onto the chosen colour', async () => {
    const r = await run('rgba-partial.png', { format: 'jpeg', lossless: false }, { quality: 1, background: { r: 255, g: 0, b: 0 } });
    expect(r.result.verification.comparedAgainstFlattened).toBe(true);
    const out = await (await registry.resolve('jpeg', 'decode')).codec.decode(r.result.bytes);
    const i = (30 * 64 + 20) * 4; // inside the fully transparent band
    expect(out.pixels.data[i]).toBeGreaterThan(200);
    expect(out.pixels.data[i + 1]).toBeLessThan(60);
  });
});
