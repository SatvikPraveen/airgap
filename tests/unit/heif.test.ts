/**
 * Airgap's HEIF reader (src/codecs/heif.ts) on HEIC files written by Apple's own encoder (macOS
 * `sips`), and the HEIC header facts. No HEVC is decoded here; that is the platform's job.
 */
import { describe, expect, it } from 'vitest';
import { alphaItem, gridLayout, heifMetadata, hvcCDepth, isHeic, itemSize, parseHeif, transformsOf } from '../../src/codecs/heif';
import { hevcCodecString } from '../../src/codecs/heic';
import { inspect } from '../../src/inspect';
import { fixture } from './helpers';

describe('HEIF reader on Apple-encoded HEIC', () => {
  it('a single coded image: primary item, size, depth, HEVC codec string', () => {
    const b = fixture('rgb8.heic');
    expect(isHeic(b)).toBe(true);
    const f = parseHeif(b);
    const p = f.items.get(f.primaryId)!;
    expect(p.type).toBe('hvc1');
    expect(itemSize(p)).toEqual({ width: 64, height: 48 });
    expect(hvcCDepth(p)).toBe(8);
    expect(hevcCodecString(p.props.find((x) => x.type === 'hvcC')!.data)).toMatch(/^hvc1\.[A-C]?\d+\.[0-9A-F]+\.[LH]\d+(\.[0-9A-F]+)*$/);
    expect(f.data(p.id).length).toBeGreaterThan(100);
  });
  it('an image with alpha: the auxiliary alpha item is found through its auxl reference', () => {
    const f = parseHeif(fixture('rgba-partial.heic'));
    const a = alphaItem(f, f.primaryId);
    expect(a?.type).toBe('hvc1');
    expect(itemSize(a!)).toEqual({ width: 64, height: 48 });
  });
  it('a large image is a grid of 512-pixel tiles whose output size crops the overhang', () => {
    const f = parseHeif(fixture('grid.heic'));
    const p = f.items.get(f.primaryId)!;
    expect(p.type).toBe('grid');
    const g = gridLayout(f, p);
    expect(g).toMatchObject({ rows: 2, columns: 3, width: 1100, height: 600 });
    expect(g.tiles.map((t) => f.items.get(t)!.type)).toEqual(new Array(6).fill('hvc1'));
    expect(itemSize(f.items.get(g.tiles[0]!)!)).toEqual({ width: 512, height: 512 });
    expect(transformsOf(p)).toEqual({ rotateCcw: 0, mirror: null });
  });
  it('inspect() reports HEIC facts', () => {
    const h = inspect(fixture('grid.heic'));
    expect(h).toMatchObject({ format: 'heic', width: 1100, height: 600 });
    expect(h.metadata.colorLayout).toBe('HEVC, 2x3 tile grid, 8-bit');
    expect(h.metadata.sourceLossless).toBe(false);
    expect(inspect(fixture('rgba-partial.heic')).metadata.hasAlpha).toBe(true);
    expect(inspect(fixture('rgb8.heic')).metadata.hasAlpha).toBe(false);
  });
  it('metadata payloads: ICC from colr when the file carries one; nothing invented', () => {
    const md = heifMetadata(parseHeif(fixture('rgb8.heic')));
    expect(md.exif).toBeUndefined();
    if (md.icc) expect(md.icc.subarray(36, 40).toString()).toBe([0x61, 0x63, 0x73, 0x70].toString()); // 'acsp'
  });
  it('rejects a file without a meta box and is not mistaken for AVIF', () => {
    expect(() => parseHeif(fixture('rgba-partial.avif').slice(0, 32))).toThrow(/meta/);
    expect(isHeic(fixture('rgba-partial.avif'))).toBe(false);
    expect(inspect(fixture('rgba-partial.avif')).format).toBe('avif');
  });
});
