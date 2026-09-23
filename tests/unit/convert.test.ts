/**
 * convert() orchestration with a fake codec: no browser, no canvas.
 * The real encoders are exercised in tests/browser.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { canvasCapabilities } from '../../src/codecs/canvas-capabilities';
import type { Codec, DecodedImage, EncodeOptions, ImageFormat } from '../../src/codecs/types';
import { comparePixels, convert, FlattenRequiredError } from '../../src/convert';

// Node has no ImageData; a minimal stand-in is enough for pure orchestration.
class FakeImageData {
  readonly colorSpace = 'srgb';
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}
beforeAll(() => {
  (globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData;
});

function img(px: number[], width: number, height: number, hasAlpha = true): DecodedImage {
  return {
    pixels: new FakeImageData(new Uint8ClampedArray(px), width, height) as unknown as ImageData,
    bitDepth: 8,
    metadata: {
      bitDepth: 8,
      hasAlpha,
      hasTransparency: hasAlpha && px.some((v, i) => i % 4 === 3 && v !== 255),
      hasSemiTransparency: hasAlpha && px.some((v, i) => i % 4 === 3 && v !== 255 && v !== 0),
      hasExif: false,
      hasGps: false,
      hasIcc: false,
      isAnimated: false,
    },
  };
}

/** A "codec" that serialises pixels verbatim, optionally perturbing them when lossy. */
function fakeCodec(format: ImageFormat, opts: { lossyNoise?: number } = {}): Codec & { calls: EncodeOptions[] } {
  const calls: EncodeOptions[] = [];
  return {
    format,
    capabilities: canvasCapabilities(format, true),
    calls,
    async encode(image, o) {
      calls.push(o);
      const { width, height, data } = image.pixels;
      const out = new Uint8Array(8 + data.length);
      new DataView(out.buffer).setUint32(0, width);
      new DataView(out.buffer).setUint32(4, height);
      out.set(data, 8);
      if (!o.lossless && opts.lossyNoise) {
        for (let i = 8; i < out.length; i += 4) out[i] = Math.max(0, out[i]! - opts.lossyNoise);
      }
      return out;
    },
    async decode(bytes) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = dv.getUint32(0);
      const height = dv.getUint32(4);
      return img(Array.from(bytes.subarray(8)), width, height);
    },
  };
}

const codecs = () => ({
  png: fakeCodec('png'),
  jpeg: fakeCodec('jpeg', { lossyNoise: 3 }),
  webp: fakeCodec('webp', { lossyNoise: 1 }),
});

describe('convert()', () => {
  it('lossless target: bytes carry the pixels verbatim and verification says identical', async () => {
    const c = codecs();
    const src = img([1, 2, 3, 255, 4, 5, 6, 255], 2, 1, false);
    const r = await convert(c, src, 'png', { target: { format: 'png', lossless: true } });
    expect(r.mime).toBe('image/png');
    expect(Array.from(r.bytes.subarray(8))).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(r.verification).toEqual({
      identical: true,
      differingPixels: 0,
      differingVisiblePixels: 0,
      maxChannelDiff: 0,
      comparedAgainstFlattened: false,
    });
    expect(c.png.calls[0]).toEqual({ lossless: true });
  });

  it('lossy target: quality is forwarded and verification measures the damage', async () => {
    const c = codecs();
    const src = img([10, 20, 30, 255, 40, 50, 60, 255], 2, 1, false);
    const r = await convert(c, src, 'png', { target: { format: 'jpeg', lossless: false }, quality: 0.42 });
    expect(c.jpeg.calls[0]).toEqual({ lossless: false, quality: 0.42 });
    expect(r.verification.identical).toBe(false);
    expect(r.verification.differingPixels).toBe(2);
    expect(r.verification.maxChannelDiff).toBe(3);
  });

  it('RGBA -> JPEG without a background is refused loudly', async () => {
    const c = codecs();
    const src = img([10, 20, 30, 0], 1, 1);
    await expect(
      convert(c, src, 'png', { target: { format: 'jpeg', lossless: false }, quality: 1 }),
    ).rejects.toBeInstanceOf(FlattenRequiredError);
    expect(c.jpeg.calls).toHaveLength(0);
  });

  it('RGBA -> JPEG with a background flattens onto it before encoding', async () => {
    const c = codecs();
    const src = img([10, 20, 30, 0, 200, 100, 50, 255, 0, 0, 0, 128], 3, 1);
    const r = await convert(c, src, 'png', {
      target: { format: 'jpeg', lossless: false },
      quality: 1,
      background: { r: 255, g: 255, b: 255 },
    });
    // Our fake JPEG subtracts 3 from the red channel; undo that to see what was encoded.
    const encoded = Array.from(r.bytes.subarray(8)).map((v, i) => (i % 4 === 0 ? v + 3 : v));
    expect(encoded).toEqual([255, 255, 255, 255, 200, 100, 50, 255, 127, 127, 127, 255]);
    expect(r.verification.comparedAgainstFlattened).toBe(true);
  });

  it('RGBA -> WebP lossless keeps alpha and does not require a background', async () => {
    const c = codecs();
    const src = img([10, 20, 30, 0, 200, 100, 50, 255], 2, 1);
    const r = await convert(c, src, 'png', { target: { format: 'webp', lossless: true } });
    expect(Array.from(r.bytes.subarray(8))).toEqual([10, 20, 30, 0, 200, 100, 50, 255]);
    expect(r.verification.identical).toBe(true);
  });

  it('a lossless request against a codec that cannot do lossless falls back to lossy encoding', async () => {
    const c = codecs();
    c.webp.capabilities = canvasCapabilities('webp', false);
    const src = img([10, 20, 30, 255], 1, 1, false);
    await convert(c, src, 'png', { target: { format: 'webp', lossless: true }, quality: 0.5 });
    expect(c.webp.calls[0]).toEqual({ lossless: false, quality: 0.5 });
  });

  it('quality is clamped to 0..1 and defaults when absent', async () => {
    const c = codecs();
    const src = img([1, 1, 1, 255], 1, 1, false);
    await convert(c, src, 'png', { target: { format: 'jpeg', lossless: false }, quality: 7 });
    await convert(c, src, 'png', { target: { format: 'jpeg', lossless: false } });
    expect(c.jpeg.calls.map((o) => o.quality)).toEqual([1, 0.9]);
  });
});

describe('comparePixels', () => {
  const mk = (px: number[], w = px.length / 4) => new FakeImageData(new Uint8ClampedArray(px), w, 1) as unknown as ImageData;
  it('hidden-only differences (RGB under alpha 0) are counted but not visible', () => {
    const r = comparePixels(mk([9, 9, 9, 0, 1, 2, 3, 255]), mk([0, 0, 0, 0, 1, 2, 3, 255]));
    expect(r).toEqual({ identical: false, differingPixels: 1, differingVisiblePixels: 0, maxChannelDiff: 9 });
  });
  it('alpha differences are always visible', () => {
    const r = comparePixels(mk([0, 0, 0, 0]), mk([0, 0, 0, 1]));
    expect(r.differingVisiblePixels).toBe(1);
  });
  it('size mismatch is total failure', () => {
    const r = comparePixels(mk([0, 0, 0, 0]), mk([0, 0, 0, 0, 0, 0, 0, 0]));
    expect(r.identical).toBe(false);
    expect(r.maxChannelDiff).toBe(255);
  });
});
