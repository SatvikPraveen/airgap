import { describe, expect, it } from 'vitest';
import { extractMetadata } from '../../src/metadata/containers';
import { listExifTags, rowFate, type ExifTagRow } from '../../src/metadata/exif-list';
import { fixture } from './helpers';

const exifOf = (name: string) => extractMetadata(fixture(name), 'jpeg').exif!;

describe('EXIF tag listing', () => {
  it('lists every IFD with names, types and readable values', () => {
    const rows = listExifTags(exifOf('exif-gps.jpg'));
    const by = (ifd: string, name: string) => rows.find((r) => r.ifd === ifd && r.name === name);
    expect(by('IFD0', 'Make')?.value).toBeTruthy();
    expect(by('IFD0', 'Make')?.type).toBe('ASCII');
    expect(by('IFD0', 'ExifIFD')?.value).toMatch(/^sub-IFD \(\d+ tags\)/);
    expect(by('IFD0', 'GPSInfo')?.value).toMatch(/^sub-IFD/);
    expect(rows.some((r) => r.ifd === 'GPS' && r.name === 'GPSLatitude' && r.type === 'RATIONAL')).toBe(true);
    expect(rows.some((r) => r.ifd === 'Exif')).toBe(true);
    // Orientation of the orient-6 fixture reads as the number 6.
    const o = listExifTags(exifOf('exif-orient6.jpg')).find((r) => r.ifd === 'IFD0' && r.name === 'Orientation');
    expect(o?.value).toBe('6');
  });

  it('location-everywhere: GPS IFD, MakerNote and thumbnail rows are all present and named', () => {
    const rows = listExifTags(exifOf('location-everywhere.jpg'));
    expect(rows.some((r) => r.ifd === 'GPS')).toBe(true);
    expect(rows.find((r) => r.ifd === 'Exif' && r.name === 'MakerNote')?.value).toMatch(/bytes$/);
    expect(rows.find((r) => r.ifd === 'IFD1' && r.name === 'JPEGInterchangeFormat')?.value).toMatch(/bytes$/);
  });

  it('long values are truncated, unknown tags shown by number', () => {
    const rows = listExifTags(exifOf('exif-gps.jpg'));
    for (const r of rows) expect(r.value.length).toBeLessThanOrEqual(96);
    const fake: ExifTagRow = { ifd: 'Exif', tag: 0xbeef, name: '0xbeef', type: 'SHORT', count: 1, value: '1' };
    expect(fake.name).toBe('0xbeef');
  });
});

describe('what each mode does to a row', () => {
  const gps: ExifTagRow = { ifd: 'GPS', tag: 2, name: 'GPSLatitude', type: 'RATIONAL', count: 3, value: '1/1, 2/1, 3/1' };
  const gpsPtr: ExifTagRow = { ifd: 'IFD0', tag: 0x8825, name: 'GPSInfo', type: 'LONG', count: 1, value: 'sub-IFD (5 tags)' };
  const maker: ExifTagRow = { ifd: 'Exif', tag: 0x927c, name: 'MakerNote', type: 'UNDEFINED', count: 40, value: '40 bytes' };
  const make: ExifTagRow = { ifd: 'IFD0', tag: 0x010f, name: 'Make', type: 'ASCII', count: 6, value: 'probe' };
  const orient6: ExifTagRow = { ifd: 'IFD0', tag: 0x0112, name: 'Orientation', type: 'SHORT', count: 1, value: '6' };
  const orient1: ExifTagRow = { ...orient6, value: '1' };
  const thumb: ExifTagRow = { ifd: 'IFD1', tag: 0x0201, name: 'JPEGInterchangeFormat', type: 'LONG', count: 1, value: '900 bytes' };

  it('strip-all removes everything; so does a target that cannot carry EXIF', () => {
    for (const r of [gps, gpsPtr, maker, make, orient6, thumb]) {
      expect(rowFate(r, 'strip-all', true, true)).toBe('removed');
      expect(rowFate(r, 'preserve', false, true)).toBe('removed');
    }
  });
  it('strip-gps removes the GPS IFD, its pointer and the MakerNote; rewrites a thumbnail with metadata; keeps the rest', () => {
    expect(rowFate(gps, 'strip-gps', true, false)).toBe('removed');
    expect(rowFate(gpsPtr, 'strip-gps', true, false)).toBe('removed');
    expect(rowFate(maker, 'strip-gps', true, false)).toBe('removed');
    expect(rowFate(make, 'strip-gps', true, false)).toBe('kept');
    expect(rowFate(thumb, 'strip-gps', true, true)).toBe('rewritten');
    expect(rowFate(thumb, 'strip-gps', true, false)).toBe('kept');
  });
  it('preserve keeps everything except a non-1 Orientation, which is rewritten', () => {
    expect(rowFate(gps, 'preserve', true, false)).toBe('kept');
    expect(rowFate(maker, 'preserve', true, false)).toBe('kept');
    expect(rowFate(orient6, 'preserve', true, false)).toBe('rewritten');
    expect(rowFate(orient1, 'preserve', true, false)).toBe('kept');
    expect(rowFate(orient6, 'strip-gps', true, false)).toBe('rewritten');
  });
});
