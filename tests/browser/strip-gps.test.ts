/**
 * Strip-GPS-only completeness on REAL outputs: every target that can carry
 * metadata, scanned byte-by-byte for the coordinate values. Positive control:
 * "preserve" puts them back, so the scan demonstrably sees each container.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODES, type MetadataMode } from '../../src/capabilities';
import { CodecRegistry } from '../../src/codecs/registry';
import type { ImageFormat } from '../../src/codecs/types';
import { convert, prepareSource } from '../../src/convert';
import { inspect } from '../../src/inspect';
import * as P from '../fixtures/pattern.mjs';
import { fixtureBytes } from './helpers';

const registry = new CodecRegistry();

async function run(format: ImageFormat, metadataMode: MetadataMode): Promise<Uint8Array> {
  const bytes = await fixtureBytes('location-everywhere.jpg');
  const { image, used } = await registry.decode('jpeg', bytes);
  const enc = await registry.resolve(format, 'encode');
  const ver = await registry.resolve(format, 'decode');
  const r = await convert(
    { encoder: enc.codec, encoderCaps: enc.resolved.capabilities, decoderCaps: used.resolved.capabilities, verifier: ver.codec },
    prepareSource(image),
    'jpeg',
    { target: { format, lossless: format !== 'jpeg', ...DEFAULT_MODES, metadataMode }, quality: 0.9 },
  );
  return r.bytes;
}

const CARRIERS: ImageFormat[] = ['jpeg', 'png', 'webp', 'tiff'];

describe('strip GPS only: no coordinate survives anywhere', () => {
  it('the source is loaded with all four hiding places detected', async () => {
    const bytes = await fixtureBytes('location-everywhere.jpg');
    const { image } = await registry.decode('jpeg', bytes);
    expect(image.metadata.hasGps).toBe(true);
    expect(image.metadata.hasXmp).toBe(true);
    expect(P.findLocationNeedles(bytes).length).toBeGreaterThanOrEqual(9);
  });
  for (const format of [...CARRIERS, 'avif', 'jxl'] as ImageFormat[]) {
    it(`-> ${format}: raw byte scan of the output finds nothing`, async () => {
      const out = await run(format, 'strip-gps');
      expect(P.findLocationNeedles(out)).toEqual([]);
      const h = inspect(out).metadata;
      expect(h.hasGps).toBe(false);
      expect(h.hasXmp).toBe(false);
    });
  }
  for (const format of CARRIERS) {
    it(`positive control -> ${format} preserve: the scan DOES find coordinates in this container`, async () => {
      const out = await run(format, 'preserve');
      const hits = P.findLocationNeedles(out);
      expect(hits.length, hits.join(', ')).toBeGreaterThan(0);
      expect(hits.some((x) => x.startsWith('maker note text')), 'MakerNote carried in preserve').toBe(true);
      expect(hits.some((x) => x.startsWith('XMP latitude')), 'XMP carried in preserve').toBe(true);
    });
  }
  for (const format of CARRIERS) {
    it(`-> ${format} strip-gps keeps the non-location tags`, async () => {
      const out = await run(format, 'strip-gps');
      const h = inspect(out).metadata;
      expect(h.hasExif).toBe(true);
      const { summarizeExif } = await import('../../src/metadata/exif');
      const { extractMetadata } = await import('../../src/metadata/containers');
      const { exifFromTiff } = await import('../../src/codecs/tiff');
      const { parseTiffStructure } = await import('../../src/metadata/tiff-ifd');
      const exif = format === 'tiff' ? exifFromTiff(parseTiffStructure(out))! : extractMetadata(out, format).exif!;
      const s = summarizeExif(exif);
      expect(s.make).toBe('Airgap Fixtures');
      expect(s.exif).toContain(0x9003);
      expect(s.hasMakerNote).toBe(false);
    });
  }
});
