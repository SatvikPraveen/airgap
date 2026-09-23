/**
 * Pure container-header inspection. No DOM, no decoding.
 *
 * Reads just enough of PNG / JPEG / WebP / AVIF / JPEG XL / TIFF to answer:
 * what format, what dimensions, what bit depth, is there alpha, EXIF (and
 * GPS), ICC, XMP, animation. Everything the loss-warning panel needs to know
 * BEFORE pixels are decoded.
 */
import type { ImageFormat, ImageMetadata } from './codecs/types';
import { findEntry, parseTiffStructure, readNumber, readNumbers, TAG } from './metadata/tiff-ifd';

export type HeaderMetadata = Omit<ImageMetadata, 'hasTransparency' | 'hasSemiTransparency' | 'exif' | 'icc' | 'xmp' | 'iccKind' | 'iccDescription'>;

export interface HeaderInfo {
  format: ImageFormat;
  width: number;
  height: number;
  metadata: HeaderMetadata;
}

export class UnsupportedFormatError extends Error {
  override name = 'UnsupportedFormatError';
}

const UNSUPPORTED = 'Unrecognised file. Airgap reads PNG, JPEG, WebP, AVIF, JPEG XL and TIFF.';

export function inspect(bytes: Uint8Array): HeaderInfo {
  const format = sniffFormat(bytes);
  switch (format) {
    case 'png':
      return inspectPng(bytes);
    case 'jpeg':
      return inspectJpeg(bytes);
    case 'webp':
      return inspectWebp(bytes);
    case 'avif':
      return inspectAvif(bytes);
    case 'jxl':
      return inspectJxl(bytes);
    case 'tiff':
      return inspectTiff(bytes);
    default:
      throw new UnsupportedFormatError(UNSUPPORTED);
  }
}

export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  if (isPng(bytes)) return 'png';
  if (isJpeg(bytes)) return 'jpeg';
  if (isWebp(bytes)) return 'webp';
  if (isJxl(bytes)) return 'jxl';
  if (isAvif(bytes)) return 'avif';
  if (isTiff(bytes)) return 'tiff';
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

function baseMeta(partial: Partial<HeaderMetadata> & { bitDepth: number; hasAlpha: boolean }): HeaderMetadata {
  return {
    hasExif: false,
    hasGps: false,
    hasIcc: false,
    hasXmp: false,
    isAnimated: false,
    ...partial,
  };
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
  let hasXmp = false;
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
    } else if (type === 'tRNS') hasTrns = true;
    else if (type === 'iCCP') hasIcc = true;
    else if (type === 'acTL') isAnimated = true;
    else if (type === 'eXIf') {
      hasExif = true;
      const tiff = parseTiff(b.subarray(dataOff, dataOff + len));
      hasGps = tiff.hasGps;
      orientation = tiff.orientation;
    } else if (type === 'iTXt' && ascii(b, dataOff, 17) === 'XML:com.adobe.xmp') hasXmp = true;
    else if (type === 'IEND') break;
    off = dataOff + len + 4;
  }
  if (!sawIhdr) throw new UnsupportedFormatError('PNG is missing its IHDR chunk.');

  const hasAlpha = colorType === 4 || colorType === 6 || hasTrns;
  const metadata = baseMeta({
    bitDepth: colorType === 3 ? 8 : bitDepth,
    hasAlpha,
    hasExif,
    hasGps,
    hasIcc,
    hasXmp,
    isAnimated,
    sourceLossless: true,
  });
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
  let hasXmp = false;
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
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const segLen = u16be(b, off + 2);
    const dataOff = off + 4;
    const dataLen = segLen - 2;
    if (dataOff + dataLen > b.length) break;

    if (marker === 0xe1 && ascii(b, dataOff, 6) === 'Exif\0\0') {
      hasExif = true;
      const tiff = parseTiff(b.subarray(dataOff + 6, dataOff + dataLen));
      hasGps = hasGps || tiff.hasGps;
      if (tiff.orientation !== undefined) orientation = tiff.orientation;
    } else if (marker === 0xe1 && ascii(b, dataOff, 29) === 'http://ns.adobe.com/xap/1.0/\0') {
      hasXmp = true;
    } else if (marker === 0xe2 && ascii(b, dataOff, 12) === 'ICC_PROFILE\0') {
      hasIcc = true;
    } else if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      bitDepth = b[dataOff]!;
      height = u16be(b, dataOff + 1);
      width = u16be(b, dataOff + 3);
    }
    off = dataOff + dataLen;
  }

  const metadata = baseMeta({ bitDepth, hasAlpha: false, hasExif, hasGps, hasIcc, hasXmp, sourceLossless: false });
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
const VP8X_XMP = 0x04;
const VP8X_ANIM = 0x02;

