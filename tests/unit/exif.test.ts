import { describe, expect, it } from 'vitest';
import { normalizeExif, parseExif, setExifGeometry, setOrientation, stripGps, summarizeExif } from '../../src/metadata/exif';
import { extractMetadata } from '../../src/metadata/containers';
import { entryAscii, entryBlob, entryLong, entryShort, entrySubIfd, findEntry, parseTiffStructure, readAscii, readNumber, serializeTiffStructure, TAG } from '../../src/metadata/tiff-ifd';
import { fixture } from './helpers';

const exifOf = (name: string) => extractMetadata(fixture(name), 'jpeg').exif!;

describe('TIFF IFD parse/serialize', () => {
  it('round-trips the fixture EXIF byte-for-byte after one normalisation', () => {
    const raw = exifOf('exif-gps.jpg');
    const once = normalizeExif(raw);
    const twice = normalizeExif(once);
    expect(Array.from(twice)).toEqual(Array.from(once));
    const a = summarizeExif(raw);
    const b = summarizeExif(once);
    expect(b).toEqual(a);
  });
  it('parses the fixture: IFD0 strings, Exif sub-IFD, GPS sub-IFD', () => {
    const s = summarizeExif(exifOf('exif-gps.jpg'));
    expect(s.make).toBe('Airgap Fixtures');
    expect(s.model).toBe('Synthetic Camera 1');
    expect(s.dateTime).toBe('2026:09:23 10:00:00');
    expect(s.orientation).toBe(1);
    expect(s.hasGps).toBe(true);
    expect(s.exif).toContain(0x9003);
    expect(s.gps).toEqual([0, 1, 2, 3, 4]);
    expect(s.tagCount).toBe(10 + 5 + 5);
  });
  it('little-endian structures survive serialisation with their byte order', () => {
    const le = true;
    const s = { littleEndian: le, ifd0: { entries: [entryShort(le, TAG.Orientation, [8]), entryAscii(TAG.Make, 'LE cam'), entrySubIfd(TAG.GpsIFD, { entries: [entryShort(le, 0x0001, [78])] })] } };
    const bytes = serializeTiffStructure(s);
    expect(bytes[0]).toBe(0x49);
    const back = parseTiffStructure(bytes);
    expect(readNumber(findEntry(back.ifd0, TAG.Orientation)!, true)).toBe(8);
    expect(readAscii(findEntry(back.ifd0, TAG.Make)!)).toBe('LE cam');
    expect(readNumber(findEntry(findEntry(back.ifd0, TAG.GpsIFD)!.sub!, 0x0001)!, true)).toBe(78);
  });
  it('carries IFD1 thumbnails as relocated blobs', () => {
    const le = false;
    const thumb = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const s = {
      littleEndian: le,
      ifd0: {
        entries: [entryShort(le, TAG.Orientation, [1])],
        next: { entries: [entryBlob(le, TAG.JPEGInterchangeFormat, thumb), { tag: TAG.JPEGInterchangeFormatLength, type: 4, count: 1, value: new Uint8Array([0, 0, 0, thumb.length]) }] },
      },
    };
    const bytes = serializeTiffStructure(s);
    const back = parseTiffStructure(bytes);
    expect(Array.from(findEntry(back.ifd0.next!, TAG.JPEGInterchangeFormat)!.blob!)).toEqual(Array.from(thumb));
    expect(summarizeExif(bytes).hasThumbnail).toBe(true);
  });
  it('tolerates truncated entries by dropping them', () => {
    const raw = exifOf('exif-gps.jpg');
    const cut = raw.subarray(0, raw.length - 40);
    expect(() => parseExif(cut)).not.toThrow();
  });
});

