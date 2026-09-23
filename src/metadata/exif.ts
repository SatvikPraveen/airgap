/**
 * EXIF payload operations on the TIFF-structured blob that JPEG APP1, PNG
 * eXIf, WebP EXIF and TIFF ExifIFD all share. Pure.
 */
import {
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

/** Removes the GPS IFD (and its pointer) and nothing else. Returns a re-serialised blob. */
export function stripGps(tiff: Uint8Array): Uint8Array {
  const s = parseExif(tiff);
  removeEntry(s.ifd0, TAG.GpsIFD);
  if (s.ifd0.next) removeEntry(s.ifd0.next, TAG.GpsIFD);
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
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0xa005: 'InteropIFD',
  0x0000: 'GPSVersionID',
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
};
