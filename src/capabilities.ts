/**
 * THE core logic of Airgap: given what we know about a source image and the
 * chosen target, list exactly what the conversion will discard.
 *
 * Pure. No DOM. No codec calls. Unit-tested table-driven in
 * tests/unit/capabilities.test.ts.
 */
import type { CodecCapabilities, ImageFormat, ImageMetadata } from './codecs/types';

export interface SourceDescription {
  format: ImageFormat;
  metadata: ImageMetadata;
}

export interface TargetSpec {
  format: ImageFormat;
  /** The user asked for lossless output (PNG is always lossless; WebP is a choice). */
  lossless: boolean;
}

export type LossKind =
  | 'pixels-lossy' // lossy encoder will alter pixel values
  | 'bit-depth' // >8-bit samples truncated to 8-bit
  | 'alpha' // alpha channel dropped (target cannot store it)
  | 'premultiplied-alpha' // semi-transparent RGB rounded by the canvas pipeline
  | 'transparent-color' // RGB stored under alpha=0 pixels discarded by the canvas pipeline
  | 'exif' // EXIF metadata stripped (message says whether GPS is inside)
  | 'icc' // ICC colour profile stripped
  | 'animation'; // only the first frame survives

/**
 * 'pixels'   — visible pixel values in the output differ from the source.
 * 'hidden'   — pixel values differ, but only where alpha is 0 (never visible).
 * 'metadata' — pixel values survive; embedded metadata does not.
 */
export type LossSeverity = 'pixels' | 'hidden' | 'metadata';

export interface Loss {
  kind: LossKind;
  severity: LossSeverity;
  message: string;
}

/**
 * Returns every loss the conversion will cause, in display order.
 * An empty list means: pixel-identical output AND no metadata dropped.
 */
export function computeLosses(
  source: SourceDescription,
  target: TargetSpec,
  caps: CodecCapabilities,
): Loss[] {
  const m = source.metadata;
  const losses: Loss[] = [];

  // --- pixel-level losses first: they matter most ---------------------------

  if (!target.lossless) {
    losses.push({
      kind: 'pixels-lossy',
      severity: 'pixels',
      message: `${label(target.format)} will be written with a lossy encoder. Pixel values will change and cannot be recovered.`,
    });
  } else if (!caps.lossless) {
    losses.push({
      kind: 'pixels-lossy',
      severity: 'pixels',
      message: `Lossless ${label(target.format)} is not available in this browser's encoder, so the output will be lossy. Pixel values will change.`,
    });
  }

  if (m.bitDepth > caps.maxBitDepth) {
    losses.push({
      kind: 'bit-depth',
      severity: 'pixels',
      message: `Source samples are ${m.bitDepth}-bit; the output will be ${caps.maxBitDepth}-bit. The low ${m.bitDepth - caps.maxBitDepth} bits of every sample will be discarded.`,
    });
  }

  if (m.hasAlpha && !caps.alpha) {
    losses.push({
      kind: 'alpha',
      severity: 'pixels',
      message: m.hasTransparency
        ? `${label(target.format)} cannot store transparency. The alpha channel will be removed and transparent areas flattened onto the background colour you choose.`
        : `${label(target.format)} cannot store an alpha channel. The source alpha channel is fully opaque, so no visible transparency is lost, but the channel itself will be removed.`,
    });
  }

  if (m.hasAlpha && caps.alpha && caps.premultipliedAlpha && m.hasSemiTransparency) {
    losses.push({
      kind: 'premultiplied-alpha',
      severity: 'pixels',
      message:
        'The source has semi-transparent pixels. The browser canvas pipeline stores colour premultiplied by alpha, so the RGB values of semi-transparent pixels will be rounded (the more transparent the pixel, the larger the error). Alpha values and fully opaque pixels are unaffected.',
    });
  }

  if (m.hasAlpha && caps.alpha && caps.premultipliedAlpha && m.hasTransparency) {
    losses.push({
      kind: 'transparent-color',
      severity: 'hidden',
      message:
        'Fully transparent pixels (alpha 0) will come out as transparent black (0,0,0,0). Any colour the source stored under them is discarded. This is invisible but it is not pixel-identical.',
    });
  }

  if (m.isAnimated) {
    losses.push({
      kind: 'animation',
      severity: 'pixels',
      message: 'The source is animated. Only the first frame will be converted; all other frames will be dropped.',
    });
  }

  // --- metadata ---------------------------------------------------------------

  if (!caps.keepsMetadata) {
    if (m.hasExif) {
      losses.push({
        kind: 'exif',
        severity: 'metadata',
        message: m.hasGps
          ? 'EXIF metadata will be removed, including the embedded GPS location.'
          : 'EXIF metadata (camera, date, orientation tag, etc.) will be removed.',
      });
    }
    if (m.hasIcc) {
      losses.push({
        kind: 'icc',
        severity: 'metadata',
        message:
          'The embedded ICC colour profile will be removed. Pixel values are copied unchanged, so viewers will interpret them as sRGB; colours may look different if the profile was not sRGB.',
      });
    }
  }

  return losses;
}

/**
 * True when the conversion keeps every VISIBLE pixel value. 'hidden' losses
 * (RGB under alpha 0) and metadata losses do not count; they are still listed.
 */
export function isPixelLossless(losses: Loss[]): boolean {
  return !losses.some((l) => l.severity === 'pixels');
}

/** True only when nothing at all is listed: byte-for-byte pixel identity and no metadata dropped. */
export function isFullyLossless(losses: Loss[]): boolean {
  return losses.length === 0;
}

/** The JPEG flatten rule: RGBA into a format without alpha needs an explicit background. */
export function needsFlatten(source: SourceDescription, caps: CodecCapabilities): boolean {
  return source.metadata.hasAlpha && !caps.alpha;
}

export function label(format: ImageFormat): string {
  switch (format) {
    case 'png':
      return 'PNG';
    case 'jpeg':
      return 'JPEG';
    case 'webp':
      return 'WebP';
  }
}
