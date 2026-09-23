/**
 * Conversion orchestration. Pure with respect to the DOM: pixel work is
 * delegated to codecs, compositing to flatten.ts, colour to metadata/icc.ts.
 */
import { needsFlatten, plannedBitDepth, type TargetSpec } from './capabilities';
import type { Codec, CodecCapabilities, DecodedImage, ImageFormat, PixelData } from './codecs/types';
import { MIME } from './codecs/types';
import { flattenPixels, type RGB } from './flatten';
import { inspect } from './inspect';
import { setOrientation, stripGps, normalizeExif } from './metadata/exif';
import { convertToSrgb, parseIcc } from './metadata/icc';
import { applyOrientation } from './orientation';
import { comparePixels, convertBitDepth, type PixelComparison } from './pixels';

export interface ConversionPlan {
  target: TargetSpec;
  /** 0..1. Required for lossy targets. */
  quality?: number;
  /** Required when the source has alpha and the target cannot store it. */
  background?: RGB;
}

export type MetadataOutcome = 'kept' | 'removed' | 'absent' | 'unexpected';

/** Measured, not predicted: the output was decoded again and compared. */
export interface Verification extends PixelComparison {
  /** Bit depth at which the comparison ran (the verifier's depth if shallower than the output). */
  bitDepth: number;
  verifierId: string;
  comparedAgainstFlattened: boolean;
  comparedAgainstConverted: boolean;
  metadata: { exif: MetadataOutcome; gps: MetadataOutcome; icc: MetadataOutcome; xmp: MetadataOutcome };
  /** Every metadata outcome matched the plan. */
  metadataOk: boolean;
}

export interface ConversionResult {
  bytes: Uint8Array;
  mime: string;
  format: ImageFormat;
  bitDepth: number;
  encoderId: string;
  verification: Verification;
}

export class FlattenRequiredError extends Error {
  override name = 'FlattenRequiredError';
}

/** Applies EXIF orientation so the pixels are stored upright. Idempotent via the flag. */
export function prepareSource(img: DecodedImage): DecodedImage {
  const o = img.metadata.orientation;
  if (!o || o === 1 || img.metadata.orientationApplied) return img;
  return { pixels: applyOrientation(img.pixels, o), metadata: { ...img.metadata, orientationApplied: true } };
}

export interface Pipeline {
  encoder: Codec;
  encoderCaps: CodecCapabilities;
  decoderCaps: CodecCapabilities;
  /** Decoder used to re-read the output for verification. */
  verifier: Codec;
}

export async function convert(p: Pipeline, source: DecodedImage, sourceFormat: ImageFormat, plan: ConversionPlan): Promise<ConversionResult> {
  const { target } = plan;
  const enc = p.encoderCaps;
  const m = source.metadata;
  let pixels: PixelData = source.pixels;
  let converted = false;

  // 1. Colour: convert to sRGB if asked (matrix/TRC profiles only).
  let iccOut: Uint8Array | undefined = m.icc;
  if (m.icc && target.iccMode === 'convert-srgb' && !p.decoderCaps.decodeAppliesIcc) {
    const profile = parseIcc(m.icc);
    if (profile.kind !== 'matrix') {
      throw new Error(`Cannot convert a ${profile.kind} ICC profile to sRGB; choose preserve or strip.`);
    }
    pixels = convertToSrgb(pixels, profile);
    converted = true;
    iccOut = undefined; // the output is sRGB now
  }

  // 2. Bit depth the encoder will write.
  const outDepth = plannedBitDepth(pixels.bitDepth, { decoder: p.decoderCaps, encoder: enc });
  pixels = convertBitDepth(pixels, outDepth);

  // 3. Flatten if the target has no alpha.
  const flatten = needsFlatten({ format: sourceFormat, metadata: m }, enc);
  let metadata = { ...m };
  if (flatten) {
    if (!plan.background) {
      throw new FlattenRequiredError(
        `The source has an alpha channel and ${target.format.toUpperCase()} cannot store one. Choose a background colour to flatten onto; Airgap will not silently composite onto black.`,
      );
    }
    pixels = flattenPixels(pixels, plan.background);
    metadata = { ...metadata, hasAlpha: false, hasTransparency: false, hasSemiTransparency: false };
  }

  // 4. Metadata payloads per mode, gated by what the encoder can carry.
  let exifOut: Uint8Array | undefined;
  if (m.exif && target.metadataMode !== 'strip-all' && enc.metadata.exif) {
    exifOut = target.metadataMode === 'strip-gps' ? stripGps(m.exif) : normalizeExif(m.exif);
    // Pixels are stored upright: a carried orientation tag must say so.
    exifOut = setOrientation(exifOut, 1);
  }
  const xmpOut = m.xmp && target.metadataMode === 'preserve' && enc.metadata.xmp ? m.xmp : undefined;
  const iccEmbed = iccOut && target.iccMode === 'preserve' && enc.metadata.icc && !p.decoderCaps.decodeAppliesIcc ? iccOut : undefined;

  // Ask for what the user asked for. If the encoder's lossless claim failed its probe the
  // loss list already says so and the verification below measures the real outcome.
  const lossless = target.lossless;
  const bytes = await p.encoder.encode(
    { pixels, metadata },
    {
      lossless,
      ...(lossless ? {} : { quality: clampQuality(plan.quality) }),
      ...(exifOut && { exif: exifOut }),
      ...(iccEmbed && { icc: iccEmbed }),
      ...(xmpOut && { xmp: xmpOut }),
    },
  );

  // 5. Verify pixels by decoding what we just produced.
  const back = await p.verifier.decode(bytes);
  const depth = Math.min(outDepth, back.pixels.bitDepth);
  const cmp = comparePixels(convertBitDepth(pixels, depth), convertBitDepth(back.pixels, depth));

  // 6. Verify metadata by re-reading the container header.
  const h = inspect(bytes).metadata;
  const outcome = (wanted: boolean, present: boolean, hadIt: boolean): MetadataOutcome => {
    if (!hadIt) return present ? 'unexpected' : 'absent';
    if (wanted) return present ? 'kept' : 'unexpected';
    return present ? 'unexpected' : 'removed';
  };
  const wantExif = !!exifOut;
  const wantGps = wantExif && target.metadataMode === 'preserve';
  const verification: Verification = {
    ...cmp,
    bitDepth: depth,
    verifierId: p.verifier.id,
    comparedAgainstFlattened: flatten,
    comparedAgainstConverted: converted,
    metadata: {
      exif: outcome(wantExif, h.hasExif, m.hasExif),
      gps: outcome(wantGps, h.hasGps, m.hasGps),
      icc: outcome(!!iccEmbed, h.hasIcc, m.hasIcc),
      xmp: outcome(!!xmpOut, h.hasXmp, m.hasXmp),
    },
    metadataOk: true,
  };
  verification.metadataOk = !Object.values(verification.metadata).includes('unexpected');

  return { bytes, mime: MIME[target.format], format: target.format, bitDepth: outDepth, encoderId: p.encoder.id, verification };
}

function clampQuality(q: number | undefined): number {
  if (q === undefined || Number.isNaN(q)) return 0.9;
  return Math.min(1, Math.max(0, q));
}
