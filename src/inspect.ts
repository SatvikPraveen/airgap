/**
 * Pure container-header inspection. No DOM, no decoding.
 *
 * Reads just enough of PNG / JPEG / WebP to answer: what format, what
 * dimensions, what bit depth, is there alpha, EXIF (and GPS), ICC, animation.
 * Everything the loss-warning panel needs to know BEFORE pixels are decoded.
 */
import type { ImageFormat, ImageMetadata } from './codecs/types';

export type HeaderMetadata = Omit<ImageMetadata, 'hasTransparency' | 'hasSemiTransparency'>;

export interface HeaderInfo {
  format: ImageFormat;
  width: number;
  height: number;
  metadata: HeaderMetadata;
}

export class UnsupportedFormatError extends Error {
  override name = 'UnsupportedFormatError';
}

export function inspect(bytes: Uint8Array): HeaderInfo {
  if (isPng(bytes)) return inspectPng(bytes);
  if (isJpeg(bytes)) return inspectJpeg(bytes);
  if (isWebp(bytes)) return inspectWebp(bytes);
  throw new UnsupportedFormatError(
    'Unrecognised file. Phase 1 supports PNG, JPEG and WebP input only.',
  );
}

export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  if (isPng(bytes)) return 'png';
  if (isJpeg(bytes)) return 'jpeg';
  if (isWebp(bytes)) return 'webp';
  return null;
}

// ---------------------------------------------------------------- helpers

function ascii(bytes: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i] ?? 0);
  return s;
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}
function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}

// -------------------------------------------------------------------- PNG

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(b: Uint8Array): boolean {
  return b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v);
}

function inspectPng(b: Uint8Array): HeaderInfo {
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 2;
  let hasTrns = false;
  let hasIcc = false;
  let hasExif = false;
  let hasGps = false;
  let isAnimated = false;
  let orientation: number | undefined;
  let sawIhdr = false;

  while (off + 8 <= b.length) {
    const len = u32be(b, off);
    const type = ascii(b, off + 4, 4);
    const dataOff = off + 8;
    if (dataOff + len > b.length) break;
    if (type === 'IHDR') {
      sawIhdr = true;
      width = u32be(b, dataOff);
      height = u32be(b, dataOff + 4);
      bitDepth = b[dataOff + 8]!;
      colorType = b[dataOff + 9]!;
    } else if (type === 'tRNS') {
      hasTrns = true;
    } else if (type === 'iCCP') {
      hasIcc = true;
    } else if (type === 'acTL') {
      isAnimated = true;
    } else if (type === 'eXIf') {
      hasExif = true;
      const tiff = parseTiff(b.subarray(dataOff, dataOff + len));
      hasGps = tiff.hasGps;
      orientation = tiff.orientation;
    } else if (type === 'IEND') {
      break;
    }
    off = dataOff + len + 4; // + CRC
  }
  if (!sawIhdr) throw new UnsupportedFormatError('PNG is missing its IHDR chunk.');

  // Colour types: 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA.
  const hasAlpha = colorType === 4 || colorType === 6 || hasTrns;
  // Palette entries are always 8-bit samples; sub-8-bit gray/RGB expands losslessly.
  const effectiveBitDepth = colorType === 3 ? 8 : bitDepth;

  const metadata: HeaderMetadata = {
    bitDepth: effectiveBitDepth,
    hasAlpha,
    hasExif,
    hasGps,
    hasIcc,
    isAnimated,
    sourceLossless: true,
  };
  if (orientation !== undefined) metadata.orientation = orientation;
  return { format: 'png', width, height, metadata };
}

// ------------------------------------------------------------------- JPEG

function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function inspectJpeg(b: Uint8Array): HeaderInfo {
  let off = 2;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let hasExif = false;
  let hasGps = false;
  let hasIcc = false;
  let orientation: number | undefined;

  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1]!;
    if (marker === 0xff) {
      off++;
      continue;
    }
    // Standalone markers without a length field.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI or start of scan: headers are done.
    const segLen = u16be(b, off + 2);
    const dataOff = off + 4;
    const dataLen = segLen - 2;
    if (dataOff + dataLen > b.length) break;

    if (marker === 0xe1 && ascii(b, dataOff, 6) === 'Exif\0\0') {
      hasExif = true;
      const tiff = parseTiff(b.subarray(dataOff + 6, dataOff + dataLen));
      hasGps = hasGps || tiff.hasGps;
      if (tiff.orientation !== undefined) orientation = tiff.orientation;
    } else if (marker === 0xe2 && ascii(b, dataOff, 12) === 'ICC_PROFILE\0') {
      hasIcc = true;
    } else if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      // SOFn: precision, height, width.
      bitDepth = b[dataOff]!;
      height = u16be(b, dataOff + 1);
      width = u16be(b, dataOff + 3);
    }
    off = dataOff + dataLen;
  }

  const metadata: HeaderMetadata = {
    bitDepth,
    hasAlpha: false,
    hasExif,
    hasGps,
    hasIcc,
    isAnimated: false,
    sourceLossless: false,
  };
  if (orientation !== undefined) metadata.orientation = orientation;
  return { format: 'jpeg', width, height, metadata };
}

