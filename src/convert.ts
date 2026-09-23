/**
 * Conversion orchestration. Pure with respect to the DOM: all pixel work is
 * delegated to the Codec, all compositing to flatten.ts. Runs inside the
 * worker but has no dependency on being there.
 */
import type { Codec, DecodedImage, ImageFormat } from './codecs/types';
import { MIME } from './codecs/types';
import { needsFlatten, type TargetSpec } from './capabilities';
import { flattenRgba, type RGB } from './flatten';

export interface ConversionPlan {
  target: TargetSpec;
  /** 0..1. Required for lossy targets. */
  quality?: number;
  /** Required when the source has alpha and the target cannot store it. */
  background?: RGB;
}

/** Measured, not predicted: the output was decoded again and compared. */
export interface Verification {
  /** Every channel of every pixel matches what was sent to the encoder. */
  identical: boolean;
  differingPixels: number;
  maxChannelDiff: number;
  /** Pixels that differ in alpha, or in RGB while not fully transparent. */
  differingVisiblePixels: number;
  /** True when the comparison baseline was the flattened image (JPEG from RGBA). */
  comparedAgainstFlattened: boolean;
}

export interface ConversionResult {
  bytes: Uint8Array;
  mime: string;
  format: ImageFormat;
  verification: Verification;
}

export class FlattenRequiredError extends Error {
  override name = 'FlattenRequiredError';
}

export async function convert(
  codecs: Record<ImageFormat, Codec>,
  source: DecodedImage,
  sourceFormat: ImageFormat,
  plan: ConversionPlan,
): Promise<ConversionResult> {
  const codec = codecs[plan.target.format];
  const caps = codec.capabilities;

  let toEncode: DecodedImage = source;
  const flatten = needsFlatten({ format: sourceFormat, metadata: source.metadata }, caps);
  if (flatten) {
    if (!plan.background) {
      throw new FlattenRequiredError(
        `The source has an alpha channel and ${plan.target.format.toUpperCase()} cannot store one. Choose a background colour to flatten onto; Airgap will not silently composite onto black.`,
      );
    }
    const flat = flattenRgba(source.pixels.data, plan.background);
    toEncode = {
      pixels: new ImageData(flat, source.pixels.width, source.pixels.height),
      metadata: {
        ...source.metadata,
        hasAlpha: false,
        hasTransparency: false,
        hasSemiTransparency: false,
      },
      bitDepth: source.bitDepth,
    };
  }

  const lossless = plan.target.lossless && caps.lossless;
  const opts = lossless
    ? { lossless: true as const }
    : { lossless: false as const, quality: clampQuality(plan.quality) };

  const bytes = await codec.encode(toEncode, opts);

  // Verify by decoding what we just produced and diffing against the input.
  const roundTrip = await codec.decode(bytes);
  const verification: Verification = {
    ...comparePixels(toEncode.pixels, roundTrip.pixels),
    comparedAgainstFlattened: flatten,
  };

  return { bytes, mime: MIME[plan.target.format], format: plan.target.format, verification };
}

function clampQuality(q: number | undefined): number {
  if (q === undefined || Number.isNaN(q)) return 0.9;
  return Math.min(1, Math.max(0, q));
}

export function comparePixels(
  a: ImageData,
  b: ImageData,
): Pick<Verification, 'identical' | 'differingPixels' | 'maxChannelDiff' | 'differingVisiblePixels'> {
  if (a.width !== b.width || a.height !== b.height) {
    const n = a.width * a.height;
    return { identical: false, differingPixels: n, differingVisiblePixels: n, maxChannelDiff: 255 };
  }
  const pa = a.data;
  const pb = b.data;
  let differingPixels = 0;
  let differingVisiblePixels = 0;
  let maxChannelDiff = 0;
  for (let i = 0; i < pa.length; i += 4) {
    let pixelDiff = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(pa[i + c]! - pb[i + c]!);
      if (d > pixelDiff) pixelDiff = d;
    }
    if (pixelDiff > 0) {
      differingPixels++;
      if (pixelDiff > maxChannelDiff) maxChannelDiff = pixelDiff;
      const alphaDiffers = pa[i + 3] !== pb[i + 3];
      if (alphaDiffers || pa[i + 3] !== 0) differingVisiblePixels++;
    }
  }
  return {
    identical: differingPixels === 0,
    differingPixels,
    differingVisiblePixels,
    maxChannelDiff,
  };
}
