/**
 * Flattens an EXIF blob into displayable rows, one per tag, so the user can
 * see exactly what each metadata mode keeps and what it removes. Pure.
 */
import type { MetadataMode } from '../capabilities';
import { findEntry, parseTiffStructure, readAscii, readNumbers, TAG, type Ifd, type IfdEntry } from './tiff-ifd';

export type ExifIfdName = 'IFD0' | 'Exif' | 'GPS' | 'Interop' | 'IFD1';

export interface ExifTagRow {
  ifd: ExifIfdName;
  tag: number;
  name: string;
  type: string;
  count: number;
  /** Human-readable value, truncated. Binary payloads are summarised as a byte count. */
  value: string;
}

const TYPE_NAMES: Record<number, string> = {
  1: 'BYTE',
  2: 'ASCII',
  3: 'SHORT',
  4: 'LONG',
  5: 'RATIONAL',
  6: 'SBYTE',
  7: 'UNDEFINED',
  8: 'SSHORT',
  9: 'SLONG',
  10: 'SRATIONAL',
  11: 'FLOAT',
  12: 'DOUBLE',
  13: 'IFD',
};

/** Tag names for the IFDs Airgap carries. Unknown tags are shown by number. */
export const EXIF_TAG_NAMES: Record<number, string> = {
  0x00fe: 'NewSubfileType',
  0x0100: 'ImageWidth',
  0x0101: 'ImageLength',
  0x0102: 'BitsPerSample',
  0x0103: 'Compression',
  0x0106: 'PhotometricInterpretation',
  0x010e: 'ImageDescription',
  0x010f: 'Make',
  0x0110: 'Model',
  0x0111: 'StripOffsets',
  0x0112: 'Orientation',
  0x0115: 'SamplesPerPixel',
  0x0116: 'RowsPerStrip',
  0x0117: 'StripByteCounts',
  0x011a: 'XResolution',
  0x011b: 'YResolution',
  0x011c: 'PlanarConfiguration',
  0x0128: 'ResolutionUnit',
  0x012d: 'TransferFunction',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x013e: 'WhitePoint',
  0x013f: 'PrimaryChromaticities',
  0x0201: 'JPEGInterchangeFormat',
  0x0202: 'JPEGInterchangeFormatLength',
  0x0211: 'YCbCrCoefficients',
  0x0212: 'YCbCrSubSampling',
  0x0213: 'YCbCrPositioning',
  0x0214: 'ReferenceBlackWhite',
  0x02bc: 'XMP',
  0x4746: 'Rating',
  0x4749: 'RatingPercent',
  0x8298: 'Copyright',
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8769: 'ExifIFD',
  0x8773: 'ICCProfile',
  0x8822: 'ExposureProgram',
  0x8824: 'SpectralSensitivity',
  0x8825: 'GPSInfo',
  0x8827: 'ISOSpeedRatings',
  0x8828: 'OECF',
  0x8830: 'SensitivityType',
  0x8832: 'RecommendedExposureIndex',
  0x9000: 'ExifVersion',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9010: 'OffsetTime',
  0x9011: 'OffsetTimeOriginal',
  0x9012: 'OffsetTimeDigitized',
  0x9101: 'ComponentsConfiguration',
  0x9102: 'CompressedBitsPerPixel',
  0x9201: 'ShutterSpeedValue',
  0x9202: 'ApertureValue',
  0x9203: 'BrightnessValue',
  0x9204: 'ExposureBiasValue',
  0x9205: 'MaxApertureValue',
  0x9206: 'SubjectDistance',
  0x9207: 'MeteringMode',
  0x9208: 'LightSource',
  0x9209: 'Flash',
  0x920a: 'FocalLength',
  0x9214: 'SubjectArea',
  0x927c: 'MakerNote',
  0x9286: 'UserComment',
  0x9290: 'SubSecTime',
  0x9291: 'SubSecTimeOriginal',
  0x9292: 'SubSecTimeDigitized',
  0xa000: 'FlashpixVersion',
  0xa001: 'ColorSpace',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0xa004: 'RelatedSoundFile',
  0xa005: 'InteropIFD',
  0xa20e: 'FocalPlaneXResolution',
  0xa20f: 'FocalPlaneYResolution',
  0xa210: 'FocalPlaneResolutionUnit',
  0xa214: 'SubjectLocation',
  0xa215: 'ExposureIndex',
  0xa217: 'SensingMethod',
  0xa300: 'FileSource',
  0xa301: 'SceneType',
  0xa302: 'CFAPattern',
  0xa401: 'CustomRendered',
  0xa402: 'ExposureMode',
  0xa403: 'WhiteBalance',
  0xa404: 'DigitalZoomRatio',
  0xa405: 'FocalLengthIn35mmFilm',
  0xa406: 'SceneCaptureType',
  0xa407: 'GainControl',
  0xa408: 'Contrast',
  0xa409: 'Saturation',
  0xa40a: 'Sharpness',
  0xa40c: 'SubjectDistanceRange',
  0xa420: 'ImageUniqueID',
  0xa430: 'CameraOwnerName',
  0xa431: 'BodySerialNumber',
  0xa432: 'LensSpecification',
  0xa433: 'LensMake',
  0xa434: 'LensModel',
  0xa435: 'LensSerialNumber',
  0xa460: 'CompositeImage',
  0xa500: 'Gamma',
};

