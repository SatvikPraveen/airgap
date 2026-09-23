/**
 * EXIF payload operations on the TIFF-structured blob that JPEG APP1, PNG
 * eXIf, WebP EXIF and TIFF ExifIFD all share. Pure.
 */
import { injectMetadata } from './containers';
import {
  entryLong,
  entryShort,
  findEntry,
  parseTiffStructure,
  readAscii,
  readNumber,
  removeEntry,
  serializeTiffStructure,
  setEntry,
  TAG,
  type Ifd,
  type TiffStructure,
} from './tiff-ifd';

export interface ExifSummary {
  /** Total entries across IFD0, Exif, GPS, Interop and IFD1. */
  tagCount: number;
  ifd0: number[];
  exif: number[];
  gps: number[];
  interop: number[];
  ifd1: number[];
  hasGps: boolean;
  hasThumbnail: boolean;
  /** Exif IFD tag 0x927c present: an opaque vendor blob that may carry location. */
  hasMakerNote: boolean;
  /** The IFD1 thumbnail JPEG carries its own EXIF/XMP/ICC segments. */
  thumbnailHasMetadata: boolean;
  orientation?: number;
  make?: string;
  model?: string;
  dateTime?: string;
  software?: string;
}

export function parseExif(tiff: Uint8Array): TiffStructure {
  return parseTiffStructure(tiff);
}

export function serializeExif(s: TiffStructure): Uint8Array {
  return serializeTiffStructure(s);
}

function tags(ifd: Ifd | undefined): number[] {
  return ifd ? ifd.entries.map((e) => e.tag).sort((a, b) => a - b) : [];
}

export function summarizeExif(tiff: Uint8Array): ExifSummary {
  const s = parseExif(tiff);
  const ifd0 = s.ifd0;
  const exif = findEntry(ifd0, TAG.ExifIFD)?.sub;
  const gps = findEntry(ifd0, TAG.GpsIFD)?.sub;
  const interop = exif ? findEntry(exif, TAG.InteropIFD)?.sub : undefined;
  const ifd1 = ifd0.next;
  const out: ExifSummary = {
    tagCount: [ifd0, exif, gps, interop, ifd1].reduce((n, i) => n + (i ? i.entries.length : 0), 0),
    ifd0: tags(ifd0),
    exif: tags(exif),
    gps: tags(gps),
    interop: tags(interop),
    ifd1: tags(ifd1),
    hasGps: !!gps,
    hasThumbnail: !!(ifd1 && findEntry(ifd1, TAG.JPEGInterchangeFormat)?.blob),
    hasMakerNote: !!(exif && findEntry(exif, TAG.MakerNote)),
    thumbnailHasMetadata: thumbnailHasMetadata(ifd1),
  };
  const o = findEntry(ifd0, TAG.Orientation);
  if (o) out.orientation = readNumber(o, s.littleEndian);
  const str = (tag: number) => {
    const e = findEntry(ifd0, tag);
    return e && e.type === 2 ? readAscii(e) : undefined;
  };
  const make = str(TAG.Make);
  const model = str(TAG.Model);
  const dt = str(TAG.DateTime);
  const sw = str(TAG.Software);
  if (make !== undefined) out.make = make;
  if (model !== undefined) out.model = model;
  if (dt !== undefined) out.dateTime = dt;
  if (sw !== undefined) out.software = sw;
  return out;
}

function thumbnailHasMetadata(ifd1: Ifd | undefined): boolean {
  const blob = ifd1 && findEntry(ifd1, TAG.JPEGInterchangeFormat)?.blob;
  if (!blob) return false;
  try {
    const h = inspectJpegSegments(blob);
    return h.exif || h.xmp || h.icc;
  } catch {
    return false;
  }
}

