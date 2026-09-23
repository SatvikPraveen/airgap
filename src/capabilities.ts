/**
 * THE core logic of Airgap: given what we know about a source image, the
 * chosen target, and the PROBED capabilities of the codecs that will do the
 * work, list exactly what the conversion will discard.
 *
 * Pure. No DOM. No codec calls. No codec is ever special-cased by name: only
 * capability fields are consulted. Unit-tested table-driven in
 * tests/unit/capabilities.test.ts.
 */
import type { CodecCapabilities, ImageFormat, ImageMetadata } from './codecs/types';

export interface SourceDescription {
  format: ImageFormat;
  metadata: ImageMetadata;
}

export type MetadataMode = 'preserve' | 'strip-all' | 'strip-gps';
export type IccMode = 'preserve' | 'convert-srgb' | 'strip';

export interface TargetSpec {
  format: ImageFormat;
  /** The user asked for lossless output. */
  lossless: boolean;
  metadataMode: MetadataMode;
  iccMode: IccMode;
}

export const DEFAULT_MODES: Pick<TargetSpec, 'metadataMode' | 'iccMode'> = {
  metadataMode: 'strip-all',
  iccMode: 'strip',
};

export type LossKind =
  | 'pixels-lossy' // lossy encoder will alter pixel values
  | 'bit-depth' // samples truncated to fewer bits
  | 'bit-depth-unknown' // source depth could not be read; output depth cannot be called lossless
  | 'alpha' // alpha channel dropped (target cannot store it)
  | 'premultiplied-alpha' // semi-transparent RGB rounded by a non-exact pipeline
  | 'transparent-color' // RGB under alpha 0 discarded by a non-exact pipeline
  | 'associated-alpha' // source stored premultiplied alpha; un-premultiplying rounds
  | 'decoder-unverified' // the decoder for this source could not be shown to be exact
  | 'transform-properties' // AVIF irot/imir rotation-mirror properties are not applied
  | 'animation' // only the first frame / page survives
  | 'icc-convert' // pixel values changed to sRGB on purpose (appearance kept)
  | 'icc-convert-unavailable' // convert requested but profile kind is not matrix/TRC
  | 'exif' // EXIF removed (by choice or because the target cannot carry it)
  | 'gps' // GPS IFD removed on purpose
  | 'orientation' // EXIF Orientation tag rewritten to 1 (pixels stored upright)
  | 'icc' // ICC profile removed (by choice or because the target cannot carry it)
  | 'xmp'; // XMP removed

/**
 * 'pixels'   — visible pixel values in the output differ from the source (or cannot be shown not to).
 * 'metadata' — pixel values survive; embedded metadata does not (or is altered).
 */
export type LossSeverity = 'pixels' | 'metadata';

export interface Loss {
  kind: LossKind;
  severity: LossSeverity;
  message: string;
}

export interface Pipeline {
  decoder: CodecCapabilities;
  encoder: CodecCapabilities;
}

/** The bit depth the encoder will write for this source through this pipeline. */
export function plannedBitDepth(sourceDepth: number, p: Pipeline): number {
  const afterDecode = Math.min(sourceDepth, p.decoder.decodeBitDepth);
  const fits = p.encoder.encodeBitDepths.filter((d) => d >= afterDecode);
  if (fits.length) return Math.min(...fits);
  return Math.max(...p.encoder.encodeBitDepths);
}

/**
 * Returns every loss the conversion will cause, in display order.
 * An empty list means: pixel-identical output AND no metadata dropped or altered.
 */
