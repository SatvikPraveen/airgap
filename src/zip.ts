/**
 * Minimal ZIP writer for the batch download: store-only (the entries are
 * already-compressed images), CRC-32, UTF-8 names, local headers + central
 * directory + end record. No ZIP64: the archive must stay under 4 GB and
 * 65,535 entries, which the caller checks before the first conversion.
 * Pure; no DOM. Read back in tests by an independent library (fflate).
 */
import { crc32 } from './crc32';

export interface ZipEntry {
  /** Path inside the archive. Forward slashes; no leading slash. */
  name: string;
  data: Uint8Array;
  /** Modification time stored in the entry (DOS time, 2-second resolution). */
  mtime?: Date;
}

export const ZIP_MAX_BYTES = 0xffffffff;
export const ZIP_MAX_ENTRIES = 0xffff;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const VERSION = 20; // 2.0: enough for store + UTF-8 flag
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;

/** MS-DOS date/time pair as stored in ZIP headers (local time, 2-second resolution, 1980-2107). */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Total archive size for these entries, before building it; used to refuse oversize batches. */
export function zipSize(entries: { name: string; data: { length: number } }[]): number {
  const enc = new TextEncoder();
  let total = 22;
  for (const e of entries) {
    const n = enc.encode(e.name).length;
    total += 30 + n + e.data.length + 46 + n;
  }
  return total;
}

export function writeZip(entries: ZipEntry[], now: Date = new Date()): Uint8Array<ArrayBuffer> {
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error(`A ZIP without ZIP64 holds at most ${ZIP_MAX_ENTRIES} entries.`);
  const size = zipSize(entries);
  if (size > ZIP_MAX_BYTES) throw new Error(`The archive would be ${size} bytes; a ZIP without ZIP64 is limited to 4 GB.`);
  const enc = new TextEncoder();
  const out = new Uint8Array(new ArrayBuffer(size));
  const dv = new DataView(out.buffer);
  const seen = new Set<string>();
  let off = 0;
  const central: { name: Uint8Array; crc: number; size: number; offset: number; time: number; date: number }[] = [];

  for (const e of entries) {
    if (e.name === '' || e.name.startsWith('/') || e.name.includes('\\') || e.name.split('/').includes('..')) throw new Error(`Invalid ZIP entry name: ${JSON.stringify(e.name)}`);
    if (seen.has(e.name)) throw new Error(`Duplicate ZIP entry name: ${e.name}`);
    seen.add(e.name);
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const { time, date } = dosDateTime(e.mtime ?? now);
    central.push({ name, crc, size: e.data.length, offset: off, time, date });
    dv.setUint32(off, SIG_LOCAL, true);
    dv.setUint16(off + 4, VERSION, true);
    dv.setUint16(off + 6, FLAG_UTF8, true);
    dv.setUint16(off + 8, METHOD_STORE, true);
    dv.setUint16(off + 10, time, true);
    dv.setUint16(off + 12, date, true);
    dv.setUint32(off + 14, crc, true);
    dv.setUint32(off + 18, e.data.length, true);
    dv.setUint32(off + 22, e.data.length, true);
    dv.setUint16(off + 26, name.length, true);
    dv.setUint16(off + 28, 0, true);
    out.set(name, off + 30);
    out.set(e.data, off + 30 + name.length);
    off += 30 + name.length + e.data.length;
  }

  const cdStart = off;
  for (const c of central) {
    dv.setUint32(off, SIG_CENTRAL, true);
    dv.setUint16(off + 4, VERSION, true); // version made by (MS-DOS attributes)
    dv.setUint16(off + 6, VERSION, true);
    dv.setUint16(off + 8, FLAG_UTF8, true);
    dv.setUint16(off + 10, METHOD_STORE, true);
    dv.setUint16(off + 12, c.time, true);
    dv.setUint16(off + 14, c.date, true);
    dv.setUint32(off + 16, c.crc, true);
    dv.setUint32(off + 20, c.size, true);
    dv.setUint32(off + 24, c.size, true);
    dv.setUint16(off + 28, c.name.length, true);
    dv.setUint16(off + 30, 0, true); // extra
    dv.setUint16(off + 32, 0, true); // comment
    dv.setUint16(off + 34, 0, true); // disk
    dv.setUint16(off + 36, 0, true); // internal attributes
    dv.setUint32(off + 38, 0, true); // external attributes
    dv.setUint32(off + 42, c.offset, true);
    out.set(c.name, off + 46);
    off += 46 + c.name.length;
  }
  const cdSize = off - cdStart;
  dv.setUint32(off, SIG_END, true);
  dv.setUint16(off + 4, 0, true);
  dv.setUint16(off + 6, 0, true);
  dv.setUint16(off + 8, central.length, true);
  dv.setUint16(off + 10, central.length, true);
  dv.setUint32(off + 12, cdSize, true);
  dv.setUint32(off + 16, cdStart, true);
  dv.setUint16(off + 20, 0, true);
  off += 22;
  if (off !== size) throw new Error(`zip writer size mismatch: wrote ${off}, planned ${size}`);
  return out;
}

/**
 * Makes output names unique within a batch: the second "photo.png" becomes
 * "photo-2.png", the third "photo-3.png". Case-insensitive, because the archive
 * may be extracted on a case-insensitive file system.
 */
export function uniqueNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}
