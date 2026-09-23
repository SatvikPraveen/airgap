/**
 * TIFF codec. Decode through utif (pure JS, broad compression support), with
 * our own sample unpacking for 16-bit chunky RGB/RGBA/gray. Encode with our
 * own baseline writer: uncompressed, single strip, straight (unassociated)
 * alpha declared as ExtraSamples=2, 8 or 16-bit, little-endian, with
 * EXIF/GPS sub-IFDs, ICC and XMP tags.
 *
 * The writer is validated in tests against two independent readers (utif and
 * image-js `tiff`), never only against its matching reader.
 */
import { parseIcc } from '../metadata/icc';
import {
  concat,
  entryBlob,
  entryByte,
  entryLong,
  entryRational,
  entryShort,
  entrySubIfd,
  entryUndefined,
  findEntry,
  parseTiffStructure,
  readNumber,
  readNumbers,
  serializeTiffStructure,
  TAG,
  type Ifd,
  type IfdEntry,
  type TiffStructure,
} from '../metadata/tiff-ifd';
import { inspect } from '../inspect';
import { alphaStats, allocate, maxValue } from '../pixels';
import { unpremultiply } from '../flatten';
import type { Codec, DecodedImage, EncodeOptions, ImageMetadata, PixelData } from './types';

/** IFD0 tags that describe image layout, never metadata to carry across formats. */
const STRUCTURAL_TAGS = new Set<number>([
  0x00fe, 0x00ff, 0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0107, 0x0108, 0x0109, 0x010a, 0x010d, 0x0111, 0x0115, 0x0116,
  0x0117, 0x0118, 0x0119, 0x011c, 0x011d, 0x011e, 0x011f, 0x0120, 0x0121, 0x0122, 0x0123, 0x0124, 0x0125, 0x0140, 0x0141,
  0x0142, 0x0143, 0x0144, 0x0145, 0x014a, 0x014c, 0x014d, 0x0152, 0x0153, 0x0154, 0x0155, 0x0156, 0x015b, 0x0200, 0x0201,
  0x0202, 0x0203, 0x0205, 0x0206, 0x0207, 0x0208, 0x0209, 0x0211, 0x0212, 0x0213, 0x0214, 0x02bc, 0x8773, 0xc4a5,
]);

/** Pulls EXIF-style metadata out of a TIFF's IFD0: everything that is not layout, plus Exif/GPS sub-IFDs. */
export function exifFromTiff(s: TiffStructure): Uint8Array | undefined {
  const entries = s.ifd0.entries.filter((e) => !STRUCTURAL_TAGS.has(e.tag));
  if (!entries.length) return undefined;
  const hasContent = entries.some((e) => ![TAG.Orientation, TAG.XResolution, TAG.YResolution, TAG.ResolutionUnit].includes(e.tag as never));
  if (!hasContent) return undefined;
  return serializeTiffStructure({ littleEndian: s.littleEndian, ifd0: { entries: entries.map(cloneEntry) } });
}

function cloneEntry(e: IfdEntry): IfdEntry {
  const c: IfdEntry = { tag: e.tag, type: e.type, count: e.count, value: e.value };
  if (e.sub) c.sub = { entries: e.sub.entries.map(cloneEntry) };
  if (e.blob) c.blob = e.blob;
  return c;
}