function inspectWebp(b: Uint8Array): HeaderInfo {
  let off = 12;
  let width = 0;
  let height = 0;
  let hasAlpha = false;
  let hasIcc = false;
  let hasExif = false;
  let hasGps = false;
  let hasXmp = false;
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
      hasXmp = (flags & VP8X_XMP) !== 0;
      isAnimated = (flags & VP8X_ANIM) !== 0;
      width = u24le(b, dataOff + 4) + 1;
      height = u24le(b, dataOff + 7) + 1;
    } else if (type === 'VP8L') {
      sawBitstream = true;
      sourceLossless = true;
      const bits = u32le(b, dataOff + 1);
      if (!width) width = (bits & 0x3fff) + 1;
      if (!height) height = ((bits >>> 14) & 0x3fff) + 1;
      if ((bits >>> 28) & 1) hasAlpha = true;
    } else if (type === 'VP8 ') {
      sawBitstream = true;
      if (!width) width = readLe14(b, dataOff + 6);
      if (!height) height = readLe14(b, dataOff + 8);
    } else if (type === 'ALPH') hasAlpha = true;
    else if (type === 'EXIF') {
      hasExif = true;
      const start = ascii(b, dataOff, 6) === 'Exif\0\0' ? dataOff + 6 : dataOff;
      const tiff = parseTiff(b.subarray(start, dataOff + len));
      hasGps = tiff.hasGps;
      if (tiff.orientation !== undefined) orientation = tiff.orientation;
    } else if (type === 'ICCP') hasIcc = true;
    else if (type === 'XMP ') hasXmp = true;
    else if (type === 'ANIM' || type === 'ANMF') isAnimated = true;
    off = dataOff + len + (len & 1);
  }
  if (!sawBitstream && !isAnimated) throw new UnsupportedFormatError('WebP file contains no VP8/VP8L bitstream.');
  const metadata = baseMeta({ bitDepth: 8, hasAlpha, hasExif, hasGps, hasIcc, hasXmp, isAnimated, sourceLossless });
  if (orientation !== undefined) metadata.orientation = orientation;
  return { format: 'webp', width, height, metadata };
}

function readLe14(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8)) & 0x3fff;
}

// ------------------------------------------------------------------- AVIF (ISOBMFF)

function isAvif(b: Uint8Array): boolean {
  if (b.length < 16 || ascii(b, 4, 4) !== 'ftyp') return false;
  const size = u32be(b, 0);
  const end = Math.min(b.length, size);
  for (let o = 8; o + 4 <= end; o += 4) {
    const brand = ascii(b, o, 4);
    if (brand === 'avif' || brand === 'avis') return true;
  }
  return false;
}

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let off = start;
  while (off + 8 <= end) {
    let size = u32be(b, off);
    const type = ascii(b, off + 4, 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      // 64-bit size: use the low 32 bits (files here are far below 4 GB).
      size = u32be(b, off + 12);
      header = 16;
    } else if (size === 0) size = end - off;
    if (size < header || off + size > end) return;
    yield { type, start: off + header, end: off + size };
    off += size;
  }
}

