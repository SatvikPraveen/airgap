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

/** Independent tag parse. exifr reads neither WebP nor JPEG XL, so their EXIF blocks are handed to it as a bare TIFF. */
async function tags(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const opts = { tiff: true, gps: true, exif: true, ifd0: true, translateKeys: true, translateValues: false, reviveValues: false, sanitize: false, mergeOutput: true };
  const format = inspect(bytes).format;
  const input = format === 'webp' || format === 'jxl' ? extractMetadata(bytes, format).exif! : bytes;
  const r = (await exifr.parse(input.slice().buffer, opts as never)) as Record<string, unknown> | undefined;
  return r ?? {};
}

describe('registry resolution', () => {
  it('prefers the wasm codec for every format and keeps canvas as the fallback for png/jpeg/webp', async () => {
    expect((await registry.resolve('png', 'decode')).resolved.codecId).toBe('airgap-png');
    expect((await registry.resolve('png', 'encode')).resolved.codecId).toBe('airgap-png');
    for (const f of ['jpeg', 'webp'] as const) expect((await registry.resolve(f, 'decode')).resolved.codecId).toBe(`wasm-${f}`);
    expect((await registry.resolve('avif', 'decode')).resolved.codecId).toBe('libavif');
    // JPEG XL: jxl-oxide reads and verifies, libjxl encodes.
    expect((await registry.resolve('jxl', 'decode')).resolved.codecId).toBe('jxl-oxide');
    expect((await registry.resolve('jxl', 'encode')).resolved.codecId).toBe('libjxl');
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
  it('AVIF cannot carry EXIF (preserve reports removed); JPEG XL now carries EXIF and XMP as boxes, read back exactly', async () => {
    const a = await run('exif-gps.jpg', { format: 'avif', metadataMode: 'preserve' });
    expect(a.result.verification.metadata.exif).toBe('removed');
    expect(a.result.verification.metadataOk).toBe(true);
    const j = await run('exif-gps.jpg', { format: 'jxl', metadataMode: 'preserve' });
    expect(j.result.verification.metadata.exif).toBe('kept');
    expect(j.result.verification.metadata.gps).toBe('kept');
    const t = (await tags(j.result.bytes))!;
    expect(t['Make']).toBe('Airgap Fixtures');
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
  it('convert-srgb on an evaluable LUT profile converts; one it cannot evaluate is refused', async () => {
    const r = await run('icc-lut.jpg', { format: 'png', iccMode: 'convert-srgb' });
    expect(r.result.verification.comparedAgainstConverted).toBe(true);
    expect(r.result.verification.metadata.icc).toBe('removed');
    await expect(run('icc-lut-btoa.jpg', { format: 'png', iccMode: 'convert-srgb' })).rejects.toThrow(/BtoA only/);
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
  it('rgba-partial.png -> JPEG XL lossless is verified identical by jxl-oxide, full RGBA, alpha-0 colour included', async () => {
    const r = await run('rgba-partial.png', { format: 'jxl' });
    const enc = registry.table().jxl?.encode?.capabilities;
    expect(enc?.lossless).toBe(true);
    expect(enc?.exactAlpha).toBe(true);
    expect(enc?.decodeExact).toBe(true); // libjxl 0.12's own decoder is exact too (the 2022 one was not)
    expect(r.result.verification.verifierId).toBe('jxl-oxide');
    expect(r.result.verification.identical).toBe(true);
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

describe('APNG through the real codecs and pipeline', () => {
  it('the airgap-png probe demonstrates animation (frames, delays, loops)', async () => {
    const enc = await registry.resolve('png', 'encode');
    expect(enc.resolved.capabilities.animation, enc.resolved.probe.detail).toBe(true);
    expect(enc.resolved.probe.detail).toMatch(/animation round trip exact/);
  });
  it('apng-ops.png -> PNG keeps every frame, delay and the loop count, verified frame by frame', async () => {
    const r = await run('apng-ops.png', { format: 'png' });
    expect(r.src.animation?.frames).toHaveLength(4);
    expect(r.result.verification.animation).toEqual({ frames: 4, framesIdentical: 4, timingKept: true, loopsKept: true });
    expect(r.result.verification.identical).toBe(true);
    const back = await (await registry.resolve('png', 'decode')).codec.decode(r.result.bytes);
    expect(back.animation?.loops).toBe(3);
  });
  it('apng-hidden.png -> PNG keeps the separate still image and both frames', async () => {
    const r = await run('apng-hidden.png', { format: 'png' });
    expect(r.result.verification.animation).toMatchObject({ frames: 2, framesIdentical: 2 });
    const back = await (await registry.resolve('png', 'decode')).codec.decode(r.result.bytes);
    expect(back.animation?.hiddenDefault).toBe(true);
    expect(Array.from(back.pixels.data.slice(0, 4))).toEqual([200, 200, 200, 255]);
  });
  it('apng-ops.png -> TIFF converts the still image only (no animation verification)', async () => {
    const r = await run('apng-ops.png', { format: 'tiff' });
    expect(r.result.verification.animation).toBeUndefined();
  });
  it('a crop applies to every frame', async () => {
    const bytes = await fixtureBytes('apng-ops.png');
    const { image, used } = await registry.decode('png', bytes);
    const enc = await registry.resolve('png', 'encode');
    const res = await convert(
      { encoder: enc.codec, encoderCaps: enc.resolved.capabilities, decoderCaps: used.resolved.capabilities, verifier: enc.codec },
      image,
      'png',
      { target: { format: 'png', lossless: true, ...DEFAULT_MODES }, transform: { rotate: 90, flipH: false, flipV: false, crop: { x: 2, y: 2, width: 20, height: 12 } } },
    );
    expect([res.width, res.height]).toEqual([12, 20]);
    expect(res.verification.animation).toEqual({ frames: 4, framesIdentical: 4, timingKept: true, loopsKept: true });
  });
  it("the engine's own APNG decoder (ImageDecoder, where available) composites the same frames", async (ctx) => {
    const ID = (globalThis as unknown as { ImageDecoder?: new (init: object) => { tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }; decode(o: object): Promise<{ image: VideoFrame }> } }).ImageDecoder;
    if (!ID) return ctx.skip();
    const bytes = await fixtureBytes('apng-ops.png');
    const ours = (await registry.decode('png', bytes)).image.animation!;
    const dec = new ID({ data: bytes, type: 'image/png', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    await dec.tracks.ready;
    expect(dec.tracks.selectedTrack?.frameCount).toBe(4);
    const pixelsOf = async (i: number) => {
      const { image } = await dec.decode({ frameIndex: i });
      const c = new OffscreenCanvas(32, 24);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(image, 0, 0);
      image.close();
      return g.getImageData(0, 0, 32, 24).data;
    };
    // Some engines' ImageDecoder output drops alpha altogether (measured: WebKit). Frame 0 is a plain
    // SOURCE frame with a semi-transparent band, so it shows whether alpha survives the display path.
    const decoded: Uint8ClampedArray[] = [];
    for (let i = 0; i < 4; i++) decoded.push(await pixelsOf(i)); // each frame once (Firefox refuses repeats)
    const band = (9 * 32 + 3) * 4 + 3;
    if (decoded[0]![band] !== 100) return ctx.skip('ImageDecoder frames lose alpha in this engine');
    for (let i = 0; i < 4; i++) {
      const d = decoded[i]!;
      const o = ours.frames[i]!.pixels.data;
      for (let k = 0; k < d.length; k += 4) {
        // The canvas stores 8-bit premultiplied colour: alpha and opaque pixels are exact; a
        // semi-transparent channel can be off by one premultiplied step, about 255 / alpha.
        expect(d[k + 3], `frame ${i} alpha @${k / 4}`).toBe(o[k + 3]);
        const a = o[k + 3]!;
        const tol = a === 255 ? 0 : a === 0 ? 255 : Math.ceil(255 / a);
        for (let c2 = 0; c2 < 3; c2++) expect(Math.abs(d[k + c2]! - o[k + c2]!), `frame ${i} ch${c2} @${k / 4}`).toBeLessThanOrEqual(tol);
      }
    }
  });
});

describe('animated WebP through the real codecs and pipeline', () => {
  it('the wasm-webp probe demonstrates animation', async () => {
    const enc = await registry.resolve('webp', 'encode');
    expect(enc.resolved.capabilities.animation, enc.resolved.probe.detail).toBe(true);
  });
  it('webp-ops.webp -> PNG becomes an APNG with every frame, duration and the loop count verified', async () => {
    const r = await run('webp-ops.webp', { format: 'png' });
    expect(r.src.animation?.frames).toHaveLength(4);
    expect(r.result.verification.animation).toEqual({ frames: 4, framesIdentical: 4, timingKept: true, loopsKept: true });
  });
  it('apng-ops.png -> WebP lossless keeps every frame exactly; -> WebP lossy keeps the animation and measures the loss', async () => {
    const lossless = await run('apng-ops.png', { format: 'webp' });
    expect(lossless.result.verification.animation).toEqual({ frames: 4, framesIdentical: 4, timingKept: true, loopsKept: true });
    const lossy = await run('apng-ops.png', { format: 'webp', lossless: false }, { quality: 0.6 });
    expect(lossy.result.verification.animation).toMatchObject({ frames: 4, timingKept: true, loopsKept: true });
    expect(lossy.result.verification.identical).toBe(false);
  });
  it("the engine's own animated WebP decoder (ImageDecoder) agrees, within the canvas's premultiplied precision", async (ctx) => {
    const ID = (globalThis as unknown as { ImageDecoder?: new (init: object) => { tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }; decode(o: object): Promise<{ image: VideoFrame }> } }).ImageDecoder;
    if (!ID) return ctx.skip();
    const bytes = await fixtureBytes('webp-libwebp.webp');
    const ours = (await registry.decode('webp', bytes)).image.animation!;
    const dec = new ID({ data: bytes, type: 'image/webp', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    await dec.tracks.ready;
    const n = dec.tracks.selectedTrack?.frameCount ?? 0;
    expect(n).toBe(ours.frames.length);
    const { width, height } = ours.frames[0]!.pixels;
    const decoded: Uint8ClampedArray[] = [];
    for (let i = 0; i < n; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const c = new OffscreenCanvas(width, height);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(image, 0, 0);
      image.close();
      decoded.push(g.getImageData(0, 0, width, height).data);
    }
    // Calibrate on frame 0, a plain still frame with no compositing (Airgap's frame 0 equals libwebp's
    // exactly, see tests/unit/webp-anim.test.ts): an engine whose ImageDecoder-to-canvas path cannot
    // reproduce that within its premultiplied precision says nothing about animation, so it is skipped.
    // Measured: WebKit on macOS drops alpha; WebKit on Linux shifts semi-transparent colour by up to 18.
    const tolFor = (a: number) => (a === 255 ? 0 : a === 0 ? 255 : Math.ceil(255 / a));
    const f0 = ours.frames[0]!.pixels.data;
    const d0 = decoded[0]!;
    for (let k = 0; k < d0.length; k += 4) {
      const off = d0[k + 3] !== f0[k + 3] || [0, 1, 2].some((ch) => Math.abs(d0[k + ch]! - f0[k + ch]!) > tolFor(f0[k + 3]!));
      if (off) return ctx.skip("this engine's ImageDecoder output does not reproduce even a still frame precisely");
    }
    decoded.forEach((d, i) => {
      const o = ours.frames[i]!.pixels.data;
      for (let k = 0; k < d.length; k += 4) {
        expect(d[k + 3], `frame ${i} alpha @${k / 4}`).toBe(o[k + 3]);
        const tol = tolFor(o[k + 3]!);
        for (let ch = 0; ch < 3; ch++) expect(Math.abs(d[k + ch]! - o[k + ch]!), `frame ${i} ch${ch} @${k / 4}`).toBeLessThanOrEqual(tol);
      }
    });
  });
});

describe('JPEG recompression and animated AVIF through the real pipeline', () => {
  async function recompress(file: string, metadataMode: TargetSpec['metadataMode']) {
    const { recompressJpeg } = await import('../../src/convert');
    const lib = await import('../../src/codecs/wasm/libjxl');
    const m = await lib.loadLibjxl();
    const bytes = await fixtureBytes(file);
    const { image } = await registry.decode('jpeg', bytes);
    const enc = await registry.resolve('jxl', 'encode');
    const ver = await registry.resolve('jxl', 'decode');
    const r = await recompressJpeg(
      { encoder: enc.codec, encoderCaps: enc.resolved.capabilities, decoderCaps: ver.resolved.capabilities, verifier: ver.codec, transcoder: { id: 'libjxl', toJxl: async (b) => lib.jpegToJxl(m, b), toJpeg: async (b) => lib.jxlToJpeg(m, b) } },
      prepareSource(image),
      bytes,
      { target: { format: 'jxl', lossless: true, metadataMode, iccMode: 'preserve', jpegRecompression: true } },
    );
    return { r, bytes, rebuilt: lib.jxlToJpeg(m, r.bytes)! };
  }
  it('exif-orient6.jpg, preserve: the rebuilt JPEG is the original file byte for byte; decoded upright like the source', async () => {
    const { r, bytes, rebuilt } = await recompress('exif-orient6.jpg', 'preserve');
    expect(r.verification.reconstruction).toEqual({ identical: true, jpegBytes: bytes.length });
    expect(Array.from(rebuilt)).toEqual(Array.from(bytes));
    expect([r.width, r.height]).toEqual([32, 48]);
    expect(r.verification.metadata.exif).toBe('kept');
  });
  it('location-everywhere.jpg, strip GPS only: rebuilt JPEG equals the GPS-cleaned JPEG and holds no coordinates', async () => {
    const { r, rebuilt } = await recompress('location-everywhere.jpg', 'strip-gps');
    expect(r.verification.reconstruction?.identical).toBe(true);
    expect(P.findLocationNeedles(rebuilt)).toEqual([]);
    expect(P.findLocationNeedles(r.bytes)).toEqual([]);
    expect(r.verification.metadata.gps).toBe('removed');
  });
  it('the libavif probe demonstrates animation', async () => {
    const enc = await registry.resolve('avif', 'encode');
    expect(enc.resolved.capabilities.animation, enc.resolved.probe.detail).toBe(true);
  });
  it('apng-ops.png -> AVIF lossless sequence: every frame exact, delays kept (the zero delay planned as 1 ms), loops kept', async () => {
    const r = await run('apng-ops.png', { format: 'avif' });
    expect(r.result.verification.animation).toEqual({ frames: 4, framesIdentical: 4, timingKept: true, loopsKept: true });
    const back = await (await registry.resolve('avif', 'decode')).codec.decode(r.result.bytes);
    expect(back.animation?.frames.map((f) => (1000 * f.delayNum) / f.delayDen)).toEqual([100, 70, 250, 1]);
    expect(back.animation?.loops).toBe(3);
  });
  it('webp-libwebp.webp -> AVIF -> APNG round trip keeps every frame', async () => {
    const a = await run('webp-libwebp.webp', { format: 'avif' });
    expect(a.result.verification.animation?.framesIdentical).toBe(a.result.verification.animation?.frames);
  });
  it("the engine's own animated AVIF decoder (ImageDecoder), where it can read sequences, shows the same frames", async (ctx) => {
    const ID = (globalThis as unknown as { ImageDecoder?: { isTypeSupported(t: string): Promise<boolean>; new (init: object): { tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }; decode(o: object): Promise<{ image: VideoFrame }> } } }).ImageDecoder;
    if (!ID || !(await ID.isTypeSupported('image/avif'))) return ctx.skip('no ImageDecoder for AVIF in this engine');
    const r = await run('apng-ops.png', { format: 'avif' });
    const frames = (await (await registry.resolve('avif', 'decode')).codec.decode(r.result.bytes)).animation!.frames;
    const dec = new ID({ data: r.result.bytes, type: 'image/avif', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    await dec.tracks.ready;
    if ((dec.tracks.selectedTrack?.frameCount ?? 0) !== 4) return ctx.skip('this engine reads AVIF sequences as stills');
    const decoded: Uint8ClampedArray[] = [];
    for (let i = 0; i < 4; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const c = new OffscreenCanvas(32, 24);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(image, 0, 0);
      image.close();
      decoded.push(g.getImageData(0, 0, 32, 24).data);
    }
    const tolFor = (a: number) => (a === 255 ? 0 : a === 0 ? 255 : Math.ceil(255 / a));
    const f0 = frames[0]!.pixels.data;
    for (let k = 0; k < f0.length; k += 4) {
      if (decoded[0]![k + 3] !== f0[k + 3] || [0, 1, 2].some((ch) => Math.abs(decoded[0]![k + ch]! - f0[k + ch]!) > tolFor(f0[k + 3]!))) return ctx.skip("this engine's ImageDecoder output does not reproduce even a still frame precisely");
    }
    decoded.forEach((d, i) => {
      const o = frames[i]!.pixels.data;
      for (let k = 0; k < d.length; k += 4) {
        expect(d[k + 3], `frame ${i} alpha`).toBe(o[k + 3]);
        for (let ch = 0; ch < 3; ch++) expect(Math.abs(d[k + ch]! - o[k + ch]!)).toBeLessThanOrEqual(tolFor(o[k + 3]!));
      }
    });
  });
});

describe('HEIC, read through the platform decoder (Airgap ships no HEVC code)', () => {
  const { viaWebCodecs, HEIC_UNAVAILABLE } = await_import();
  function await_import() {
    return { viaWebCodecs: (b: Uint8Array) => import('../../src/codecs/heic').then((m) => m.viaWebCodecs(b)), HEIC_UNAVAILABLE: import('../../src/codecs/heic').then((m) => m.HEIC_UNAVAILABLE) };
  }
  async function reference(name: string) {
    const { PNG_DECODE } = { PNG_DECODE: (await registry.resolve('png', 'decode')).codec };
    return (await PNG_DECODE.decode(await fixtureBytes(name))).pixels;
  }
  const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>, skipAlpha = false) => {
    let m = 0;
    for (let i = 0; i < a.length; i++) if (!(skipAlpha && i % 4 === 3)) m = Math.max(m, Math.abs(a[i]! - b[i]!));
    return m;
  };
  // Measured against Apple's own decode (sips): Airgap's WebCodecs path is within 4 levels (Chrome
  // mean 0.4, Safari mean 1.2); Safari's image decoder within 8 (it upsamples chroma differently).
  // HEVC decoders may legitimately differ this much; the loss list says HEIC is decoder-unverified.
  const TOL = 8;
  it('rgb8.heic: decoded by this engine (or refused with the reason), within 8 levels of Apple\'s own decode', async (ctx) => {
    const reg = new CodecRegistry();
    let decoded;
    try {
      decoded = await reg.decode('heic', await fixtureBytes('rgb8.heic'));
    } catch (err) {
      expect((err as Error).message).toContain(await HEIC_UNAVAILABLE);
      return ctx.skip('no platform HEIC decoder in this engine (refused with the stated reason)');
    }
    expect([decoded.image.pixels.width, decoded.image.pixels.height]).toEqual([64, 48]);
    expect(decoded.used.resolved.capabilities.decodeExact).toBe(false);
    expect(maxDiff(decoded.image.pixels.data, (await reference('rgb8.heic.apple.png')).data, true)).toBeLessThanOrEqual(TOL);
  });
  it('rgba-partial.heic: the alpha plane is applied (within 8 levels of Apple\'s decode, alpha included)', async (ctx) => {
    let px;
    try {
      px = (await new CodecRegistry().decode('heic', await fixtureBytes('rgba-partial.heic'))).image.pixels;
    } catch {
      return ctx.skip('no platform HEIC decoder in this engine');
    }
    const ref = await reference('rgba-partial.heic.apple.png');
    // Compare where alpha is high enough that premultiplied canvas rounding cannot dominate.
    let worst = 0;
    for (let i = 0; i < ref.data.length; i += 4) {
      worst = Math.max(worst, Math.abs(px.data[i + 3]! - ref.data[i + 3]!));
      if (ref.data[i + 3]! >= 128) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(px.data[i + c]! - ref.data[i + c]!));
    }
    expect(worst).toBeLessThanOrEqual(TOL);
  });
  it('WebCodecs path (Airgap reads the HEIF grid, the platform decodes each HEVC tile): grid.heic tiles land in place', async (ctx) => {
    const ok = typeof VideoDecoder !== 'undefined' && (await VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L93.B0' })).supported;
    if (!ok) return ctx.skip('no HEVC in WebCodecs here');
    const px = await viaWebCodecs(await fixtureBytes('grid.heic'));
    expect([px.width, px.height]).toEqual([1100, 600]);
    const src = await reference('grid.heic.source.png');
    // Lossy HEVC: mean error small everywhere, and each tile's colour band where it belongs.
    let sum = 0;
    for (let i = 0; i < src.data.length; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(px.data[i + c]! - src.data[i + c]!);
    expect(sum / (1100 * 600 * 3)).toBeLessThan(3); // lossy HEVC against the original source
    for (const [x, y] of [[100, 100], [700, 100], [1050, 550], [600, 560]]) {
      const i = (y! * 1100 + x!) * 4;
      expect(Math.abs(px.data[i + 2]! - src.data[i + 2]!), `tile colour at ${x},${y}`).toBeLessThanOrEqual(8);
    }
  });
  it('both paths agree where both exist (Safari): WebCodecs + Airgap HEIF vs the browser image decoder', async (ctx) => {
    let image;
    try {
      const bmp = await createImageBitmap(new Blob([(await fixtureBytes('rgba-partial.heic')) as BlobPart], { type: 'image/heic' }));
      bmp.close();
      image = true;
    } catch {
      image = false;
    }
    const wc = typeof VideoDecoder !== 'undefined' && (await VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L93.B0' })).supported;
    if (!image || !wc) return ctx.skip('this engine has at most one of the two paths');
    const a = (await new CodecRegistry().decode('heic', await fixtureBytes('rgba-partial.heic'))).image.pixels; // image decoder first
    const b = await viaWebCodecs(await fixtureBytes('rgba-partial.heic'));
    let worst = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      worst = Math.max(worst, Math.abs(a.data[i + 3]! - b.data[i + 3]!));
      if (a.data[i + 3]! >= 128) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a.data[i + c]! - b.data[i + c]!));
    }
    expect(worst).toBeLessThanOrEqual(TOL);
  });
  it('WebCodecs path vs Apple\'s decode: within 4 levels (Airgap converts YUV itself, matrix from the HEIF colr, range from the frame)', async (ctx) => {
    const ok = typeof VideoDecoder !== 'undefined' && (await VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L93.B0' })).supported;
    if (!ok) return ctx.skip('no HEVC in WebCodecs here');
    for (const name of ['rgb8', 'rgba-partial']) {
      const px = await viaWebCodecs(await fixtureBytes(`${name}.heic`));
      expect(maxDiff(px.data, (await reference(`${name}.heic.apple.png`)).data), name).toBeLessThanOrEqual(4);
    }
  });
});
