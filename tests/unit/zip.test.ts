import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { dosDateTime, uniqueNames, writeZip, zipSize, ZIP_MAX_ENTRIES } from '../../src/zip';

const bytes = (s: string) => new TextEncoder().encode(s);
const u32 = (b: Uint8Array, off: number) => new DataView(b.buffer, b.byteOffset).getUint32(off, true);
const u16 = (b: Uint8Array, off: number) => new DataView(b.buffer, b.byteOffset).getUint16(off, true);

/** Independent CRC-32 (bitwise, no table; shares no code with the writer). */
function crc32Reference(data: Uint8Array): number {
  let c = ~0;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

describe('zip writer', () => {
  it('an independent reader (fflate) extracts every entry byte-exact, names included', () => {
    const entries = [
      { name: 'a.png', data: bytes('PNG bytes') },
      { name: 'sub/ünïcode名前.jpg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]) },
      { name: 'empty.bin', data: new Uint8Array(0) },
    ];
    const zip = writeZip(entries, new Date(2026, 9, 11, 12, 34, 56));
    expect(zip.length).toBe(zipSize(entries));
    const back = unzipSync(zip);
    expect(Object.keys(back).sort()).toEqual(entries.map((e) => e.name).sort());
    for (const e of entries) expect(Array.from(back[e.name]!)).toEqual(Array.from(e.data));
  });

  it('stores (method 0), sets the UTF-8 flag, and writes the CRC-32 of the data', () => {
    const data = new Uint8Array(1000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7919) & 255;
    const zip = writeZip([{ name: 'noise.bin', data }]);
    expect(u32(zip, 0)).toBe(0x04034b50);
    expect(u16(zip, 6) & 0x0800).toBe(0x0800);
    expect(u16(zip, 8)).toBe(0);
    expect(u32(zip, 18)).toBe(1000); // compressed size == uncompressed size: stored
    expect(u32(zip, 22)).toBe(1000);
    expect(u32(zip, 14)).toBe(crc32Reference(data));
    expect(crc32Reference(bytes('123456789'))).toBe(0xcbf43926); // the reference implementation's own check value
    expect(Array.from(unzipSync(zip)['noise.bin']!)).toEqual(Array.from(data));
  });

  it('stores a DOS timestamp with 2-second resolution and clamps to 1980', () => {
    const t = dosDateTime(new Date(2026, 9, 11, 13, 5, 31));
    expect(t.time >> 11).toBe(13);
    expect((t.time >> 5) & 63).toBe(5);
    expect((t.time & 31) * 2).toBe(30);
    expect((t.date >> 9) + 1980).toBe(2026);
    expect((t.date >> 5) & 15).toBe(10);
    expect(t.date & 31).toBe(11);
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });

  it('refuses invalid or duplicate names and too many entries', () => {
    const d = bytes('x');
    expect(() => writeZip([{ name: '/abs.png', data: d }])).toThrow(/Invalid/);
    expect(() => writeZip([{ name: '../up.png', data: d }])).toThrow(/Invalid/);
    expect(() => writeZip([{ name: 'a\\b.png', data: d }])).toThrow(/Invalid/);
    expect(() => writeZip([{ name: 'a.png', data: d }, { name: 'a.png', data: d }])).toThrow(/Duplicate/);
    const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, data: new Uint8Array(0) }));
    expect(() => writeZip(many)).toThrow(/at most/);
  });

  it('the central directory offsets point at each local header', () => {
    const entries = [
      { name: 'one', data: bytes('111') },
      { name: 'two', data: bytes('22222') },
    ];
    const zip = writeZip(entries);
    const end = zip.length - 22;
    expect(u32(zip, end)).toBe(0x06054b50);
    expect(u16(zip, end + 10)).toBe(2);
    const cd = u32(zip, end + 16);
    let off = cd;
    for (const e of entries) {
      expect(u32(zip, off)).toBe(0x02014b50);
      const local = u32(zip, off + 42);
      expect(u32(zip, local)).toBe(0x04034b50);
      const nameLen = u16(zip, local + 26);
      expect(new TextDecoder().decode(zip.subarray(local + 30, local + 30 + nameLen))).toBe(e.name);
      off += 46 + u16(zip, off + 28);
    }
    expect(off).toBe(end);
  });
});

describe('uniqueNames', () => {
  it('suffixes collisions with -2, -3 and treats case as a collision', () => {
    expect(uniqueNames(['a.png', 'b.png', 'a.png', 'A.PNG', 'a-2.png'])).toEqual(['a.png', 'b.png', 'a-2.png', 'A-3.PNG', 'a-2-2.png']);
    expect(uniqueNames(['noext', 'noext'])).toEqual(['noext', 'noext-2']);
    expect(uniqueNames(['.hidden', '.hidden'])).toEqual(['.hidden', '.hidden-2']);
  });
});