async function decodeTiff(bytes: Uint8Array): Promise<DecodedImage> {
  const UTIF = (await import('utif')).default;
  const header = inspect(bytes);
  const ifds = UTIF.decode(bytes);
  const ifd = ifds[0];
  if (!ifd) throw new Error('TIFF has no image directory.');
  UTIF.decodeImage(bytes, ifd, ifds);
  const width = ifd.width;
  const height = ifd.height;
  const bps = (ifd.t258 as number[] | undefined) ?? [8];
  const spp = ((ifd.t277 as number[] | undefined) ?? [1])[0]!;
  const photometric = ((ifd.t262 as number[] | undefined) ?? [2])[0]!;
  const planar = ((ifd.t284 as number[] | undefined) ?? [1])[0]!;
  const extra = (ifd.t338 as number[] | undefined) ?? [];
  const sampleFormat = ((ifd.t339 as number[] | undefined) ?? [1])[0]!;
  const depth = Math.max(...bps);

  let pixels: PixelData;
  if (depth === 16 && planar === 1 && sampleFormat === 1 && (photometric === 1 || photometric === 2) && spp >= 1 && spp <= 4) {
    // Chunky 16-bit gray/RGB with optional alpha: unpack ourselves, exactly.
    pixels = allocate(width, height, 16);
    const src = ifd.data;
    const dst = pixels.data as Uint16Array;
    // utif normalises 16-bit strip data to little-endian during decodeImage (it byte-swaps
    // big-endian files), so samples are always read LE here regardless of ifd.isLE.
    const le = true;
    const colour = photometric === 2 ? 3 : 1;
    const hasA = spp > colour;
    const n = width * height;
    for (let i = 0; i < n; i++) {
      const s = i * spp * 2;
      const rd = (k: number) => (le ? src[s + k * 2]! | (src[s + k * 2 + 1]! << 8) : (src[s + k * 2]! << 8) | src[s + k * 2 + 1]!);
      const d = i * 4;
      if (colour === 3) {
        dst[d] = rd(0);
        dst[d + 1] = rd(1);
        dst[d + 2] = rd(2);
      } else {
        dst[d] = dst[d + 1] = dst[d + 2] = rd(0);
      }
      dst[d + 3] = hasA ? rd(colour) : 65535;
    }
  } else if (depth > 8 && !(depth === 16 && photometric === 3)) {
    // utif's toRGBA8 would silently drop to 8-bit for layouts we do not unpack ourselves.
    throw new Error(`Unsupported ${depth}-bit TIFF layout (photometric ${photometric}, planar ${planar}, sample format ${sampleFormat}).`);
  } else {
    const rgba = UTIF.toRGBA8(ifd);
    pixels = { width, height, bitDepth: 8, data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length) };
  }

  const structure = parseTiffStructure(bytes);
  const le = structure.littleEndian;
  const iccEntry = findEntry(structure.ifd0, TAG.IccProfile);
  const xmpEntry = findEntry(structure.ifd0, TAG.XMP);
  const exif = exifFromTiff(structure);
  const associated = extra[0] === 1 && header.metadata.hasAlpha;
  if (associated) pixels = unpremultiply(pixels);
  const stats = header.metadata.hasAlpha ? alphaStats(pixels) : { hasTransparency: false, hasSemiTransparency: false };
  const metadata: ImageMetadata = { ...header.metadata, ...stats, hasExif: !!exif };
  if (exif) metadata.exif = exif;
  if (iccEntry) {
    metadata.icc = iccEntry.value;
    try {
      const p = parseIcc(iccEntry.value);
      metadata.iccKind = p.kind;
      metadata.iccDescription = p.description;
    } catch {
      metadata.iccKind = 'unknown';
    }
  }
  if (xmpEntry) metadata.xmp = xmpEntry.value;
  const orientationEntry = findEntry(structure.ifd0, TAG.Orientation);
  if (orientationEntry) metadata.orientation = readNumber(orientationEntry, le);
  void readNumbers;
  return { pixels, metadata };
}