/** FullBox: skip 4 bytes of version+flags. */
function fullBoxPayload(box: Box): number {
  return box.start + 4;
}

function inspectAvif(b: Uint8Array): HeaderInfo {
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let bitDepthUncertain = true;
  let hasAlpha = false;
  let hasIcc = false;
  let hasExif = false;
  let hasGps = false;
  let hasXmp = false;
  let isAnimated = false;
  let hasTransformProperties = false;
  const exifItems: number[] = [];
  let iloc: Box | undefined;

  for (const top of boxes(b, 0, b.length)) {
    if (top.type === 'ftyp') {
      for (let o = top.start; o + 4 <= top.end; o += 4) if (ascii(b, o, 4) === 'avis') isAnimated = true;
    } else if (top.type === 'meta') {
      for (const m of boxes(b, fullBoxPayload(top), top.end)) {
        if (m.type === 'iprp') {
          for (const ip of boxes(b, m.start, m.end)) {
            if (ip.type !== 'ipco') continue;
            for (const p of boxes(b, ip.start, ip.end)) {
              if (p.type === 'ispe' && !width) {
                width = u32be(b, fullBoxPayload(p));
                height = u32be(b, fullBoxPayload(p) + 4);
              } else if (p.type === 'av1C' && bitDepthUncertain) {
                // av1C: marker/version byte, then seq_profile(3)+seq_level_idx(5), then
                // seq_tier(1) high_bitdepth(1) twelve_bit(1) monochrome(1) ...
                const byte2 = b[p.start + 2]!;
                const high = (byte2 >> 6) & 1;
                const twelve = (byte2 >> 5) & 1;
                bitDepth = high ? (twelve ? 12 : 10) : 8;
                bitDepthUncertain = false;
              } else if (p.type === 'auxC') {
                const urn = ascii(b, fullBoxPayload(p), Math.min(64, p.end - fullBoxPayload(p)));
                if (urn.includes('alpha')) hasAlpha = true;
              } else if (p.type === 'colr') {
                if (ascii(b, p.start, 4) === 'prof' || ascii(b, p.start, 4) === 'rICC') hasIcc = true;
              } else if (p.type === 'irot' || p.type === 'imir') {
                hasTransformProperties = true;
              }
            }
          }
        } else if (m.type === 'iinf') {
          const version = b[m.start]!;
          const countOff = fullBoxPayload(m);
          const count = version === 0 ? u16be(b, countOff) : u32be(b, countOff);
          const listStart = countOff + (version === 0 ? 2 : 4);
          let n = 0;
          for (const inf of boxes(b, listStart, m.end)) {
            if (inf.type !== 'infe' || n++ >= count) continue;
            const v = b[inf.start]!;
            if (v < 2) continue;
            const idOff = fullBoxPayload(inf);
            const itemId = v === 2 ? u16be(b, idOff) : u32be(b, idOff);
            const typeOff = idOff + (v === 2 ? 2 : 4) + 2;
            const itemType = ascii(b, typeOff, 4);
            if (itemType === 'Exif') {
              hasExif = true;
              exifItems.push(itemId);
            } else if (itemType === 'mime') {
              const nameEnd = indexOfZero(b, typeOff + 4, inf.end);
              const ct = ascii(b, nameEnd + 1, Math.min(32, inf.end - nameEnd - 1));
              if (ct.startsWith('application/rdf+xml')) hasXmp = true;
            }
          }
        } else if (m.type === 'iloc') {
          iloc = m;
        }
      }
    }
  }
  // GPS presence: locate the Exif item's bytes through iloc (single extent, offsets in file).
  if (hasExif && iloc && exifItems.length) {
    const exif = readIlocItem(b, iloc, exifItems[0]!);
    if (exif) {
      // AVIF Exif item: 4-byte offset to the TIFF header, then the payload.
      const skip = u32be(exif, 0);
      const tiff = exif.subarray(4 + skip);
      hasGps = parseTiff(tiff).hasGps;
    }
  }
  const metadata = baseMeta({ bitDepth, hasAlpha, hasExif, hasGps, hasIcc, hasXmp, isAnimated });
  if (bitDepthUncertain) metadata.bitDepthUncertain = true;
  if (hasTransformProperties) metadata.hasTransformProperties = true;
  return { format: 'avif', width, height, metadata };
}