/** Cheap segment scan of a JPEG for APP1 Exif/XMP and APP2 ICC, without decoding. */
function inspectJpegSegments(b: Uint8Array): { exif: boolean; xmp: boolean; icc: boolean } {
  const out = { exif: false, xmp: false, icc: false };
  if (!(b[0] === 0xff && b[1] === 0xd8)) throw new Error('not a JPEG');
  let off = 2;
  while (off + 4 <= b.length && b[off] === 0xff) {
    const marker = b[off + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const len = (b[off + 2]! << 8) | b[off + 3]!;
    const head = String.fromCharCode(...b.subarray(off + 4, off + 4 + Math.min(12, len - 2)));
    if (marker === 0xe1 && head.startsWith('Exif\0\0')) out.exif = true;
    else if (marker === 0xe1 && head.startsWith('http://ns.ad')) out.xmp = true;
    else if (marker === 0xe2 && head.startsWith('ICC_PROFILE')) out.icc = true;
    off += 2 + len;
  }
  return out;
}

/**
 * "Strip GPS only": removes every place inside EXIF where location can live,
 * keeping everything else.
 *  - the GPS IFD and its pointer (IFD0 and IFD1)
 *  - the MakerNote (0x927c): an opaque vendor blob that cannot be cleaned
 *    selectively, so it is dropped whole
 *  - EXIF/XMP/ICC segments inside the IFD1 thumbnail JPEG (the thumbnail
 *    pixels stay); if the thumbnail cannot be rewritten it is dropped
 * XMP is handled by the caller (dropped in this mode). Returns a re-serialised blob.
 */
export function stripGps(tiff: Uint8Array): Uint8Array {
  const s = parseExif(tiff);
  for (const ifd of [s.ifd0, s.ifd0.next]) {
    if (!ifd) continue;
    removeEntry(ifd, TAG.GpsIFD);
    const exif = findEntry(ifd, TAG.ExifIFD)?.sub;
    if (exif) removeEntry(exif, TAG.MakerNote);
  }
  const ifd1 = s.ifd0.next;
  const thumb = ifd1 && findEntry(ifd1, TAG.JPEGInterchangeFormat);
  if (ifd1 && thumb?.blob && thumbnailHasMetadata(ifd1)) {
    try {
      thumb.blob = injectMetadata(thumb.blob, 'jpeg', {});
      setEntry(ifd1, entryLong(s.littleEndian, TAG.JPEGInterchangeFormatLength, [thumb.blob.length]));
    } catch {
      removeEntry(ifd1, TAG.JPEGInterchangeFormat);
      removeEntry(ifd1, TAG.JPEGInterchangeFormatLength);
    }
  }
  return serializeExif(s);
}

/**
 * Sets the Orientation tag to `value` if the tag exists (in IFD0 and IFD1).
 * Airgap stores pixels upright, so any carried EXIF must say 1, otherwise a
 * viewer would rotate the already-rotated image again.
 */
export function setOrientation(tiff: Uint8Array, value: number): Uint8Array {
  const s = parseExif(tiff);
  let changed = false;
  for (const ifd of [s.ifd0, s.ifd0.next]) {
    if (!ifd) continue;
    const e = findEntry(ifd, TAG.Orientation);
    if (e && readNumber(e, s.littleEndian) !== value) {
      setEntry(ifd, entryShort(s.littleEndian, TAG.Orientation, [value]));
      changed = true;
    }
  }
  return changed ? serializeExif(s) : tiff;
}

/** Re-serialises through the parser: what a preserved payload will actually look like. */
export function normalizeExif(tiff: Uint8Array): Uint8Array {
  return serializeExif(parseExif(tiff));
}

/** Human-readable names for the tags most people care about (tests and UI). */
export const TAG_NAMES: Record<number, string> = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x011a: 'XResolution',
  0x011b: 'YResolution',
  0x0128: 'ResolutionUnit',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x8298: 'Copyright',
  0x8769: 'ExifIFD',
  0x8825: 'GPSInfo',
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8827: 'ISOSpeedRatings',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x927c: 'MakerNote',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0xa005: 'InteropIFD',
  0x0000: 'GPSVersionID',
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
};
