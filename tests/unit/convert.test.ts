/**
 * convert() orchestration with fake codecs: no browser, no canvas. The real
 * encoders are exercised in tests/browser.
 */
import { describe, expect, it } from 'vitest';
import type { Codec, DecodedImage, EncodeOptions, ImageFormat, PixelData } from '../../src/codecs/types';
import { DEFAULT_MODES, type TargetSpec } from '../../src/capabilities';
import { convert, FlattenRequiredError, prepareSource } from '../../src/convert';
import { extractMetadata } from '../../src/metadata/containers';
import { summarizeExif } from '../../src/metadata/exif';
import { probeCodec } from '../../src/codecs/probe';
import { allocate } from '../../src/pixels';
import { caps, canvasCaps, fixture, META, pixelsFrom } from './helpers';

/**
 * A fake "container": [magic 'FAKE', width, height, bitDepth, exifLen, iccLen, xmpLen, payloads..., pixels].
 * Lossy variants perturb the red channel. Alpha-inexact variants zero RGB under alpha 0.
 */
function fakeCodec(format: ImageFormat, opts: { lossyNoise?: number; decodeNoise?: number; zeroUnderAlpha?: boolean; meta?: boolean; depths?: number[]; alpha?: boolean } = {}): Codec & { calls: EncodeOptions[] } {
  const calls: EncodeOptions[] = [];
  const meta = opts.meta ?? true;
  const alpha = opts.alpha ?? true;
  return {
    id: `fake-${format}`,
    format,
    calls,
    capabilities: caps({
      lossless: !opts.lossyNoise,
      alpha,
      exactAlpha: alpha && !opts.zeroUnderAlpha && !opts.lossyNoise,
      encodeBitDepths: opts.depths ?? [8, 16],
      decodeBitDepth: Math.max(...(opts.depths ?? [8, 16])),
      metadata: { exif: meta, icc: meta, xmp: meta },
    }),
    async encode(img, o) {
      calls.push(o);
      const { width, height, bitDepth } = img.pixels;
      if (opts.depths && !opts.depths.includes(bitDepth)) throw new Error(`fake ${format} cannot encode ${bitDepth}-bit`);
      const exif = (meta && o.exif) || new Uint8Array();
      const icc = (meta && o.icc) || new Uint8Array();
      const xmp = (meta && o.xmp) || new Uint8Array();
      const px = new Uint8Array(img.pixels.data.buffer.slice(img.pixels.data.byteOffset, img.pixels.data.byteOffset + img.pixels.data.byteLength));
      const head = new Uint8Array(4 + 6 * 4);
      head.set([0x46, 0x41, 0x4b, 0x45]);
      const dv = new DataView(head.buffer);
      [width, height, bitDepth, exif.length, icc.length, xmp.length].forEach((v, i) => dv.setUint32(4 + i * 4, v));
      const out = new Uint8Array(head.length + exif.length + icc.length + xmp.length + px.length);
      out.set(head, 0);
      out.set(exif, head.length);
      out.set(icc, head.length + exif.length);
      out.set(xmp, head.length + exif.length + icc.length);
      out.set(px, head.length + exif.length + icc.length + xmp.length);
      const step = bitDepth === 8 ? 4 : 8;
      if (opts.lossyNoise || opts.zeroUnderAlpha) {
        const base = head.length + exif.length + icc.length + xmp.length;
        for (let i = base; i < out.length; i += step) {
          if (opts.lossyNoise) out[i] = Math.max(0, out[i]! - opts.lossyNoise);
          if (opts.zeroUnderAlpha && bitDepth === 8 && out[i + 3] === 0) out[i] = out[i + 1] = out[i + 2] = 0;
        }
      }
      return out;
    },
    async decode(bytes) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const [width, height, bitDepth, el, il, xl] = [0, 1, 2, 3, 4, 5].map((i) => dv.getUint32(4 + i * 4)) as [number, number, number, number, number, number];
      let o = 28;
      const exif = bytes.slice(o, o + el);
      o += el;
      const icc = bytes.slice(o, o + il);
      o += il;
      const xmp = bytes.slice(o, o + xl);
      o += xl;
      const px = allocate(width, height, bitDepth);
      const raw = bytes.slice(o);
      (px.data as Uint8ClampedArray | Uint16Array).set(bitDepth === 8 ? raw : new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2));
      if (opts.decodeNoise) for (let i = 0; i < px.data.length; i += 4) px.data[i] = Math.max(0, px.data[i]! - opts.decodeNoise);
      const m: DecodedImage['metadata'] = { ...META, bitDepth, hasAlpha: alpha, hasExif: el > 0, hasIcc: il > 0, hasXmp: xl > 0, hasGps: el > 0 && summarizeExif(exif).hasGps };
      if (el) m.exif = exif;
      if (il) m.icc = icc;
      if (xl) m.xmp = xmp;
      return { pixels: px, metadata: m };
    },
  };
}

