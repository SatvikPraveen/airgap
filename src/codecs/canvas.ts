/**
 * Canvas codec: the browser's own decoders/encoders through createImageBitmap
 * + OffscreenCanvas.convertToBlob. Kept as the registered FALLBACK.
 *
 * Declared honestly: the 2D canvas backing store is premultiplied, so
 * exactAlpha is false; everything is 8-bit; EXIF/ICC/XMP are carried by the
 * container layer (src/metadata/containers.ts) around the canvas, not by it.
 */
import { extractMetadata, injectMetadata } from '../metadata/containers';
import { parseIcc } from '../metadata/icc';
import { inspect } from '../inspect';
import { alphaStats } from '../pixels';
import { MIME, type Codec, type CodecCapabilities, type DecodedImage, type EncodeOptions, type ImageFormat } from './types';

const CANVAS_DECODE: ImageFormat[] = ['png', 'jpeg', 'webp', 'avif'];
const CANVAS_ENCODE: ImageFormat[] = ['png', 'jpeg', 'webp'];
const CONTAINER_METADATA: ImageFormat[] = ['png', 'jpeg', 'webp'];

export function canvasCapabilities(format: ImageFormat): CodecCapabilities {
  const encode = CANVAS_ENCODE.includes(format);
  const meta = encode && CONTAINER_METADATA.includes(format);
  return {
    decode: CANVAS_DECODE.includes(format),
    encode,
    // WebP lossless (quality === 1 in Chromium) is only ever believed after the probe.
    lossless: format === 'png' || format === 'webp',
    alpha: format !== 'jpeg',
    exactAlpha: false,
    decodeBitDepth: 8,
    decodeExact: true,
      decodeAppliesIcc: false,
    encodeBitDepths: [8],
    metadata: { exif: meta, icc: meta, xmp: meta },
  };
}

function makeCanvas(width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true, colorSpace: 'srgb' });
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable in this browser.');
  return { canvas, ctx };
}

export async function decodeViaCanvas(bytes: Uint8Array, format: ImageFormat): Promise<DecodedImage> {
  const header = inspect(bytes);
  const payloads = CONTAINER_METADATA.includes(format) ? extractMetadata(bytes, format) : {};
  // Chromium ignores imageOrientation:'none' (it now means 'from-image'), so a JPEG with an
  // EXIF Orientation tag would come back already rotated and the pipeline would rotate it
  // again. Feed the browser a copy with EXIF/ICC/XMP removed; the payloads are kept from
  // the original bytes. Orientation is applied uniformly by the pipeline.
  const stripped = CONTAINER_METADATA.includes(format) && (header.metadata.hasExif || header.metadata.hasIcc || header.metadata.hasXmp) ? injectMetadata(bytes, format, {}) : bytes;
  const blob = new Blob([stripped as BlobPart], { type: MIME[format] });
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const { ctx } = makeCanvas(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const pixels = { width: img.width, height: img.height, bitDepth: 8, data: img.data };
    const stats = header.metadata.hasAlpha ? alphaStats(pixels) : { hasTransparency: false, hasSemiTransparency: false };
    const metadata: DecodedImage['metadata'] = { ...header.metadata, ...stats, ...payloads };
    if (payloads.icc) {
      try {
        const p = parseIcc(payloads.icc);
        metadata.iccKind = p.kind;
        metadata.iccDescription = p.description;
      } catch {
        metadata.iccKind = 'unknown';
      }
    }
    return { pixels, metadata };
  } finally {
    bitmap.close();
  }
}

export async function encodeViaCanvas(img: DecodedImage, format: ImageFormat, opts: EncodeOptions): Promise<Uint8Array> {
  if (!CANVAS_ENCODE.includes(format)) throw new Error(`Canvas cannot encode ${format}`);
  if (format === 'jpeg' && img.metadata.hasAlpha) {
    // convert() flattens before we get here. This guard exists so the codec can
    // never be the thing that silently composites onto black.
    throw new Error('Refusing to encode an image with alpha to JPEG without flattening.');
  }
  if (img.pixels.bitDepth !== 8) throw new Error('Canvas encodes 8-bit only; convert() must reduce first.');
  const { canvas, ctx } = makeCanvas(img.pixels.width, img.pixels.height);
  ctx.putImageData(new ImageData(img.pixels.data as Uint8ClampedArray<ArrayBuffer>, img.pixels.width, img.pixels.height), 0, 0);
  const blobOpts: ImageEncodeOptions = { type: MIME[format] };
  if (format === 'webp' && opts.lossless) blobOpts.quality = 1; // Chromium: exactly 1 => VP8L lossless
  else if (format !== 'png') blobOpts.quality = opts.quality ?? 0.9;
  const blob = await canvas.convertToBlob(blobOpts);
  if (blob.type !== MIME[format]) {
    throw new Error(`This browser cannot encode ${MIME[format]} (it returned ${blob.type || 'nothing'}).`);
  }
  let out: Uint8Array = new Uint8Array(await blob.arrayBuffer());
  if ((opts.exif || opts.icc || opts.xmp) && CONTAINER_METADATA.includes(format)) {
    out = injectMetadata(out, format, { ...(opts.exif && { exif: opts.exif }), ...(opts.icc && { icc: opts.icc }), ...(opts.xmp && { xmp: opts.xmp }) });
  }
  return out;
}

export function createCanvasCodec(format: ImageFormat): Codec {
  return {
    id: `canvas-${format}`,
    format,
    capabilities: canvasCapabilities(format),
    decode: (bytes) => decodeViaCanvas(bytes, format),
    encode: (img, opts) => encodeViaCanvas(img, format, opts),
  };
}