/** Baseline TIFF writer. */
export function encodeTiff(img: DecodedImage, opts: EncodeOptions): Uint8Array {
  const px = img.pixels;
  if (px.bitDepth !== 8 && px.bitDepth !== 16) throw new Error(`TIFF writer takes 8 or 16-bit input, got ${px.bitDepth}`);
  const le = true;
  const hasAlpha = img.metadata.hasAlpha;
  const spp = hasAlpha ? 4 : 3;
  const bytesPerSample = px.bitDepth / 8;
  const n = px.width * px.height;
  const strip = new Uint8Array(n * spp * bytesPerSample);
  const src = px.data;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < spp; c++) {
      const v = src[i * 4 + c]!;
      const o = (i * spp + c) * bytesPerSample;
      if (bytesPerSample === 1) strip[o] = v;
      else {
        strip[o] = v & 255;
        strip[o + 1] = v >> 8;
      }
    }
  }

  const entries: IfdEntry[] = [
    entryLong(le, TAG.ImageWidth, [px.width]),
    entryLong(le, TAG.ImageLength, [px.height]),
    entryShort(le, TAG.BitsPerSample, new Array(spp).fill(px.bitDepth)),
    entryShort(le, TAG.Compression, [1]),
    entryShort(le, TAG.Photometric, [2]),
    entryBlob(le, TAG.StripOffsets, strip),
    entryShort(le, TAG.Orientation, [1]),
    entryShort(le, TAG.SamplesPerPixel, [spp]),
    entryLong(le, TAG.RowsPerStrip, [px.height]),
    entryLong(le, TAG.StripByteCounts, [strip.length]),
    entryRational(le, TAG.XResolution, [[72, 1]]),
    entryRational(le, TAG.YResolution, [[72, 1]]),
    entryShort(le, TAG.PlanarConfiguration, [1]),
    entryShort(le, TAG.ResolutionUnit, [2]),
    entryShort(le, TAG.SampleFormat, new Array(spp).fill(1)),
  ];
  if (hasAlpha) entries.push(entryShort(le, TAG.ExtraSamples, [2])); // 2 = unassociated (straight) alpha
  if (opts.icc) entries.push(entryUndefined(TAG.IccProfile, opts.icc));
  if (opts.xmp) entries.push(entryByte(TAG.XMP, opts.xmp));

  const ifd0: Ifd = { entries };
  if (opts.exif) {
    // Merge the carried EXIF: its IFD0 tags become our IFD0 tags (ours win), sub-IFDs come along.
    const ex = parseTiffStructure(opts.exif);
    for (const e of ex.ifd0.entries) {
      if (STRUCTURAL_TAGS.has(e.tag) || findEntry(ifd0, e.tag)) continue;
      if (e.sub) ifd0.entries.push(entrySubIfd(e.tag, { entries: e.sub.entries.map(cloneEntry) }));
      else if (!e.blob) ifd0.entries.push(convertEndian(e, ex.littleEndian, le));
    }
  }
  return serializeTiffStructure({ littleEndian: le, ifd0 });
}

/** Re-encodes an entry's multi-byte value in another byte order. */
function convertEndian(e: IfdEntry, fromLe: boolean, toLe: boolean): IfdEntry {
  if (fromLe === toLe) return cloneEntry(e);
  const size = { 3: 2, 8: 2, 4: 4, 9: 4, 11: 4, 13: 4, 5: 8, 10: 8, 12: 8 }[e.type] ?? 1;
  if (size === 1) return cloneEntry(e);
  const v = new Uint8Array(e.value.length);
  const unit = size === 8 ? 4 : size; // rationals are two 4-byte ints
  for (let o = 0; o + unit <= v.length; o += unit) for (let k = 0; k < unit; k++) v[o + k] = e.value[o + unit - 1 - k]!;
  const c: IfdEntry = { tag: e.tag, type: e.type, count: e.count, value: v };
  return c;
}

/** Sub-IFD entries also need byte-order conversion; handled by re-serialising through the same order. */
export function createTiffCodec(): Codec {
  return {
    id: 'utif-tiff',
    format: 'tiff',
    capabilities: {
      decode: true,
      encode: true,
      lossless: true,
      alpha: true,
      exactAlpha: true,
      decodeBitDepth: 16,
      decodeExact: true,
      decodeAppliesIcc: false,
      encodeBitDepths: [8, 16],
      metadata: { exif: true, icc: true, xmp: true },
    },
    decode: decodeTiff,
    encode: async (img, opts) => encodeTiff(img, opts),
  };
}

export { concat, maxValue };