export function computeLosses(source: SourceDescription, target: TargetSpec, p: Pipeline): Loss[] {
  const m = source.metadata;
  const enc = p.encoder;
  const dec = p.decoder;
  const losses: Loss[] = [];
  const name = label(target.format);

  // --- pixel-level losses first: they matter most ---------------------------

  if (!target.lossless) {
    losses.push({
      kind: 'pixels-lossy',
      severity: 'pixels',
      message: `${name} will be written with a lossy encoder. Pixel values will change and cannot be recovered.`,
    });
  } else if (!enc.lossless) {
    losses.push({
      kind: 'pixels-lossy',
      severity: 'pixels',
      message: `Lossless ${name} could not be verified in this browser's encoder, so the output cannot be called lossless. Pixel values may change.`,
    });
  }

  if (m.bitDepthUncertain) {
    losses.push({
      kind: 'bit-depth-unknown',
      severity: 'pixels',
      message: `The source bit depth could not be read from the file header, so the ${plannedBitDepth(8, p)}-bit output cannot be shown to keep every sample value.`,
    });
  } else {
    const out = plannedBitDepth(m.bitDepth, p);
    if (out < m.bitDepth) {
      const where = dec.decodeBitDepth < m.bitDepth ? 'the decoder' : 'the encoder';
      losses.push({
        kind: 'bit-depth',
        severity: 'pixels',
        message: `Source samples are ${m.bitDepth}-bit; the output will be ${out}-bit because ${where} in use does not go deeper. The low ${m.bitDepth - out} bits of every sample will be discarded.`,
      });
    }
  }

  if (m.hasAlpha && !enc.alpha) {
    losses.push({
      kind: 'alpha',
      severity: 'pixels',
      message: m.hasTransparency
        ? `${name} cannot store transparency. The alpha channel will be removed and transparent areas flattened onto the background colour you choose.`
        : `${name} cannot store an alpha channel. The source alpha channel is fully opaque, so no visible transparency is lost, but the channel itself will be removed.`,
    });
  }

  if (m.hasAlpha && enc.alpha && m.hasTransparency) {
    const exact = dec.exactAlpha && enc.exactAlpha;
    if (!exact) {
      const side = !dec.exactAlpha && !enc.exactAlpha ? 'decoder and encoder' : !dec.exactAlpha ? 'decoder' : 'encoder';
      if (m.hasSemiTransparency) {
        losses.push({
          kind: 'premultiplied-alpha',
          severity: 'pixels',
          message: `The ${side} in use rounds the RGB of semi-transparent pixels (premultiplied-alpha pipeline). Alpha values and fully opaque pixels are unaffected.`,
        });
      }
      losses.push({
        kind: 'transparent-color',
        severity: 'pixels',
        message: `The ${side} in use discards the colour stored under fully transparent pixels (they become 0,0,0,0). That colour is invisible in a viewer but it is real data: sprite sheets and textures rely on it to avoid edge fringing.`,
      });
    }
  }

  if (!dec.decodeExact) {
    losses.push({
      kind: 'decoder-unverified',
      severity: 'pixels',
      message: `The ${label(source.format)} decoder in use could not be shown to reproduce pixel values exactly in this browser (its round trip with the matching encoder was not identical), so the output cannot be called lossless.`,
    });
  }

  if (m.hasTransformProperties) {
    losses.push({
      kind: 'transform-properties',
      severity: 'pixels',
      message: 'The AVIF file carries rotation/mirror properties (irot/imir) that the decoder in use does not apply. The output will be stored unrotated, so it may look different from how viewers show the source.',
    });
  }

  if (m.alphaAssociated && m.hasSemiTransparency) {
    losses.push({
      kind: 'associated-alpha',
      severity: 'pixels',
      message: 'The source stores premultiplied (associated) alpha. Airgap un-premultiplies to straight alpha for the output, which rounds the RGB of semi-transparent pixels.',
    });
  }

  if (m.isAnimated) {
    losses.push({
      kind: 'animation',
      severity: 'pixels',
      message: 'The source has multiple frames or pages. Only the first will be converted; all others will be dropped.',
    });
  }

  if (m.hasIcc && dec.decodeAppliesIcc) {
    losses.push({
      kind: 'icc-convert',
      severity: 'pixels',
      message: `The ${label(source.format)} decoder in use converts pixels through the embedded profile to sRGB and cannot be told not to. Appearance is preserved; values change. The profile itself is not carried.`,
    });
  } else if (m.hasIcc && target.iccMode === 'convert-srgb') {
    if (m.iccKind === 'matrix') {
      losses.push({
        kind: 'icc-convert',
        severity: 'pixels',
        message: 'Pixel values will be converted from the embedded profile to sRGB. Appearance is preserved; values change and out-of-gamut colours are clipped. The profile is then dropped because the output is sRGB.',
      });
    } else {
      losses.push({
        kind: 'icc-convert-unavailable',
        severity: 'pixels',
        message: `Conversion to sRGB is not available for this profile (${m.iccKind ?? 'unknown'} kind). Airgap only converts matrix/TRC profiles and will not approximate a LUT-based one. Choose "preserve" or "strip".`,
      });
    }
  }

  // --- metadata ---------------------------------------------------------------

  if (m.hasExif) {
    if (target.metadataMode === 'strip-all') {
      losses.push({
        kind: 'exif',
        severity: 'metadata',
        message: m.hasGps
          ? 'EXIF metadata will be removed, including the embedded GPS location.'
          : 'EXIF metadata (camera, date, orientation tag, etc.) will be removed.',
      });
    } else if (!enc.metadata.exif) {
      losses.push({
        kind: 'exif',
        severity: 'metadata',
        message: `EXIF metadata will be removed because the ${name} encoder in use cannot embed it${m.hasGps ? ' (this includes the GPS location)' : ''}.`,
      });
    } else {
      if (target.metadataMode === 'strip-gps' && m.hasGps) {
        losses.push({
          kind: 'gps',
          severity: 'metadata',
          message: 'The GPS location will be removed from EXIF. Every other EXIF tag (camera, timestamps, settings) is kept.',
        });
      }
      if (m.orientation !== undefined && m.orientation !== 1) {
        losses.push({
          kind: 'orientation',
          severity: 'metadata',
          message: `The EXIF Orientation tag (${m.orientation}) will be rewritten to 1. Airgap stores the pixels upright, so carrying the original tag would make viewers rotate the image twice. This is the one tag "preserve all" alters.`,
        });
      }
    }
  }

  if (m.hasXmp) {
    if (target.metadataMode === 'strip-all') {
      losses.push({ kind: 'xmp', severity: 'metadata', message: 'XMP metadata will be removed.' });
    } else if (target.metadataMode === 'strip-gps') {
      losses.push({
        kind: 'xmp',
        severity: 'metadata',
        message: 'XMP metadata will be removed: it can carry location data too, and Airgap does not edit XMP selectively.',
      });
    } else if (!enc.metadata.xmp) {
      losses.push({
        kind: 'xmp',
        severity: 'metadata',
        message: `XMP metadata will be removed because the ${name} encoder in use cannot embed it.`,
      });
    }
  }

  if (m.hasIcc && !dec.decodeAppliesIcc) {
    if (target.iccMode === 'strip') {
      losses.push({
        kind: 'icc',
        severity: 'metadata',
        message:
          'The embedded ICC colour profile will be removed. Pixel values are copied unchanged, so viewers will interpret them as sRGB; colours may render wrong if the profile was not sRGB. Values preserved, appearance not.',
      });
    } else if (target.iccMode === 'preserve' && !enc.metadata.icc) {
      losses.push({
        kind: 'icc',
        severity: 'metadata',
        message: `The ICC colour profile will be removed because the ${name} encoder in use cannot embed it. Pixel values are unchanged; colours may render wrong. Values preserved, appearance not.`,
      });
    }
  }

  return losses;
}

/** True when the conversion keeps every visible pixel value. Metadata losses do not count. */
export function isPixelLossless(losses: Loss[]): boolean {
  return !losses.some((l) => l.severity === 'pixels');
}

/** True only when nothing at all is listed. */
export function isFullyLossless(losses: Loss[]): boolean {
  return losses.length === 0;
}

/** The flatten rule: alpha source into a format/codec without alpha needs an explicit background. */
export function needsFlatten(source: SourceDescription, encoder: CodecCapabilities): boolean {
  return source.metadata.hasAlpha && !encoder.alpha;
}

export function label(format: ImageFormat): string {
  switch (format) {
    case 'png':
      return 'PNG';
    case 'jpeg':
      return 'JPEG';
    case 'webp':
      return 'WebP';
    case 'avif':
      return 'AVIF';
    case 'jxl':
      return 'JPEG XL';
    case 'tiff':
      return 'TIFF';
  }
}
