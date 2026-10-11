/**
 * Conversion orchestration. Pure with respect to the DOM: pixel work is
 * delegated to codecs, compositing to flatten.ts, colour to metadata/icc.ts.
 */
import { needsFlatten, plannedBitDepth, type TargetSpec } from './capabilities';
import type { Animation, Codec, CodecCapabilities, DecodedImage, ImageFormat, PixelData } from './codecs/types';
import { MIME } from './codecs/types';
import { flattenPixels, type RGB } from './flatten';
import { inspect } from './inspect';
import { setExifGeometry, setOrientation, stripGps, normalizeExif } from './metadata/exif';
import { convertToSrgb, parseIcc } from './metadata/icc';
import { applyOrientation } from './orientation';
import { alphaStats, comparePixels, convertBitDepth, diffMask, maxValue, type PixelComparison } from './pixels';
import { applyTransform, isIdentity, type TransformSpec } from './transform';

export interface ConversionPlan {
  target: TargetSpec;
  /** 0..1. Required for lossy targets. */
  quality?: number;
  /** Required when the source has alpha and the target cannot store it. */
  background?: RGB;
  /** Crop, rotate/mirror, resize; applied to the upright source before encoding. */
  transform?: TransformSpec;
  /** PNG only: run the optimiser on the encoder's output and keep it if it is verified and smaller. */
  optimize?: boolean;
}

/** What the optional optimiser did. `used` is false when its output was not kept, with the reason. */
export interface Optimization {
  tool: string;
  before: number;
  after: number;
  used: boolean;
  reason?: string;
}

export type MetadataOutcome = 'kept' | 'removed' | 'absent' | 'unexpected';

/** Measured, not predicted: the output was decoded again and compared. */
export interface Verification extends PixelComparison {
  /** Bit depth at which the comparison ran (the verifier's depth if shallower than the output). */
  bitDepth: number;
  verifierId: string;
  comparedAgainstFlattened: boolean;
  comparedAgainstConverted: boolean;
  /** The baseline is the source after the geometric edit (crop, rotate, resize). */
  comparedAgainstTransformed: boolean;
  /**
   * Animated output: every frame was decoded again and compared, plus delays and loop count.
   * The pixel counts above are summed over frames; maxChannelDiff is over all of them.
   */
  animation?: { frames: number; framesIdentical: number; timingKept: boolean; loopsKept: boolean };
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
  /** How the container stores the samples (re-read from the output header), when the format exposes it. */
  colorLayout?: string;
  /** Output geometry (differs from the source after crop, rotation or resize). */
  width: number;
  height: number;
  optimization?: Optimization;
  verification: Verification;
  /** width*height bytes, change magnitude per pixel (0 = identical). Only when the output is not identical. */
  diffMask?: Uint8Array;
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
  /** Optional lossless re-packer of the encoder's output (oxipng for PNG). */
  optimizer?: { id: string; run(bytes: Uint8Array): Promise<Uint8Array> };
}