function indexOfZero(b: Uint8Array, from: number, to: number): number {
  for (let i = from; i < to; i++) if (b[i] === 0) return i;
  return to;
}

/** Minimal iloc reader: first extent of the given item, construction_method 0 (file offsets). */
export function readIlocItem(b: Uint8Array, iloc: Box, wantId: number): Uint8Array | null {
  const version = b[iloc.start]!;
  let o = fullBoxPayload(iloc);
  const sizes = b[o]!;
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 15;
  const sizes2 = b[o + 1]!;
  const baseOffsetSize = sizes2 >> 4;
  const indexSize = version === 1 || version === 2 ? sizes2 & 15 : 0;
  o += 2;
  const itemCount = version < 2 ? u16be(b, o) : u32be(b, o);
  o += version < 2 ? 2 : 4;
  const readN = (size: number): number => {
    let v = 0;
    if (size === 4) v = u32be(b, o);
    else if (size === 8) v = u32be(b, o + 4); // low 32 bits
    o += size;
    return v;
  };
  for (let i = 0; i < itemCount; i++) {
    const itemId = version < 2 ? u16be(b, o) : u32be(b, o);
    o += version < 2 ? 2 : 4;
    let constructionMethod = 0;
    if (version === 1 || version === 2) {
      constructionMethod = u16be(b, o) & 15;
      o += 2;
    }
    o += 2; // data_reference_index
    const baseOffset = readN(baseOffsetSize);
    const extentCount = u16be(b, o);
    o += 2;
    for (let e = 0; e < extentCount; e++) {
      if (indexSize) readN(indexSize);
      const extentOffset = readN(offsetSize);
      const extentLength = readN(lengthSize);
      if (itemId === wantId && e === 0 && constructionMethod === 0) {
        const start = baseOffset + extentOffset;
        if (start + extentLength <= b.length) return b.subarray(start, start + extentLength);
        return null;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------- JPEG XL

const JXL_CONTAINER = [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];

function isJxl(b: Uint8Array): boolean {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0x0a) return true;
  return b.length >= 12 && JXL_CONTAINER.every((v, i) => b[i] === v);
}

class BitReader {
  private pos = 0; // bit position
  constructor(private readonly b: Uint8Array) {}
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3];
      if (byte === undefined) throw new Error('JXL header truncated');
      v |= ((byte >> (this.pos & 7)) & 1) << i;
      this.pos++;
    }
    return v >>> 0;
  }
  bool(): boolean {
    return this.bits(1) === 1;
  }
  /** U32 distribution: selector picks one of four (value | bits [+offset]) encodings. */
  u32(d: [number, number][]): number {
    const sel = this.bits(2);
    const [offset, nbits] = d[sel]!;
    return offset + (nbits ? this.bits(nbits) : 0);
  }
}

function jxlCodestream(b: Uint8Array): Uint8Array | null {
  if (b[0] === 0xff && b[1] === 0x0a) return b;
  for (const box of boxes(b, 0, b.length)) {
    if (box.type === 'jxlc') return b.subarray(box.start, box.end);
    if (box.type === 'jxlp') return b.subarray(box.start + 4, box.end); // first partial: skip index
  }
  return null;
}

