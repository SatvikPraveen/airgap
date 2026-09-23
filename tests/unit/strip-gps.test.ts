/**
 * "Strip GPS only" must be complete, not just GPS-IFD complete. The fixture
 * carries one location in four places: the EXIF GPS IFD, a MakerNote blob,
 * XMP, and the EXIF of the embedded IFD1 thumbnail. Completeness is asserted
 * by a raw byte scan for the coordinate values, never by parsed tag names.
 */
import { describe, expect, it } from 'vitest';
import { computeLosses, type TargetSpec } from '../../src/capabilities';
import { extractMetadata } from '../../src/metadata/containers';
import { stripGps, summarizeExif } from '../../src/metadata/exif';
import { findEntry, parseTiffStructure, TAG } from '../../src/metadata/tiff-ifd';
import * as P from '../fixtures/pattern.mjs';
import { caps, fixture, META } from './helpers';

const file = fixture('location-everywhere.jpg');
const meta = extractMetadata(file, 'jpeg');

describe('the fixture really hides the location everywhere', () => {
  it('EXIF GPS IFD, MakerNote, XMP and a thumbnail with its own EXIF are all present', () => {
    const s = summarizeExif(meta.exif!);
    expect(s.hasGps).toBe(true);
    expect(s.hasMakerNote).toBe(true);
    expect(s.hasThumbnail).toBe(true);
    expect(s.thumbnailHasMetadata).toBe(true);
    expect(meta.xmp).toBeDefined();
    expect(new TextDecoder().decode(meta.xmp)).toContain(P.LOCATION.xmpLat);
  });
  it('the raw scan finds the coordinates in the source bytes (positive control for the scan)', () => {
    const hits = P.findLocationNeedles(file);
    expect(hits.length).toBeGreaterThanOrEqual(9);
    expect(hits.some((h) => h.startsWith('maker note text'))).toBe(true);
    expect(hits.some((h) => h.startsWith('XMP latitude'))).toBe(true);
    expect(hits.some((h) => h.startsWith('lat DMS rationals BE'))).toBe(true);
  });
  it('the thumbnail alone contains the coordinates', () => {
    const s = parseTiffStructure(meta.exif!);
    const thumb = findEntry(s.ifd0.next!, TAG.JPEGInterchangeFormat)!.blob!;
    expect(P.findLocationNeedles(thumb).length).toBeGreaterThan(0);
  });
});

describe('stripGps on the EXIF payload', () => {
  const stripped = stripGps(meta.exif!);
  const before = summarizeExif(meta.exif!);
  const after = summarizeExif(stripped);

  it('no coordinate byte pattern survives anywhere in the stripped payload', () => {
    expect(P.findLocationNeedles(stripped)).toEqual([]);
  });
  it('GPS IFD, MakerNote and thumbnail metadata are gone; the thumbnail image and every other tag stay', () => {
    expect(after.hasGps).toBe(false);
    expect(after.hasMakerNote).toBe(false);
    expect(after.thumbnailHasMetadata).toBe(false);
    expect(after.hasThumbnail).toBe(true);
    expect(after.ifd0).toEqual(before.ifd0.filter((t) => t !== TAG.GpsIFD));
    expect(after.exif).toEqual(before.exif.filter((t) => t !== TAG.MakerNote));
    expect(after.make).toBe(before.make);
    expect(after.dateTime).toBe(before.dateTime);
    const s = parseTiffStructure(stripped);
    const thumb = findEntry(s.ifd0.next!, TAG.JPEGInterchangeFormat)!.blob!;
    expect(thumb[0]).toBe(0xff);
    expect(thumb[1]).toBe(0xd8);
    expect(P.findLocationNeedles(thumb)).toEqual([]);
  });
  it('is idempotent', () => {
    expect(summarizeExif(stripGps(stripped))).toEqual(after);
  });
});

describe('loss panel names what strip-GPS-only drops beyond the GPS IFD', () => {
  const t = (metadataMode: TargetSpec['metadataMode']): TargetSpec => ({ format: 'png', lossless: true, metadataMode, iccMode: 'strip' });
  const pipe = { decoder: caps(), encoder: caps() };
  const source = { format: 'jpeg' as const, metadata: { ...META, hasExif: true, hasGps: true, hasXmp: true, hasMakerNote: true, thumbnailHasMetadata: true } };
  it('strip-gps lists gps, makernote, thumbnail-metadata and xmp', () => {
    const l = computeLosses(source, t('strip-gps'), pipe);
    expect(l.map((x) => x.kind)).toEqual(['gps', 'makernote', 'thumbnail-metadata', 'xmp']);
    expect(l[1]!.message).toMatch(/cannot be cleaned selectively/);
    expect(l.every((x) => x.severity === 'metadata')).toBe(true);
  });
  it('preserve lists nothing for the same source; strip-all lists exif and xmp', () => {
    expect(computeLosses(source, t('preserve'), pipe)).toEqual([]);
    expect(computeLosses(source, t('strip-all'), pipe).map((x) => x.kind)).toEqual(['exif', 'xmp']);
  });
});