export async function convert(p: Pipeline, source: DecodedImage, sourceFormat: ImageFormat, plan: ConversionPlan): Promise<ConversionResult> {
  const { target } = plan;
  const enc = p.encoderCaps;
  const m = source.metadata;
  // An animated source keeps its frames when the encoder writes animations (probed); otherwise
  // the still image is converted and the loss list says the other frames are dropped.
  const animate = !!source.animation && !!enc.animation;

  // 1. Colour: convert to sRGB if asked (matrix/TRC or evaluable LUT profiles).
  let iccOut: Uint8Array | undefined = m.icc;
  let profile: ReturnType<typeof parseIcc> | undefined;
  if (m.icc && target.iccMode === 'convert-srgb' && !p.decoderCaps.decodeAppliesIcc) {
    profile = parseIcc(m.icc);
    if (!profile.convertible) {
      throw new Error(`Cannot convert this ${profile.kind} ICC profile to sRGB${profile.lutUnsupported ? ` (${profile.lutUnsupported})` : ''}; choose preserve or strip.`);
    }
    iccOut = undefined; // the output is sRGB now
  }
  const converted = !!profile;
  const transformed = !!plan.transform && !isIdentity(source.pixels.width, source.pixels.height, plan.transform);
  // 2. Bit depth the encoder will write.
  const outDepth = plannedBitDepth(source.pixels.bitDepth, { decoder: p.decoderCaps, encoder: enc });
  // 3. Flatten if the target has no alpha.
  const flatten = needsFlatten({ format: sourceFormat, metadata: m }, enc);
  if (flatten && !plan.background) {
    throw new FlattenRequiredError(
      `The source has an alpha channel and ${target.format.toUpperCase()} cannot store one. Choose a background colour to flatten onto; Airgap will not silently composite onto black.`,
    );
  }

  /** Steps 1-3 on one image (the still, or one frame): colour, geometry at source depth, depth, flatten. */
  const process = (px: PixelData): PixelData => {
    let out = px;
    if (profile) out = convertToSrgb(out, profile);
    if (transformed) out = applyTransform(out, plan.transform!);
    out = convertBitDepth(out, outDepth);
    if (flatten) out = flattenPixels(out, plan.background!);
    return out;
  };
  const pixels = process(source.pixels);
  const animation: Animation | undefined = animate
    ? { ...source.animation!, frames: source.animation!.frames.map((f) => ({ ...f, pixels: process(f.pixels) })) }
    : undefined;

  let metadata = { ...m };
  if (flatten) metadata = { ...metadata, hasAlpha: false, hasTransparency: false, hasSemiTransparency: false };
  else if (transformed && m.hasAlpha) {
    // A crop can remove every transparent pixel; resampling can create partial alpha at edges.
    const st = [pixels, ...(animation?.frames.map((f) => f.pixels) ?? [])].map((x) => alphaStats(x));
    metadata = { ...metadata, hasTransparency: st.some((x) => x.hasTransparency), hasSemiTransparency: st.some((x) => x.hasSemiTransparency) };
  }

  // 4. Metadata payloads per mode, gated by what the encoder can carry.
  let exifOut: Uint8Array | undefined;
  if (m.exif && target.metadataMode !== 'strip-all' && enc.metadata.exif) {
    exifOut = target.metadataMode === 'strip-gps' ? stripGps(m.exif) : normalizeExif(m.exif);
    // Pixels are stored upright: a carried orientation tag must say so.
    exifOut = setOrientation(exifOut, 1);
    if (transformed) exifOut = setExifGeometry(exifOut, pixels.width, pixels.height);
  }
  const xmpOut = m.xmp && target.metadataMode === 'preserve' && enc.metadata.xmp ? m.xmp : undefined;
  const iccEmbed = iccOut && target.iccMode === 'preserve' && enc.metadata.icc && !p.decoderCaps.decodeAppliesIcc ? iccOut : undefined;

  // Ask for what the user asked for. If the encoder's lossless claim failed its probe the
  // loss list already says so and the verification below measures the real outcome.
  const lossless = target.lossless;
  let bytes = await p.encoder.encode(
    { pixels, metadata, ...(animation && { animation }) },
    {
      lossless,
      ...(lossless ? {} : { quality: clampQuality(plan.quality) }),
      ...(exifOut && { exif: exifOut }),
      ...(iccEmbed && { icc: iccEmbed }),
      ...(xmpOut && { xmp: xmpOut }),
    },
  );

  // 4b. Optional optimiser: keep its output only if it decodes to the very same samples, carries the
  // same metadata, and is smaller. Otherwise the encoder's bytes stand and the result says why.
  let optimization: Optimization | undefined;
  if (plan.optimize && p.optimizer) {
    const before = bytes.length;
    try {
      const candidate = await p.optimizer.run(bytes);
      const [a, b] = await Promise.all([p.verifier.decode(bytes), p.verifier.decode(candidate)]);
      const same = a.pixels.bitDepth === b.pixels.bitDepth && comparePixels(a.pixels, b.pixels).identical;
      const ha = inspect(bytes).metadata;
      const hb = inspect(candidate).metadata;
      const metaSame = ha.hasExif === hb.hasExif && ha.hasIcc === hb.hasIcc && ha.hasXmp === hb.hasXmp;
      const reason = !same ? 'its output decoded to different samples' : !metaSame ? 'its output dropped or added metadata' : candidate.length >= before ? 'it did not make the file smaller' : undefined;
      optimization = { tool: p.optimizer.id, before, after: candidate.length, used: !reason, ...(reason && { reason }) };
      if (!reason) bytes = candidate;
    } catch (err) {
      optimization = { tool: p.optimizer.id, before, after: before, used: false, reason: `it failed: ${(err as Error).message}` };
    }
  }

  // 5. Verify pixels by decoding what we just produced: the still image, and every frame.
  const back = await p.verifier.decode(bytes);
  const depth = Math.min(outDepth, back.pixels.bitDepth);
  const expected = convertBitDepth(pixels, depth);
  const actual = convertBitDepth(back.pixels, depth);
  let cmp = comparePixels(expected, actual);
  let mask = cmp.identical ? undefined : diffMask(expected, actual);
  let animationCheck: Verification['animation'];
  if (animation) {
    const got = back.animation;
    const n = animation.frames.length;
    let framesIdentical = 0;
    let timingKept = !!got && got.frames.length === n;
    const total = { ...cmp };
    for (let i = 0; i < n; i++) {
      const want = convertBitDepth(animation.frames[i]!.pixels, depth);
      const have = got?.frames[i] ? convertBitDepth(got.frames[i]!.pixels, depth) : undefined;
      const c = have ? comparePixels(want, have) : { identical: false, differingPixels: want.width * want.height, differingVisiblePixels: want.width * want.height, maxChannelDiff: maxValue(depth) };
      if (c.identical) framesIdentical++;
      else {
        const fm = have ? diffMask(want, have) : new Uint8Array(want.width * want.height).fill(255);
        if (!mask) mask = fm;
        else for (let k = 0; k < mask.length; k++) if (fm[k]! > mask[k]!) mask[k] = fm[k]!;
      }
      total.identical &&= c.identical;
      total.differingPixels += c.differingPixels;
      total.differingVisiblePixels += c.differingVisiblePixels;
      total.maxChannelDiff = Math.max(total.maxChannelDiff, c.maxChannelDiff);
      const f = animation.frames[i]!;
      const g = got?.frames[i];
      // Compare durations, not representations: 1/10 s and 10/100 s are the same delay.
      if (!g || f.delayNum * g.delayDen !== g.delayNum * f.delayDen) timingKept = false;
    }
    const loopsKept = !!got && got.loops === animation.loops;
    cmp = total;
    animationCheck = { frames: n, framesIdentical, timingKept, loopsKept };
  }

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
    comparedAgainstTransformed: transformed,
    ...(animationCheck && { animation: animationCheck }),
    metadata: {
      exif: outcome(wantExif, h.hasExif, m.hasExif),
      gps: outcome(wantGps, h.hasGps, m.hasGps),
      icc: outcome(!!iccEmbed, h.hasIcc, m.hasIcc),
      xmp: outcome(!!xmpOut, h.hasXmp, m.hasXmp),
    },
    metadataOk: true,
  };
  verification.metadataOk = !Object.values(verification.metadata).includes('unexpected');

  return {
    bytes,
    mime: MIME[target.format],
    format: target.format,
    bitDepth: outDepth,
    encoderId: p.encoder.id,
    ...(h.colorLayout && { colorLayout: h.colorLayout }),
    width: pixels.width,
    height: pixels.height,
    ...(optimization && { optimization }),
    verification,
    ...(mask && { diffMask: mask }),
  };
}

function clampQuality(q: number | undefined): number {
  if (q === undefined || Number.isNaN(q)) return 0.9;
  return Math.min(1, Math.max(0, q));
}