function inspectJxl(b: Uint8Array): HeaderInfo {
  let hasExif = false;
  let hasGps = false;
  let hasXmp = false;
  if (!(b[0] === 0xff && b[1] === 0x0a)) {
    for (const box of boxes(b, 0, b.length)) {
      if (box.type === 'Exif') {
        hasExif = true;
        const skip = u32be(b, box.start);
        hasGps = parseTiff(b.subarray(box.start + 4 + skip, box.end)).hasGps;
      } else if (box.type === 'xml ') hasXmp = true;
    }
  }
  const cs = jxlCodestream(b);
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let uncertain = true;
  let hasAlpha = false;
  let hasIcc = false;
  let isAnimated = false;
  let orientation: number | undefined;
  if (cs && cs[0] === 0xff && cs[1] === 0x0a) {
    try {
      const r = new BitReader(cs.subarray(2));
      // SizeHeader
      const small = r.bool();
      const readRatioSize = (h: number, ratio: number): number => {
        const ratios: [number, number][] = [
          [1, 1],
          [12, 10],
          [4, 3],
          [3, 2],
          [16, 9],
          [5, 4],
          [2, 1],
        ];
        const [n, d] = ratios[ratio - 1]!;
        return Math.floor((h * n) / d);
      };
      if (small) {
        height = (r.bits(5) + 1) * 8;
        const ratio = r.bits(3);
        width = ratio === 0 ? (r.bits(5) + 1) * 8 : readRatioSize(height, ratio);
      } else {
        height = r.u32([[1, 9], [1, 13], [1, 18], [1, 30]]);
        const ratio = r.bits(3);
        width = ratio === 0 ? r.u32([[1, 9], [1, 13], [1, 18], [1, 30]]) : readRatioSize(height, ratio);
      }
      // ImageMetadata
      const allDefault = r.bool();
      if (allDefault) {
        bitDepth = 8;
        uncertain = false;
      } else {
        const extraFields = r.bool();
        let bail = false;
        if (extraFields) {
          orientation = r.bits(3) + 1;
          const haveIntrinsic = r.bool();
          if (haveIntrinsic) {
            // intrinsic SizeHeader
            const s = r.bool();
            if (s) {
              r.bits(5);
              const ratio = r.bits(3);
              if (ratio === 0) r.bits(5);
            } else {
              r.u32([[1, 9], [1, 13], [1, 18], [1, 30]]);
              const ratio = r.bits(3);
              if (ratio === 0) r.u32([[1, 9], [1, 13], [1, 18], [1, 30]]);
            }
          }
          const havePreview = r.bool();
          if (havePreview) bail = true; // PreviewHeader: not parsed
          if (!bail) {
            const haveAnimation = r.bool();
            if (haveAnimation) {
              isAnimated = true;
              bail = true; // AnimationHeader: not parsed
            }
          }
        }
        if (!bail) {
          // BitDepth
          const float = r.bool();
          if (float) {
            bitDepth = r.u32([[32, 0], [16, 0], [24, 0], [1, 6]]);
            r.bits(4); // exp bits
          } else {
            bitDepth = r.u32([[8, 0], [10, 0], [12, 0], [1, 6]]);
          }
          uncertain = false;
          r.bool(); // modular_16_bit_buffers
          const numExtra = r.u32([[0, 0], [1, 0], [2, 4], [1, 12]]);
          let parsedAll = true;
          for (let i = 0; i < numExtra; i++) {
            const ecDefault = r.bool();
            if (ecDefault) {
              hasAlpha = true; // default extra channel is 8-bit alpha
              continue;
            }
            const type = r.u32([[0, 0], [1, 0], [2, 4], [18, 6]]);
            if (type === 0) hasAlpha = true;
            const f = r.bool();
            if (f) {
              r.u32([[32, 0], [16, 0], [24, 0], [1, 6]]);
              r.bits(4);
            } else r.u32([[8, 0], [10, 0], [12, 0], [1, 6]]);
            r.u32([[0, 0], [3, 0], [4, 0], [1, 3]]); // dim_shift
            const nameLen = r.u32([[0, 0], [0, 4], [16, 5], [48, 10]]);
            for (let k = 0; k < nameLen; k++) r.bits(8);
            if (type === 0) r.bool(); // alpha_associated
            else if (type === 2) {
              parsedAll = false; // spot colour: 4 x F16, stop here
              break;
            } else if (type === 4) r.u32([[1, 0], [0, 2], [3, 4], [19, 8]]); // cfa_channel
          }
          if (parsedAll) {
            r.bool(); // xyb_encoded
            const ceDefault = r.bool();
            if (!ceDefault) {
              const wantIcc = r.bool();
              if (wantIcc) hasIcc = true;
            }
          }
        }
      }
    } catch {
      uncertain = true;
    }
  }
  const metadata = baseMeta({ bitDepth, hasAlpha, hasExif, hasGps, hasIcc, hasXmp, isAnimated });
  if (uncertain) metadata.bitDepthUncertain = true;
  // libjxl applies the orientation itself while decoding, so we record it only for display.
  if (orientation !== undefined && orientation !== 1) metadata.orientation = orientation;
  return { format: 'jxl', width, height, metadata };
}