describe('stripGps', () => {
  it('removes the GPS IFD and nothing else (asserted on parsed tags)', () => {
    const before = summarizeExif(exifOf('exif-gps.jpg'));
    const after = summarizeExif(stripGps(exifOf('exif-gps.jpg')));
    expect(after.hasGps).toBe(false);
    expect(after.gps).toEqual([]);
    expect(after.ifd0).toEqual(before.ifd0.filter((t) => t !== TAG.GpsIFD));
    expect(after.exif).toEqual(before.exif);
    expect(after.make).toBe(before.make);
    expect(after.model).toBe(before.model);
    expect(after.dateTime).toBe(before.dateTime);
    expect(after.tagCount).toBe(before.tagCount - 1 - before.gps.length);
  });
  it('is a no-op on EXIF without GPS', () => {
    const noGps = stripGps(exifOf('exif-gps.jpg'));
    expect(summarizeExif(stripGps(noGps))).toEqual(summarizeExif(noGps));
  });
});

describe('setOrientation', () => {
  it('rewrites 6 to 1 in place and returns the same bytes when already 1', () => {
    const raw = exifOf('exif-orient6.jpg');
    expect(summarizeExif(raw).orientation).toBe(6);
    const fixed = setOrientation(raw, 1);
    expect(summarizeExif(fixed).orientation).toBe(1);
    expect(summarizeExif(fixed).tagCount).toBe(summarizeExif(raw).tagCount);
    expect(setOrientation(fixed, 1)).toBe(fixed);
  });
  it('does not add a tag when none exists', () => {
    const le = true;
    const bytes = serializeTiffStructure({ littleEndian: le, ifd0: { entries: [entryAscii(TAG.Make, 'x')] } });
    expect(setOrientation(bytes, 1)).toBe(bytes);
  });
});

describe('setExifGeometry', () => {
  const le = true;
  const thumb = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const make = (xType: 'short' | 'long') =>
    serializeTiffStructure({
      littleEndian: le,
      ifd0: {
        entries: [
          entryAscii(TAG.Make, 'cam'),
          entrySubIfd(TAG.ExifIFD, {
            entries: [xType === 'short' ? entryShort(le, TAG.PixelXDimension, [640]) : entryLong(le, TAG.PixelXDimension, [640]), entryShort(le, TAG.PixelYDimension, [480])],
          }),
        ],
        next: { entries: [entryBlob(le, TAG.JPEGInterchangeFormat, thumb), entryLong(le, TAG.JPEGInterchangeFormatLength, [thumb.length])] },
      },
    });
  it('rewrites the pixel dimensions, removes the thumbnail IFD, keeps everything else', () => {
    const out = setExifGeometry(make('short'), 480, 640);
    const s = parseExif(out);
    const exif = findEntry(s.ifd0, TAG.ExifIFD)!.sub!;
    expect(readNumber(findEntry(exif, TAG.PixelXDimension)!, le)).toBe(480);
    expect(readNumber(findEntry(exif, TAG.PixelYDimension)!, le)).toBe(640);
    expect(s.ifd0.next).toBeUndefined();
    expect(summarizeExif(out).hasThumbnail).toBe(false);
    expect(readAscii(findEntry(s.ifd0, TAG.Make)!)).toBe('cam');
  });
  it('a SHORT tag that cannot hold the new size becomes LONG; a LONG tag stays LONG', () => {
    const big = parseExif(setExifGeometry(make('short'), 70000, 3));
    const e = findEntry(findEntry(big.ifd0, TAG.ExifIFD)!.sub!, TAG.PixelXDimension)!;
    expect(e.type).toBe(4);
    expect(readNumber(e, le)).toBe(70000);
    const long = parseExif(setExifGeometry(make('long'), 10, 3));
    expect(findEntry(findEntry(long.ifd0, TAG.ExifIFD)!.sub!, TAG.PixelXDimension)!.type).toBe(4);
  });
  it('does not add dimension tags that were not there', () => {
    const plain = serializeTiffStructure({ littleEndian: le, ifd0: { entries: [entryShort(le, TAG.Orientation, [1])] } });
    const s = parseExif(setExifGeometry(plain, 5, 5));
    expect(findEntry(s.ifd0, TAG.ExifIFD)).toBeUndefined();
  });
});
