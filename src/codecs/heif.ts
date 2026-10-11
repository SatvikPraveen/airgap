/**
 * HEIF container model (ISO/IEC 23008-12), read by Airgap for HEIC sources. Pure. It finds the
 * primary item, its properties (through ipma), where every item's bytes are (iloc, including the
 * idat construction method), the references between items (grid tiles, alpha, EXIF), and the grid
 * layout. The HEVC bitstreams themselves are never decoded here: they go to the browser's or the
 * operating system's own licensed decoder (see codecs/heic.ts). Airgap ships no HEVC code.
 */

export interface HeifBox {
  type: string;
  start: number;
  end: number;
}

const u16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const ascii = (b: Uint8Array, o: number, n = 4) => String.fromCharCode(...b.subarray(o, o + n));
function readN(b: Uint8Array, o: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i]!;
  return v;
}

export function* heifBoxes(b: Uint8Array, start: number, end: number): Generator<HeifBox> {
  let off = start;
  while (off + 8 <= end) {
    let size = u32(b, off);
    const type = ascii(b, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = readN(b, off + 8, 8);
      header = 16;
    } else if (size === 0) size = end - off;
    if (size < header || off + size > end) return;
    yield { type, start: off + header, end: off + size };
    off += size;
  }
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']);

export function isHeic(b: Uint8Array): boolean {
  if (b.length < 16 || ascii(b, 4) !== 'ftyp') return false;
  const size = Math.min(b.length, u32(b, 0));
  for (let o = 8; o + 4 <= size; o += 4) if (o !== 12 && HEIC_BRANDS.has(ascii(b, o))) return true;
  return false;
}

export interface HeifProperty {
  type: string;
  /** Payload (after the box header; for full boxes the version/flags bytes are included). */
  data: Uint8Array;
  essential: boolean;
}

export interface HeifItem {
  id: number;
  type: string;
  /** e.g. the MIME content type of a 'mime' item. */
  contentType?: string;
  props: HeifProperty[];
  /** Item ids this item refers to, by reference type ('dimg', 'auxl', 'cdsc', 'thmb'). */
  refs: Map<string, number[]>;
}

export interface HeifFile {
  primaryId: number;
  items: Map<number, HeifItem>;
  /** The bytes of an item, extents concatenated (iloc, construction method 0 or 1). */
  data(id: number): Uint8Array;
}

export function parseHeif(b: Uint8Array): HeifFile {
  const meta = [...heifBoxes(b, 0, b.length)].find((x) => x.type === 'meta');
  if (!meta) throw new Error('HEIF: no meta box.');
  const mBoxes = [...heifBoxes(b, meta.start + 4, meta.end)];
  const pitm = mBoxes.find((x) => x.type === 'pitm');
  if (!pitm) throw new Error('HEIF: no primary item.');
  const primaryId = b[pitm.start]! === 0 ? u16(b, pitm.start + 4) : u32(b, pitm.start + 4);
  const items = new Map<number, HeifItem>();

  const iinf = mBoxes.find((x) => x.type === 'iinf');
  if (iinf) {
    const v = b[iinf.start]!;
    const listStart = iinf.start + 4 + (v === 0 ? 2 : 4);
    for (const inf of heifBoxes(b, listStart, iinf.end)) {
      if (inf.type !== 'infe') continue;
      const iv = b[inf.start]!;
      if (iv < 2) continue;
      const idOff = inf.start + 4;
      const id = iv === 2 ? u16(b, idOff) : u32(b, idOff);
      const typeOff = idOff + (iv === 2 ? 2 : 4) + 2;
      const item: HeifItem = { id, type: ascii(b, typeOff), props: [], refs: new Map() };
      if (item.type === 'mime') {
        let z = typeOff + 4;
        while (z < inf.end && b[z] !== 0) z++;
        let e = z + 1;
        while (e < inf.end && b[e] !== 0) e++;
        item.contentType = ascii(b, z + 1, e - z - 1);
      }
      items.set(id, item);
    }
  }

  const iprp = mBoxes.find((x) => x.type === 'iprp');
  if (iprp) {
    const parts = [...heifBoxes(b, iprp.start, iprp.end)];
    const ipco = parts.find((x) => x.type === 'ipco');
    const props = ipco ? [...heifBoxes(b, ipco.start, ipco.end)] : [];
    for (const ipma of parts.filter((x) => x.type === 'ipma')) {
      const v = b[ipma.start]!;
      const flags = b[ipma.start + 3]! & 1;
      let o = ipma.start + 4;
      const n = u32(b, o);
      o += 4;
      for (let i = 0; i < n; i++) {
        const id = v < 1 ? u16(b, o) : u32(b, o);
        o += v < 1 ? 2 : 4;
        const count = b[o++]!;
        for (let k = 0; k < count; k++) {
          const raw = flags ? u16(b, o) : b[o]!;
          o += flags ? 2 : 1;
          const essential = flags ? (raw & 0x8000) !== 0 : (raw & 0x80) !== 0;
          const index = flags ? raw & 0x7fff : raw & 0x7f;
          const p = props[index - 1];
          const item = items.get(id);
          if (p && item) item.props.push({ type: p.type, data: b.subarray(p.start, p.end), essential });
        }
      }
    }
  }

  const iref = mBoxes.find((x) => x.type === 'iref');
  if (iref) {
    const v = b[iref.start]!;
    for (const r of heifBoxes(b, iref.start + 4, iref.end)) {
      let o = r.start;
      const from = v === 0 ? u16(b, o) : u32(b, o);
      o += v === 0 ? 2 : 4;
      const n = u16(b, o);
      o += 2;
      const to: number[] = [];
      for (let i = 0; i < n; i++) {
        to.push(v === 0 ? u16(b, o) : u32(b, o));
        o += v === 0 ? 2 : 4;
      }
      const item = items.get(from);
      if (item) item.refs.set(r.type, [...(item.refs.get(r.type) ?? []), ...to]);
    }
  }

  const idat = mBoxes.find((x) => x.type === 'idat');
  const locations = new Map<number, { method: number; extents: { offset: number; length: number }[] }>();
  const iloc = mBoxes.find((x) => x.type === 'iloc');
  if (iloc) {
    const v = b[iloc.start]!;
    let o = iloc.start + 4;
    const offsetSize = b[o]! >> 4;
    const lengthSize = b[o]! & 15;
    const baseOffsetSize = b[o + 1]! >> 4;
    const indexSize = v === 1 || v === 2 ? b[o + 1]! & 15 : 0;
    o += 2;
    const count = v < 2 ? u16(b, o) : u32(b, o);
    o += v < 2 ? 2 : 4;
    for (let i = 0; i < count; i++) {
      const id = v < 2 ? u16(b, o) : u32(b, o);
      o += v < 2 ? 2 : 4;
      let method = 0;
      if (v === 1 || v === 2) {
        method = u16(b, o) & 15;
        o += 2;
      }
      o += 2; // data_reference_index
      const base = readN(b, o, baseOffsetSize);
      o += baseOffsetSize;
      const n = u16(b, o);
      o += 2;
      const extents: { offset: number; length: number }[] = [];
      for (let k = 0; k < n; k++) {
        o += indexSize;
        const off = readN(b, o, offsetSize);
        o += offsetSize;
        const len = readN(b, o, lengthSize);
        o += lengthSize;
        extents.push({ offset: base + off, length: len });
      }
      locations.set(id, { method, extents });
    }
  }

  return {
    primaryId,
    items,
    data(id) {
      const loc = locations.get(id);
      if (!loc) throw new Error(`HEIF: item ${id} has no location.`);
      const source = loc.method === 1 ? (idat ? b.subarray(idat.start, idat.end) : null) : b;
      if (!source) throw new Error('HEIF: item stored in idat, but there is no idat box.');
      if (loc.method > 1) throw new Error('HEIF: item construction method 2 is not supported.');
      const parts = loc.extents.map((e) => {
        const end = e.length === 0 ? source.length : e.offset + e.length;
        if (end > source.length) throw new Error('HEIF: item extent outside the file.');
        return source.subarray(e.offset, end);
      });
      if (parts.length === 1) return parts[0]!;
      const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
      let k = 0;
      for (const p of parts) (out.set(p, k), (k += p.length));
      return out;
    },
  };
}

export const prop = (item: HeifItem, type: string): HeifProperty | undefined => item.props.find((p) => p.type === type);

/** Image size from the item's ispe property. */
export function itemSize(item: HeifItem): { width: number; height: number } | null {
  const p = prop(item, 'ispe');
  return p ? { width: u32(p.data, 4), height: u32(p.data, 8) } : null;
}

/** Bit depth from an hvcC property (bitDepthLumaMinus8 + 8). */
export function hvcCDepth(item: HeifItem): number | null {
  const p = prop(item, 'hvcC');
  return p && p.data.length > 17 ? (p.data[17]! & 7) + 8 : null;
}

/** The alpha auxiliary item for `masterId`, if any (auxC urn ends in "alpha" or HEVC auxid 1). */
export function alphaItem(f: HeifFile, masterId: number): HeifItem | undefined {
  for (const it of f.items.values()) {
    if (!it.refs.get('auxl')?.includes(masterId)) continue;
    const aux = prop(it, 'auxC');
    if (aux && /alpha|auxid:1/.test(ascii(aux.data, 4, Math.min(64, aux.data.length - 4)))) return it;
  }
  return undefined;
}

export interface GridLayout {
  rows: number;
  columns: number;
  width: number;
  height: number;
  tiles: number[];
}

/** ImageGrid ('grid' item data): rows/columns and the output size; tiles from the dimg reference. */
export function gridLayout(f: HeifFile, item: HeifItem): GridLayout {
  const d = f.data(item.id);
  const large = (d[1]! & 1) !== 0;
  const rows = d[2]! + 1;
  const columns = d[3]! + 1;
  const width = large ? u32(d, 4) : u16(d, 4);
  const height = large ? u32(d, 8) : u16(d, 6);
  const tiles = item.refs.get('dimg') ?? [];
  if (tiles.length !== rows * columns) throw new Error(`HEIF: grid of ${rows}x${columns} references ${tiles.length} tiles.`);
  return { rows, columns, width, height, tiles };
}

/** irot (counter-clockwise quarter turns) and imir (0: top-bottom axis flip, 1: left-right). */
export function transformsOf(item: HeifItem): { rotateCcw: number; mirror: number | null } {
  const r = prop(item, 'irot');
  const m = prop(item, 'imir');
  return { rotateCcw: r ? r.data[0]! & 3 : 0, mirror: m ? m.data[0]! & 1 : null };
}

/** EXIF (bare TIFF), XMP and ICC payloads of the primary item. */
export function heifMetadata(f: HeifFile): { exif?: Uint8Array; xmp?: Uint8Array; icc?: Uint8Array } {
  const out: { exif?: Uint8Array; xmp?: Uint8Array; icc?: Uint8Array } = {};
  for (const it of f.items.values()) {
    const describes = it.refs.get('cdsc');
    if (describes && !describes.includes(f.primaryId)) continue;
    try {
      if (it.type === 'Exif' && !out.exif) {
        const d = f.data(it.id);
        out.exif = d.subarray(4 + u32(d, 0));
      } else if (it.type === 'mime' && it.contentType?.startsWith('application/rdf+xml') && !out.xmp) out.xmp = f.data(it.id);
    } catch {
      /* unreadable item: reported as absent */
    }
  }
  const primary = f.items.get(f.primaryId);
  const colr = primary?.props.find((p) => p.type === 'colr' && (ascii(p.data, 0) === 'prof' || ascii(p.data, 0) === 'rICC'));
  if (colr) out.icc = colr.data.subarray(4);
  return out;
}