// ------------------------------------------------------------------- TIFF (as an image format)

function isTiff(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  const bo = ascii(b, 0, 2);
  if (bo === 'II') return b[2] === 42 && b[3] === 0;
  if (bo === 'MM') return b[2] === 0 && b[3] === 42;
  return false;
}

function inspectTiff(b: Uint8Array): HeaderInfo {
  const s = parseTiffStructure(b);
  const le = s.littleEndian;
  const ifd = s.ifd0;
  const num = (tag: number, dflt: number) => {
    const e = findEntry(ifd, tag);
    return e ? readNumber(e, le) : dflt;
  };
  const width = num(TAG.ImageWidth, 0);
  const height = num(TAG.ImageLength, 0);
  const bps = findEntry(ifd, TAG.BitsPerSample);
  const bitsPerSample = bps ? readNumbers(bps, le) : [1];
  const bitDepth = Math.max(...bitsPerSample);
  const spp = num(TAG.SamplesPerPixel, 1);
  const photometric = num(TAG.Photometric, 2);
  const extra = findEntry(ifd, TAG.ExtraSamples);
  const extraSamples = extra ? readNumbers(extra, le) : [];
  const colourChannels = photometric === 2 ? 3 : photometric === 5 ? 4 : 1;
  const hasAlpha = extraSamples.some((v) => v === 1 || v === 2) || spp > colourChannels;
  const alphaAssociated = extraSamples[0] === 1;
  const exifIfd = findEntry(ifd, TAG.ExifIFD)?.sub;
  const hasGps = !!findEntry(ifd, TAG.GpsIFD);
  // For TIFF, "EXIF" means descriptive tags in IFD0 (camera, dates, authorship) and the
  // Exif/GPS sub-IFDs; layout tags, orientation and resolution do not count.
  const hasExif = !!exifIfd || hasGps || [TAG.Make, TAG.Model, TAG.DateTime, TAG.Software, TAG.Artist, TAG.Copyright, 0x010e].some((t) => findEntry(ifd, t));
  const orientation = findEntry(ifd, TAG.Orientation);
  const metadata = baseMeta({
    bitDepth: bitDepth < 8 ? 8 : bitDepth,
    hasAlpha,
    hasExif,
    hasGps,
    hasIcc: !!findEntry(ifd, TAG.IccProfile),
    hasXmp: !!findEntry(ifd, TAG.XMP),
    isAnimated: !!ifd.next,
    sourceLossless: num(TAG.Compression, 1) !== 7 && num(TAG.Compression, 1) !== 6,
  });
  if (alphaAssociated) metadata.alphaAssociated = true;
  if (orientation) metadata.orientation = readNumber(orientation, le);
  return { format: 'tiff', width, height, metadata };
}