// Teach inspect() about the fake container so metadata verification works in these tests.
import * as inspectModule from '../../src/inspect';
import { vi } from 'vitest';
vi.spyOn(inspectModule, 'inspect').mockImplementation((bytes: Uint8Array) => {
  if (!(bytes[0] === 0x46 && bytes[1] === 0x41)) throw new Error('fake inspect: not a fake file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const el = dv.getUint32(16);
  const exif = bytes.slice(28, 28 + el);
  return {
    format: 'png',
    width: dv.getUint32(4),
    height: dv.getUint32(8),
    metadata: { ...META, bitDepth: dv.getUint32(12), hasExif: el > 0, hasGps: el > 0 && summarizeExif(exif).hasGps, hasIcc: dv.getUint32(20) > 0, hasXmp: dv.getUint32(24) > 0 },
  };
});

const img = (px: PixelData, over: Partial<DecodedImage['metadata']> = {}): DecodedImage => ({
  pixels: px,
  metadata: { ...META, bitDepth: px.bitDepth, ...over },
});
const target = (format: ImageFormat, lossless = true, modes: Partial<TargetSpec> = {}): TargetSpec => ({ format, lossless, ...DEFAULT_MODES, ...modes });
const pipe = (encoder: Codec, decoderCaps = caps()) => ({ encoder, encoderCaps: encoder.capabilities, decoderCaps, verifier: encoder });

const EXIF = extractMetadata(fixture('exif-gps.jpg'), 'jpeg').exif!;
const EXIF6 = extractMetadata(fixture('exif-orient6.jpg'), 'jpeg').exif!;
const ICC = fixture('display-p3.icc');
const XMP = new TextEncoder().encode('<xmp/>');

describe('convert(): pixels', () => {
  it('lossless target: verification identical, transparent pixels included', async () => {
    const c = fakeCodec('png');
    const src = img(pixelsFrom([9, 8, 7, 0, 1, 2, 3, 255, 5, 5, 5, 128], 3, 1), { hasAlpha: true, hasTransparency: true, hasSemiTransparency: true });
    const r = await convert(pipe(c), src, 'png', { target: target('png') });
    expect(r.verification.identical).toBe(true);
    expect(r.verification.differingPixels).toBe(0);
    expect(c.calls[0]).toMatchObject({ lossless: true });
    expect(r.bitDepth).toBe(8);
  });
  it('an encoder that zeroes RGB under alpha 0 is caught by verification', async () => {
    const c = fakeCodec('png', { zeroUnderAlpha: true });
    const src = img(pixelsFrom([9, 8, 7, 0, 1, 2, 3, 255], 2, 1), { hasAlpha: true, hasTransparency: true });
    const r = await convert(pipe(c), src, 'png', { target: target('png') });
    expect(r.verification.identical).toBe(false);
    expect(r.verification.differingPixels).toBe(1);
    expect(r.verification.differingVisiblePixels).toBe(0);
  });
  it('lossy target: quality forwarded, damage measured', async () => {
    const c = fakeCodec('jpeg', { lossyNoise: 3, alpha: false });
    const r = await convert(pipe(c), img(pixelsFrom([10, 20, 30, 255], 1, 1)), 'png', { target: target('jpeg', false), quality: 0.42 });
    expect(c.calls[0]).toEqual({ lossless: false, quality: 0.42 });
    expect(r.verification.maxChannelDiff).toBe(3);
  });
  it('16-bit source into a 16-bit encoder stays 16-bit and exact', async () => {
    const c = fakeCodec('png');
    const src = img(pixelsFrom([12345, 999, 31, 65535], 1, 1, 16));
    const r = await convert(pipe(c), src, 'png', { target: target('png') });
    expect(r.bitDepth).toBe(16);
    expect(r.verification.identical).toBe(true);
    expect(r.verification.bitDepth).toBe(16);
  });
  it('16-bit source into an 8-bit encoder is reduced before encoding', async () => {
    const c = fakeCodec('webp', { depths: [8] });
    const src = img(pixelsFrom([12345, 999, 31, 65535], 1, 1, 16));
    const r = await convert(pipe(c), src, 'png', { target: target('webp') });
    expect(r.bitDepth).toBe(8);
    expect(Array.from((await c.decode(r.bytes)).pixels.data)).toEqual([48, 4, 0, 255]);
  });
  it('RGBA -> JPEG without a background is refused loudly', async () => {
    const c = fakeCodec('jpeg', { alpha: false, lossyNoise: 1 });
    await expect(convert(pipe(c), img(pixelsFrom([1, 2, 3, 0], 1, 1), { hasAlpha: true }), 'png', { target: target('jpeg', false) })).rejects.toBeInstanceOf(FlattenRequiredError);
    expect(c.calls).toHaveLength(0);
  });
  it('RGBA -> JPEG with a background flattens first (16-bit too)', async () => {
    const c = fakeCodec('jpeg', { alpha: false, depths: [8, 16] });
    const src = img(pixelsFrom([10, 20, 30, 0, 200, 100, 50, 255, 0, 0, 0, 128], 3, 1), { hasAlpha: true, hasTransparency: true });
    const r = await convert(pipe(c), src, 'png', { target: target('jpeg', false), quality: 1, background: { r: 255, g: 255, b: 255 } });
    expect(r.verification.comparedAgainstFlattened).toBe(true);
    expect(Array.from((await c.decode(r.bytes)).pixels.data)).toEqual([255, 255, 255, 255, 200, 100, 50, 255, 127, 127, 127, 255]);
  });
});

describe('convert(): orientation', () => {
  it('prepareSource rotates once and never twice', () => {
    const src = img(pixelsFrom([1, 0, 0, 255, 2, 0, 0, 255], 2, 1), { orientation: 6 });
    const once = prepareSource(src);
    expect([once.pixels.width, once.pixels.height]).toEqual([1, 2]);
    expect(prepareSource(once)).toBe(once);
    expect(prepareSource(img(pixelsFrom([1, 0, 0, 255], 1, 1), { orientation: 6, orientationApplied: true })).pixels.width).toBe(1);
  });
  it('a carried EXIF has its Orientation rewritten to 1 in preserve and strip-gps modes', async () => {
    for (const metadataMode of ['preserve', 'strip-gps'] as const) {
      const c = fakeCodec('png');
      const src = img(pixelsFrom([1, 2, 3, 255], 1, 1), { hasExif: true, hasGps: true, orientation: 6, exif: EXIF6 });
      const r = await convert(pipe(c), src, 'jpeg', { target: target('png', true, { metadataMode }) });
      const s = summarizeExif(c.calls[0]!.exif!);
      expect(s.orientation).toBe(1);
      expect(s.hasGps).toBe(metadataMode === 'preserve');
      expect(s.make).toBe('Airgap Fixtures');
      expect(r.verification.metadata.exif).toBe('kept');
      expect(r.verification.metadata.gps).toBe(metadataMode === 'preserve' ? 'kept' : 'removed');
      expect(r.verification.metadataOk).toBe(true);
    }
  });
});

describe('convert(): metadata modes', () => {
  const src = () => img(pixelsFrom([1, 2, 3, 255], 1, 1), { hasExif: true, hasGps: true, hasIcc: true, iccKind: 'matrix', hasXmp: true, exif: EXIF, icc: ICC, xmp: XMP });
  it('strip-all + strip ICC: nothing embedded, verification reports removed', async () => {
    const c = fakeCodec('png');
    const r = await convert(pipe(c), src(), 'jpeg', { target: target('png') });
    expect(c.calls[0]!.exif).toBeUndefined();
    expect(c.calls[0]!.icc).toBeUndefined();
    expect(c.calls[0]!.xmp).toBeUndefined();
    expect(r.verification.metadata).toEqual({ exif: 'removed', gps: 'removed', icc: 'removed', xmp: 'removed' });
    expect(r.verification.metadataOk).toBe(true);
  });
  it('preserve + preserve ICC: all three embedded and re-read as kept', async () => {
    const c = fakeCodec('png');
    const r = await convert(pipe(c), src(), 'jpeg', { target: target('png', true, { metadataMode: 'preserve', iccMode: 'preserve' }) });
    expect(summarizeExif(c.calls[0]!.exif!).tagCount).toBe(summarizeExif(EXIF).tagCount);
    expect(Array.from(c.calls[0]!.icc!)).toEqual(Array.from(ICC));
    expect(Array.from(c.calls[0]!.xmp!)).toEqual(Array.from(XMP));
    expect(r.verification.metadata).toEqual({ exif: 'kept', gps: 'kept', icc: 'kept', xmp: 'kept' });
  });
  it('strip-gps: EXIF without GPS, XMP dropped', async () => {
    const c = fakeCodec('png');
    const r = await convert(pipe(c), src(), 'jpeg', { target: target('png', true, { metadataMode: 'strip-gps' }) });
    const s = summarizeExif(c.calls[0]!.exif!);
    expect(s.hasGps).toBe(false);
    expect(s.make).toBe('Airgap Fixtures');
    expect(c.calls[0]!.xmp).toBeUndefined();
    expect(r.verification.metadata).toEqual({ exif: 'kept', gps: 'removed', icc: 'removed', xmp: 'removed' });
  });
  it('preserve into an encoder without metadata support embeds nothing and reports removed', async () => {
    const c = fakeCodec('avif', { meta: false });
    const r = await convert(pipe(c), src(), 'jpeg', { target: target('avif', true, { metadataMode: 'preserve', iccMode: 'preserve' }) });
    expect(c.calls[0]!.exif).toBeUndefined();
    expect(r.verification.metadata.exif).toBe('removed');
  });
  it('an encoder that silently drops metadata it claimed is caught as unexpected', async () => {
    const c = fakeCodec('png', { meta: false });
    c.capabilities.metadata = { exif: true, icc: true, xmp: true }; // lies
    const r = await convert(pipe(c), src(), 'jpeg', { target: target('png', true, { metadataMode: 'preserve' }) });
    expect(r.verification.metadata.exif).toBe('unexpected');
    expect(r.verification.metadataOk).toBe(false);
  });
});

describe('convert(): ICC', () => {
  it('convert-srgb on a matrix profile changes pixels, drops the profile, verifies against the converted image', async () => {
    const c = fakeCodec('png');
    const src = img(pixelsFrom([255, 0, 0, 255, 128, 128, 128, 255], 2, 1), { hasIcc: true, iccKind: 'matrix', icc: ICC });
    const r = await convert(pipe(c), src, 'png', { target: target('png', true, { iccMode: 'convert-srgb' }) });
    expect(r.verification.comparedAgainstConverted).toBe(true);
    expect(r.verification.identical).toBe(true);
    expect(c.calls[0]!.icc).toBeUndefined();
    const out = await c.decode(r.bytes);
    expect(Array.from(out.pixels.data.slice(4, 8))).toEqual([128, 128, 128, 255]); // grey stays grey
    expect(out.pixels.data[1]).toBe(0); // P3 red -> sRGB red clipped: green stays 0
  });
  it('convert-srgb on a LUT profile throws rather than approximating', async () => {
    const c = fakeCodec('png');
    const lut = extractMetadata(fixture('icc-lut.jpg'), 'jpeg').icc!;
    const src = img(pixelsFrom([1, 2, 3, 255], 1, 1), { hasIcc: true, iccKind: 'lut', icc: lut });
    await expect(convert(pipe(c), src, 'jpeg', { target: target('png', true, { iccMode: 'convert-srgb' }) })).rejects.toThrow(/lut/);
  });
});

describe('probeCodec on fake codecs', () => {
  it('verifies an honest codec: lossless, exactAlpha, 16-bit, metadata', async () => {
    const r = await probeCodec(fakeCodec('png'));
    expect(r.probe.ok).toBe(true);
    expect(r.capabilities.lossless).toBe(true);
    expect(r.capabilities.exactAlpha).toBe(true);
    expect(r.capabilities.encodeBitDepths).toEqual([8, 16]);
    expect(r.capabilities.metadata).toEqual({ exif: true, icc: true, xmp: true });
    expect(r.probe.checks['exactAlpha']).toEqual({ claimed: true, verified: true });
  });
  it('demotes exactAlpha when RGB under alpha 0 is zeroed, keeps lossless', async () => {
    const r = await probeCodec(fakeCodec('png', { zeroUnderAlpha: true }));
    expect(r.capabilities.lossless).toBe(true);
    expect(r.capabilities.exactAlpha).toBe(false);
    expect(r.probe.detail).toMatch(/NOT exact/);
  });
  it('demotes lossless when a claimed-lossless codec perturbs pixels', async () => {
    const c = fakeCodec('png', { lossyNoise: 1 });
    c.capabilities.lossless = true;
    c.capabilities.exactAlpha = true;
    const r = await probeCodec(c);
    expect(r.capabilities.lossless).toBe(false);
    expect(r.capabilities.exactAlpha).toBe(false);
  });
  it('drops a 16-bit claim that fails, and a metadata claim that fails', async () => {
    const c = fakeCodec('png', { depths: [8], meta: false });
    c.capabilities.encodeBitDepths = [8, 16];
    c.capabilities.metadata = { exif: true, icc: true, xmp: true };
    const r = await probeCodec(c);
    expect(r.capabilities.encodeBitDepths).toEqual([8]);
    expect(r.capabilities.metadata).toEqual({ exif: false, icc: false, xmp: false });
  });
  it('an independent decoder that disagrees demotes lossless', async () => {
    const honest = fakeCodec('png');
    const liar = fakeCodec('png', { decodeNoise: 2 });
    liar.id = 'other';
    const r = await probeCodec(honest, liar);
    expect(r.capabilities.lossless).toBe(false);
    expect(r.probe.detail).toMatch(/disagrees/);
  });
  it('a codec that throws is reported as not encoding', async () => {
    const c = fakeCodec('png');
    c.encode = async () => {
      throw new Error('boom');
    };
    const r = await probeCodec(c);
    expect(r.probe.ok).toBe(false);
    expect(r.capabilities.encode).toBe(false);
  });
  it('canvas-like capabilities are declared with exactAlpha false', () => {
    expect(canvasCaps('png').exactAlpha).toBe(false);
  });
});
