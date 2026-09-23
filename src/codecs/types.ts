/** Formats supported in Phase 1. */
export type ImageFormat = 'png' | 'jpeg' | 'webp';

export const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const EXTENSION: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

/**
 * Everything we can learn about a source file WITHOUT decoding pixels,
 * by reading container headers (see src/inspect.ts), plus two pixel-derived
 * facts filled in after decoding.
 */
export interface ImageMetadata {
  /** Bits per channel as stored in the source file (8 or 16 for PNG, 8/12 for JPEG). */
  bitDepth: number;
  /** The container declares an alpha channel (or a tRNS chunk). */
  hasAlpha: boolean;
  /** At least one decoded pixel has alpha < 255. Only known after decoding. */
  hasTransparency: boolean;
  /** At least one decoded pixel has 0 < alpha < 255. Only known after decoding. */
  hasSemiTransparency: boolean;
  /** EXIF segment/chunk present. */
  hasExif: boolean;
  /** EXIF contains a GPS IFD (location data). */
  hasGps: boolean;
  /** Embedded ICC colour profile present. */
  hasIcc: boolean;
  /** EXIF orientation tag value (1 = normal). Undefined if absent. */
  orientation?: number;
  /** Animated container (APNG / animated WebP). Only the first frame is decoded. */
  isAnimated: boolean;
  /** For WebP: whether the source was stored losslessly (VP8L). */
  sourceLossless?: boolean;
}

export interface DecodedImage {
  /** 8-bit RGBA, non-premultiplied as returned by the decoder. */
  pixels: ImageData;
  metadata: ImageMetadata;
  /** Bit depth of `pixels` (always 8 for the canvas codec). */
  bitDepth: number;
}

export interface EncodeOptions {
  /** 0..1, only meaningful when encoding lossily. */
  quality?: number;
  /** Request lossless encoding (PNG always; WebP only if the codec supports it). */
  lossless?: boolean;
}

export interface CodecCapabilities {
  /** The encoder can round-trip 8-bit RGBA pixels exactly (see `premultipliedAlpha`). */
  lossless: boolean;
  /** The target format keeps an alpha channel. */
  alpha: boolean;
  /** Highest bit depth the codec can encode. */
  maxBitDepth: number;
  /** The encoder carries EXIF / ICC through. The canvas codec never does. */
  keepsMetadata: boolean;
  /**
   * The codec routes pixels through a premultiplied-alpha buffer, which
   * rounds the RGB of semi-transparent pixels. This is a property of the
   * canvas pipeline, not of the file format.
   */
  premultipliedAlpha: boolean;
}

export interface Codec {
  format: ImageFormat;
  capabilities: CodecCapabilities;
  decode(bytes: Uint8Array): Promise<DecodedImage>;
  encode(img: DecodedImage, opts: EncodeOptions): Promise<Uint8Array>;
}

/** Serialisable capability table sent from the worker to the UI. */
export type CapabilityTable = Record<ImageFormat, CodecCapabilities>;
