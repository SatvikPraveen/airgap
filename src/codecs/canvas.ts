/**
 * Canvas codec: PNG, JPEG and WebP through createImageBitmap +
 * OffscreenCanvas.convertToBlob.
 *
 * Known, deliberate limitations (all surfaced by capabilities.ts):
 *  - strips EXIF and ICC (the canvas has nowhere to keep them)
 *  - truncates >8-bit samples to 8-bit
 *  - the 2D canvas backing store is premultiplied: fully transparent pixels
 *    come back as (0,0,0,0) and semi-transparent RGB is rounded
 *  - lossless WebP depends on the browser encoder; probeWebpLossless() checks.
 */
import { alphaStats } from '../flatten';
import { inspect } from '../inspect';
import type { WebpProbeResult } from '../protocol';
import { canvasCapabilities } from './canvas-capabilities';
import { MIME, type Codec, type DecodedImage, type EncodeOptions, type ImageFormat } from './types';

export { canvasCapabilities };

function makeCanvas(width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', {
    alpha: true,
    willReadFrequently: true,
    colorSpace: 'srgb',
  });
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable in this browser.');
  return { canvas, ctx };
}

export async function decodeViaCanvas(bytes: Uint8Array, format: ImageFormat): Promise<DecodedImage> {
  const header = inspect(bytes);
  const blob = new Blob([bytes as BlobPart], { type: MIME[format] });
  const bitmap = await createImageBitmap(blob, {
    // Keep pixel values as stored; do not convert through an embedded ICC profile.
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
    // Bake the EXIF orientation into pixels, since the EXIF tag itself will not survive.
    imageOrientation: 'from-image',
  });
  try {
    const { ctx } = makeCanvas(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const stats = header.metadata.hasAlpha
      ? alphaStats(pixels.data)
      : { hasTransparency: false, hasSemiTransparency: false };
    return {
      pixels,
      metadata: { ...header.metadata, ...stats },
      bitDepth: 8,
    };
  } finally {
    bitmap.close();
  }
}

export async function encodeViaCanvas(
  img: DecodedImage,
  format: ImageFormat,
  opts: EncodeOptions,
): Promise<Uint8Array> {
  if (format === 'jpeg' && img.metadata.hasAlpha) {
    // convert() flattens before we get here. This guard exists so the codec can
    // never be the thing that silently composites onto black.
    throw new Error('Refusing to encode an image with alpha to JPEG without flattening.');
  }
  const { canvas, ctx } = makeCanvas(img.pixels.width, img.pixels.height);
  ctx.putImageData(img.pixels, 0, 0);

  const blobOpts: ImageEncodeOptions = { type: MIME[format] };
  if (format === 'webp' && opts.lossless) {
    // Chromium's WebP encoder switches to lossless mode when quality is exactly 1.
    // Whether this actually holds in the running browser is measured by probeWebpLossless().
    blobOpts.quality = 1;
  } else if (format !== 'png') {
    blobOpts.quality = opts.quality ?? 0.9;
  }
  const blob = await canvas.convertToBlob(blobOpts);
  if (blob.type !== MIME[format]) {
    throw new Error(
      `This browser cannot encode ${MIME[format]} (it returned ${blob.type || 'nothing'}).`,
    );
  }
  return new Uint8Array(await blob.arrayBuffer());
}

export function createCanvasCodec(format: ImageFormat, webpLossless = false): Codec {
  return {
    format,
    capabilities: canvasCapabilities(format, webpLossless),
    decode: (bytes) => decodeViaCanvas(bytes, format),
    encode: (img, opts) => encodeViaCanvas(img, format, opts),
  };
}

/**
 * Empirically checks whether WebP at quality 1 round-trips an opaque noisy
 * image exactly. Runs once at worker start-up; the result gates the
 * "WebP (lossless)" target and the lossless-only toggle.
 */
export async function probeWebpLossless(): Promise<WebpProbeResult> {
  const size = 32;
  const px = new Uint8ClampedArray(size * size * 4);
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 24;
  };
  for (let i = 0; i < px.length; i += 4) {
    // Opaque noise, plus a few fully transparent black pixels (which the
    // premultiplied canvas represents exactly) to exercise the alpha path.
    const transparent = (i >> 2) % 37 === 0;
    px[i] = transparent ? 0 : rnd();
    px[i + 1] = transparent ? 0 : rnd();
    px[i + 2] = transparent ? 0 : rnd();
    px[i + 3] = transparent ? 0 : 255;
  }
  const img: DecodedImage = {
    pixels: new ImageData(px, size, size),
    bitDepth: 8,
    metadata: {
      bitDepth: 8,
      hasAlpha: true,
      hasTransparency: true,
      hasSemiTransparency: false,
      hasExif: false,
      hasGps: false,
      hasIcc: false,
      isAnimated: false,
    },
  };
  try {
    const bytes = await encodeViaCanvas(img, 'webp', { lossless: true });
    const back = await decodeViaCanvas(bytes, 'webp');
    const header = inspect(bytes);
    let maxDiff = 0;
    for (let i = 0; i < px.length; i++) {
      const d = Math.abs(px[i]! - back.pixels.data[i]!);
      if (d > maxDiff) maxDiff = d;
    }
    const lossless = maxDiff === 0;
    return {
      supported: true,
      lossless,
      detail: lossless
        ? `Verified: WebP at quality 1 reproduced a ${size}x${size} noise image exactly (container reports ${header.metadata.sourceLossless ? 'VP8L lossless' : 'VP8 lossy'} bitstream).`
        : `WebP at quality 1 altered pixels (max channel difference ${maxDiff}). Lossless WebP is not available through this browser's canvas encoder.`,
    };
  } catch (err) {
    return {
      supported: false,
      lossless: false,
      detail: `This browser cannot encode WebP via canvas: ${(err as Error).message}`,
    };
  }
}