export const GPS_TAG_NAMES: Record<number, string> = {
  0x0000: 'GPSVersionID',
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
  0x0005: 'GPSAltitudeRef',
  0x0006: 'GPSAltitude',
  0x0007: 'GPSTimeStamp',
  0x0008: 'GPSSatellites',
  0x0009: 'GPSStatus',
  0x000a: 'GPSMeasureMode',
  0x000b: 'GPSDOP',
  0x000c: 'GPSSpeedRef',
  0x000d: 'GPSSpeed',
  0x000e: 'GPSTrackRef',
  0x000f: 'GPSTrack',
  0x0010: 'GPSImgDirectionRef',
  0x0011: 'GPSImgDirection',
  0x0012: 'GPSMapDatum',
  0x0013: 'GPSDestLatitudeRef',
  0x0014: 'GPSDestLatitude',
  0x0015: 'GPSDestLongitudeRef',
  0x0016: 'GPSDestLongitude',
  0x001b: 'GPSProcessingMethod',
  0x001c: 'GPSAreaInformation',
  0x001d: 'GPSDateStamp',
  0x001e: 'GPSDifferential',
  0x001f: 'GPSHPositioningError',
};

const INTEROP_TAG_NAMES: Record<number, string> = {
  0x0001: 'InteroperabilityIndex',
  0x0002: 'InteroperabilityVersion',
};

const MAX_VALUE_CHARS = 96;

function tagName(ifd: ExifIfdName, tag: number): string {
  const table = ifd === 'GPS' ? GPS_TAG_NAMES : ifd === 'Interop' ? INTEROP_TAG_NAMES : EXIF_TAG_NAMES;
  return table[tag] ?? `0x${tag.toString(16).padStart(4, '0')}`;
}

function formatValue(e: IfdEntry, le: boolean): string {
  if (e.sub) return `sub-IFD (${e.sub.entries.length} tags)`;
  if (e.blob) return `${e.blob.length} bytes`;
  if (e.type === 2) return truncate(readAscii(e).replace(/\0+$/, ''));
  if (e.type === 7 || e.type === 1 || e.type === 6) {
    if (e.count > 16) return `${e.count} bytes`;
    return Array.from(e.value.subarray(0, e.count)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  }
  try {
    const nums = readNumbers(e, le);
    if (e.type === 5 || e.type === 10) {
      const parts: string[] = [];
      for (let i = 0; i + 1 < nums.length && parts.length < 8; i += 2) parts.push(nums[i + 1] === 0 ? `${nums[i]}/0` : `${nums[i]}/${nums[i + 1]}`);
      return truncate(parts.join(', ') + (nums.length > 16 ? ', …' : ''));
    }
    return truncate(nums.slice(0, 16).join(', ') + (nums.length > 16 ? ', …' : ''));
  } catch {
    return `${e.count} × ${TYPE_NAMES[e.type] ?? e.type}`;
  }
}

function truncate(s: string): string {
  return s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS - 1) + '…' : s;
}

function rows(ifd: Ifd | undefined, name: ExifIfdName, le: boolean, out: ExifTagRow[]): void {
  if (!ifd) return;
  for (const e of ifd.entries) {
    out.push({ ifd: name, tag: e.tag, name: tagName(name, e.tag), type: TYPE_NAMES[e.type] ?? String(e.type), count: e.count, value: formatValue(e, le) });
  }
}

/** Every tag in IFD0, Exif, GPS, Interop and IFD1, in that order. Throws on an unreadable blob. */
export function listExifTags(tiff: Uint8Array): ExifTagRow[] {
  const s = parseTiffStructure(tiff);
  const le = s.littleEndian;
  const out: ExifTagRow[] = [];
  rows(s.ifd0, 'IFD0', le, out);
  const exif = findEntry(s.ifd0, TAG.ExifIFD)?.sub;
  rows(exif, 'Exif', le, out);
  rows(findEntry(s.ifd0, TAG.GpsIFD)?.sub, 'GPS', le, out);
  rows(exif ? findEntry(exif, TAG.InteropIFD)?.sub : undefined, 'Interop', le, out);
  rows(s.ifd0.next, 'IFD1', le, out);
  return out;
}

export type RowFate = 'kept' | 'removed' | 'rewritten';

/**
 * What the given metadata mode does to one row. Mirrors src/metadata/exif.ts:
 * strip-all removes everything; strip-gps removes the GPS IFD (and its
 * pointer), the MakerNote, and the metadata inside the IFD1 thumbnail; every
 * mode rewrites Orientation to 1 because pixels are stored upright.
 * `encoderCarriesExif` is false when the target cannot embed EXIF at all.
 */
export function rowFate(row: ExifTagRow, mode: MetadataMode, encoderCarriesExif: boolean, thumbnailHasMetadata: boolean): RowFate {
  if (mode === 'strip-all' || !encoderCarriesExif) return 'removed';
  if (mode === 'strip-gps') {
    if (row.ifd === 'GPS') return 'removed';
    if (row.tag === TAG.GpsIFD && (row.ifd === 'IFD0' || row.ifd === 'IFD1')) return 'removed';
    if (row.ifd === 'Exif' && row.tag === TAG.MakerNote) return 'removed';
    if (row.ifd === 'IFD1' && row.tag === TAG.JPEGInterchangeFormat && thumbnailHasMetadata) return 'rewritten';
  }
  if (row.tag === TAG.Orientation && (row.ifd === 'IFD0' || row.ifd === 'IFD1') && row.value !== '1') return 'rewritten';
  return 'kept';
}
