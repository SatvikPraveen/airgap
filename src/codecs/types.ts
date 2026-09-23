/** Formats supported in Phase 3. HEIC is deliberately absent (see README). */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'jxl' | 'tiff';

export const FORMATS: ImageFormat[] = ['png', 'jpeg', 'webp', 'avif', 'jxl', 'tiff'];

export const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  jxl: 'image/jxl',
  tiff: 'image/tiff',
};

export const EXTENSION: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  jxl: 'jxl',
  tiff: 'tif',
};

/**
 * RGBA pixel buffer, NON-premultiplied, stored upright (EXIF orientation
 * already applied). 8-bit data lives in a Uint8ClampedArray; anything deeper
 * in a Uint16Array holding values in [0, 2^bitDepth).
 */
export interface PixelData {
  width: number;
  height: number;
  /** 8, 10, 12 or 16. */
  bitDepth: number;
  data: Uint8ClampedArray | Uint16Array;
}

export type IccKind = 'matrix' | 'lut' | 'gray' | 'unknown';

/**
 * What we know about a source image: container facts (from src/inspect.ts),
 * pixel-derived facts (filled after decoding), and the raw metadata payloads
 * the codecs can carry through.
 */
export interface ImageMetadata {
  /** Bits per channel as stored in the source file. */
  bitDepth: number;
  /** The header parser could not determine the depth; `bitDepth` is a guess. */
  bitDepthUncertain?: boolean;
  /** The container declares an alpha channel (or PNG tRNS). */
  hasAlpha: boolean;
  /** Alpha samples are premultiplied in the file (TIFF associated alpha). */
  alphaAssociated?: boolean;
  /** At least one decoded pixel has alpha < max. Known after decoding. */
  hasTransparency: boolean;
  /** At least one decoded pixel has 0 < alpha < max. Known after decoding. */
  hasSemiTransparency: boolean;
  hasExif: boolean;
  hasGps: boolean;
  /** EXIF carries a MakerNote blob (opaque, may hold location). */
  hasMakerNote?: boolean;
  /** EXIF carries an IFD1 thumbnail with its own metadata segments. */
  thumbnailHasMetadata?: boolean;
  hasIcc: boolean;
  hasXmp: boolean;
  /** Parsed ICC facts, when the profile bytes were extracted. */
  iccKind?: IccKind;
  iccDescription?: string;
  /** EXIF orientation tag value as stored in the file (1 = upright). */
  orientation?: number;
  /** The decoder already rotated the pixels (libjxl does); do not apply `orientation` again. */
  orientationApplied?: boolean;
  /** AVIF irot/imir properties present (applied by viewers, not by libavif's RGB output). */
  hasTransformProperties?: boolean;
  /** Animated container or multi-page file. Only the first frame/page is used. */
  isAnimated: boolean;
  /** For WebP/AVIF/JXL: the source was stored losslessly. */
  sourceLossless?: boolean;
  /** Raw payloads, when present and extracted: EXIF is a TIFF-structured blob. */
  exif?: Uint8Array;
  icc?: Uint8Array;
  xmp?: Uint8Array;
}

export interface DecodedImage {
  pixels: PixelData;
  metadata: ImageMetadata;
}

export interface EncodeOptions {
  /** 0..1, only meaningful when encoding lossily. */
  quality?: number;
  /** Request lossless encoding. */
  lossless?: boolean;
  /** Metadata payloads to embed. Ignored by codecs whose capabilities say they cannot. */
  exif?: Uint8Array;
  icc?: Uint8Array;
  xmp?: Uint8Array;
}

/**
 * Declared by each codec, then CORRECTED by a runtime probe (src/codecs/probe.ts)
 * before anything trusts it. The UI and capabilities.ts only ever see probed
 * values: a capability that could not be demonstrated in the running browser
 * is reported as false.
 */
export interface CodecCapabilities {
  decode: boolean;
  encode: boolean;
  /** Encoder can reproduce pixel values exactly (at least for opaque pixels). */
  lossless: boolean;
  /** The format/codec keeps an alpha channel. */
  alpha: boolean;
  /**
   * Alpha handling is exact end to end: semi-transparent RGB is not rounded
   * and RGB under alpha 0 survives. False for anything routed through a
   * premultiplied canvas. Only meaningful when `alpha` is true.
   */
  exactAlpha: boolean;
  /** Highest bit depth the decoder delivers (8 for canvas). */
  decodeBitDepth: number;
  /**
   * The decoder was shown to reproduce pixel values exactly (its round trip with the
   * paired encoder was identical on opaque pixels, cross-checked independently where
   * possible). False when that could not be demonstrated; capabilities.ts then reports a
   * pixel loss for sources read by this decoder.
   */
  decodeExact: boolean;
  /** The decoder converts through the embedded ICC profile to sRGB and this cannot be turned off. */
  decodeAppliesIcc: boolean;
  /** Bit depths the encoder can write, ascending. */
  encodeBitDepths: number[];
  /** Which metadata payloads the encoder can embed. */
  metadata: { exif: boolean; icc: boolean; xmp: boolean };
}

export interface Codec {
  /** Stable identifier, e.g. 'wasm-png', 'canvas-png'. Never used for logic; only for display and tests. */
  id: string;
  format: ImageFormat;
  capabilities: CodecCapabilities;
  decode(bytes: Uint8Array): Promise<DecodedImage>;
  encode(img: DecodedImage, opts: EncodeOptions): Promise<Uint8Array>;
}

/** Outcome of probing one codec in the running browser. */
export interface ProbeReport {
  codecId: string;
  ok: boolean;
  /** Human-readable summary of what was demonstrated. */
  detail: string;
  /** Claimed capability -> what the probe found, for the ones it checked. */
  checks: Record<string, { claimed: boolean; verified: boolean }>;
}

/** A codec chosen for one role of one format, with post-probe capabilities. */
export interface ResolvedCodec {
  codecId: string;
  capabilities: CodecCapabilities;
  probe: ProbeReport;
}

/** Serialisable table the worker sends to the UI as codecs get resolved. */
export type CapabilityTable = Partial<Record<ImageFormat, { decode?: ResolvedCodec; encode?: ResolvedCodec }>>;
