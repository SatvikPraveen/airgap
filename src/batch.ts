/**
 * Pure helpers for batch conversion: output naming and the aggregation of
 * per-file loss lists into one honest panel ("EXIF removed: 3 of 7 files").
 * No DOM, no worker.
 */
import type { Loss, LossKind, LossSeverity } from './capabilities';
import { EXTENSION, type ImageFormat } from './codecs/types';

/** "photo.jpg" -> "photo.png"; a name that would not change gets "-converted". */
export function outputFilename(sourceName: string, format: ImageFormat): string {
  const base = sourceName.replace(/\.[^.]+$/, '') || 'image';
  const ext = EXTENSION[format];
  return `${base}.${ext}` === sourceName ? `${base}-converted.${ext}` : `${base}.${ext}`;
}

export interface AggregatedLoss {
  kind: LossKind;
  severity: LossSeverity;
  /** The message of the first file that has this loss; wording may vary slightly per file (format names). */
  message: string;
  /** How many files in the batch have this loss. */
  count: number;
  /** Files in the batch that were considered. */
  total: number;
  /** Indices (into the input) of the files with this loss. */
  files: number[];
}

/**
 * Merges per-file loss lists by kind, preserving the order in which kinds first
 * appear (pixel losses before metadata, as computeLosses emits them). A kind
 * present in some files only is reported with its count, never hidden.
 */
export function aggregateLosses(perFile: Loss[][]): AggregatedLoss[] {
  const byKind = new Map<LossKind, AggregatedLoss>();
  perFile.forEach((losses, i) => {
    const seenHere = new Set<LossKind>();
    for (const l of losses) {
      if (seenHere.has(l.kind)) continue;
      seenHere.add(l.kind);
      const agg = byKind.get(l.kind);
      if (agg) {
        agg.count++;
        agg.files.push(i);
      } else byKind.set(l.kind, { kind: l.kind, severity: l.severity, message: l.message, count: 1, total: perFile.length, files: [i] });
    }
  });
  const out = [...byKind.values()];
  // Pixel losses first, then metadata, each group in first-seen order.
  return [...out.filter((a) => a.severity === 'pixels'), ...out.filter((a) => a.severity === 'metadata')];
}

export interface BatchCounts {
  total: number;
  ready: number;
  done: number;
  identical: number;
  differing: number;
  metadataUnexpected: number;
  failed: number;
  cancelled: number;
}

export type BatchItemLike = {
  info?: unknown;
  status: string;
  output?: { verification: { identical: boolean; metadataOk: boolean } } | undefined;
};

export function batchCounts(items: BatchItemLike[]): BatchCounts {
  const c: BatchCounts = { total: items.length, ready: 0, done: 0, identical: 0, differing: 0, metadataUnexpected: 0, failed: 0, cancelled: 0 };
  for (const it of items) {
    if (it.status === 'error') c.failed++;
    else if (it.status === 'cancelled') c.cancelled++;
    if (it.info !== undefined || it.status === 'ready' || it.status === 'done' || it.status === 'converting' || it.status === 'cancelled') c.ready++;
    if (it.output) {
      c.done++;
      if (it.output.verification.identical) c.identical++;
      else c.differing++;
      if (!it.output.verification.metadataOk) c.metadataUnexpected++;
    }
  }
  return c;
}
