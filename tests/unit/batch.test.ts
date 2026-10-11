import { describe, expect, it } from 'vitest';
import { aggregateLosses, batchCounts, outputFilename } from '../../src/batch';
import type { Loss } from '../../src/capabilities';

const loss = (kind: Loss['kind'], severity: Loss['severity'], message: string = kind): Loss => ({ kind, severity, message });

describe('outputFilename', () => {
  it('swaps the extension and avoids producing the source name', () => {
    expect(outputFilename('photo.jpg', 'png')).toBe('photo.png');
    expect(outputFilename('photo.png', 'png')).toBe('photo-converted.png');
    expect(outputFilename('archive.tar.gz', 'webp')).toBe('archive.tar.webp');
    expect(outputFilename('noext', 'jpeg')).toBe('noext.jpg');
    expect(outputFilename('.png', 'png')).toBe('image.png');
  });
});

describe('aggregateLosses', () => {
  it('counts each kind across files and keeps pixel losses first', () => {
    const agg = aggregateLosses([
      [loss('exif', 'metadata', 'EXIF removed (file 0)'), loss('bit-depth', 'pixels')],
      [loss('exif', 'metadata', 'EXIF removed (file 1)')],
      [],
    ]);
    expect(agg.map((a) => [a.kind, a.count, a.total, a.files])).toEqual([
      ['bit-depth', 1, 3, [0]],
      ['exif', 2, 3, [0, 1]],
    ]);
    expect(agg[1]!.message).toBe('EXIF removed (file 0)');
  });
  it('a kind repeated within one file counts that file once', () => {
    const agg = aggregateLosses([[loss('xmp', 'metadata'), loss('xmp', 'metadata')]]);
    expect(agg).toHaveLength(1);
    expect(agg[0]!.count).toBe(1);
  });
  it('no files, or files without losses, aggregate to nothing', () => {
    expect(aggregateLosses([])).toEqual([]);
    expect(aggregateLosses([[], []])).toEqual([]);
  });
});

describe('batchCounts', () => {
  it('tallies statuses and verification outcomes', () => {
    const v = (identical: boolean, metadataOk = true) => ({ verification: { identical, metadataOk } });
    const c = batchCounts([
      { status: 'done', info: {}, output: v(true) },
      { status: 'done', info: {}, output: v(false, false) },
      { status: 'ready', info: {} },
      { status: 'error' },
      { status: 'cancelled', info: {} },
    ]);
    expect(c).toEqual({ total: 5, ready: 4, done: 2, identical: 1, differing: 1, metadataUnexpected: 1, failed: 1, cancelled: 1 });
  });
});
