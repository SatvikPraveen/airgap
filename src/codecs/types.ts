/** Formats supported in Phase 3. HEIC is deliberately absent (see README). */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'jxl' | 'tiff' | 'qoi';

export const FORMATS: ImageFormat[] = ['png', 'jpeg', 'webp', 'avif', 'jxl', 'tiff', 'qoi'];

export const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  jxl: 'image/jxl',
  tiff: 'image/tiff',
  qoi: 'image/qoi', // not IANA-registered; the de facto type
};

export const EXTENSION: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  jxl: 'jxl',
  tiff: 'tif',
  qoi: 'qoi',
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

export interface ColorDescription {
  primaries: number;
  transfer: number;
  matrix?: number;
  fullRange?: boolean;
}

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
  /** EXIF carries an IFD1 thumbnail image. */
  hasThumbnail?: boolean;
  hasIcc: boolean;
  hasXmp: boolean;
  /**
   * EXIF / XMP is present but its bytes cannot be read (a Brotli-compressed JPEG XL `brob`
   * box): it can be neither carried nor cleaned, and whether it holds a location is unknown.
   */
  exifOpaque?: boolean;
  xmpOpaque?: boolean;
  /** Parsed ICC facts, when the profile bytes were extracted. */
  iccKind?: IccKind;
  iccDescription?: string;
  /** The profile can be evaluated exactly to sRGB (matrix/TRC, or a supported RGB LUT). */
  iccConvertible?: boolean;
  /** EXIF orientation tag value as stored in the file (1 = upright). */
  orientation?: number;
  /** The decoder already rotated the pixels (libjxl does); do not apply `orientation` again. */
  orientationApplied?: boolean;
  /** AVIF irot/imir properties present (applied by viewers, not by libavif's RGB output). */
  hasTransformProperties?: boolean;
  /**
   * CICP (ITU-T H.273) colour description declared by the container: AVIF `colr`/nclx,
   * JPEG XL colour encoding, PNG `cICP`. Code points as in the spec (primaries 1 = BT.709,
   * 9 = BT.2020, 12 = Display P3; transfer 13 = sRGB, 16 = PQ, 18 = HLG). Absent when the
   * container says nothing, or only says "unspecified".
   */
  colorDescription?: ColorDescription;
  /** Animated container or multi-page file. */
  isAnimated: boolean;
  /** APNG facts from the header, for display and the memory guard. */
  animationInfo?: { frames: number; loops: number; durationMs: number; hiddenDefault: boolean; /** every delay is a whole number of milliseconds */ delaysWholeMs: boolean };
  /** For WebP/AVIF/JXL: the source was stored losslessly. */
  sourceLossless?: boolean;
  /** How samples are laid out in the container, for display: e.g. "palette (43 colours), 8-bit". */
  colorLayout?: string;
  /** Raw payloads, when present and extracted: EXIF is a TIFF-structured blob. */
  exif?: Uint8Array;
  icc?: Uint8Array;
  xmp?: Uint8Array;
}

/** One displayed frame of an animation: the whole canvas, already composited. */
export interface AnimationFrame {
  pixels: PixelData;
  /** Delay as the fraction delayNum / delayDen seconds (APNG semantics; den 0 is read as 100). */
  delayNum: number;
  delayDen: number;
}

export interface Animation {
  frames: AnimationFrame[];
  /** Number of plays; 0 = forever. */
  loops: number;
  /** The still (default) image is not one of the frames (APNG: IDAT without a preceding fcTL). */
  hiddenDefault: boolean;
}

export interface DecodedImage {
  /** The still image: what a viewer without animation support shows. */
  pixels: PixelData;
  metadata: ImageMetadata;
  /** Every frame, when the decoder reads animations and the source is animated. */
  animation?: Animation;
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
  /** Reads every frame of an animated source and writes animations, frames and timing exact (probed). */
  animation?: boolean;
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