// ------------------------------------------------------------------- TIFF (EXIF payload)

const TAG_ORIENTATION = 0x0112;
const TAG_GPS_IFD = 0x8825;

/** Reads IFD0 of a TIFF structure for the Orientation tag and a GPS IFD pointer. */
export function parseTiff(t: Uint8Array): { hasGps: boolean; orientation?: number } {
  const out: { hasGps: boolean; orientation?: number } = { hasGps: false };
  if (t.length < 8) return out;
  const bo = ascii(t, 0, 2);
  let le: boolean;
  if (bo === 'II') le = true;
  else if (bo === 'MM') le = false;
  else return out;
  const r16 = (o: number) => (le ? t[o]! | (t[o + 1]! << 8) : (t[o]! << 8) | t[o + 1]!);
  const r32 = (o: number) => (le ? u32le(t, o) : u32be(t, o));
  if (r16(2) !== 42) return out;
  const ifd0 = r32(4);
  if (ifd0 + 2 > t.length) return out;
  const count = r16(ifd0);
  for (let i = 0; i < count; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > t.length) break;
    const tag = r16(e);
    const type = r16(e + 2);
    if (tag === TAG_GPS_IFD) out.hasGps = true;
    if (tag === TAG_ORIENTATION && type === 3) out.orientation = r16(e + 8);
  }
  return out;
}

// ------------------------------------------------------------------- WebP

function isWebp(b: Uint8Array): boolean {
  return b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP';
}

const VP8X_ICC = 0x20;
const VP8X_ALPHA = 0x10;
const VP8X_EXIF = 0x08;
const VP8X_ANIM = 0x02;

function inspectWebp(b: Uint8Array): HeaderInfo {
  let off = 12;
  let width = 0;
  let height = 0;
  let hasAlpha = false;
  let hasIcc = false;
  let hasExif = false;
  let hasGps = false;
  let isAnimated = false;
  let sourceLossless = false;
  let sawBitstream = false;
  let orientation: number | undefined;

  while (off + 8 <= b.length) {
    const type = ascii(b, off, 4);
    const len = u32le(b, off + 4);
    const dataOff = off + 8;
    if (dataOff + len > b.length) break;
    if (type === 'VP8X') {
      const flags = b[dataOff]!;
      hasIcc = (flags & VP8X_ICC) !== 0;
      hasAlpha = (flags & VP8X_ALPHA) !== 0;
      hasExif = (flags & VP8X_EXIF) !== 0;
      isAnimated = (flags & VP8X_ANIM) !== 0;
      width = u24le(b, dataOff + 4) + 1;
      height = u24le(b, dataOff + 7) + 1;
    } else if (type === 'VP8L') {
      sawBitstream = true;
      sourceLossless = true;
      // VP8L header: 0x2f, then 14 bits width-1, 14 bits height-1, 1 bit alpha_is_used.
      const bits = u32le(b, dataOff + 1);
      if (!width) width = (bits & 0x3fff) + 1;
      if (!height) height = ((bits >>> 14) & 0x3fff) + 1;
      if ((bits >>> 28) & 1) hasAlpha = true;
    } else if (type === 'VP8 ') {
      sawBitstream = true;
      // Lossy key frame: 3-byte frame tag, 3-byte start code, then 14-bit dims.
      if (!width) width = readLe14(b, dataOff + 6);
      if (!height) height = readLe14(b, dataOff + 8);
    } else if (type === 'ALPH') {
      hasAlpha = true;
    } else if (type === 'EXIF') {
      hasExif = true;
      const tiff = parseTiff(b.subarray(dataOff, dataOff + len));
      hasGps = tiff.hasGps;
      if (tiff.orientation !== undefined) orientation = tiff.orientation;
    } else if (type === 'ANIM' || type === 'ANMF') {
      isAnimated = true;
    }
    off = dataOff + len + (len & 1); // chunks are padded to even sizes
  }
  if (!sawBitstream && !isAnimated) {
    throw new UnsupportedFormatError('WebP file contains no VP8/VP8L bitstream.');
  }
  const metadata: HeaderMetadata = {
    bitDepth: 8,
    hasAlpha,
    hasExif,
    hasGps,
    hasIcc,
    isAnimated,
    sourceLossless,
  };
  if (orientation !== undefined) metadata.orientation = orientation;
  return { format: 'webp', width, height, metadata };
}

function readLe14(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8)) & 0x3fff;
}
