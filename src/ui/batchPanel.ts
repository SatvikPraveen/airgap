/**
 * Batch mode panels: the queue (one row per file with its facts, status,
 * verification and download), the aggregated loss list, and the archive
 * download. Presentational only; the app owns the state and the loop.
 */
import type { AggregatedLoss } from '../batch';
import { batchCounts } from '../batch';
import { label } from '../capabilities';
import { formatBytes, h } from './dom';
import type { BatchItem, BatchState } from './state';

const STATUS_TEXT: Record<BatchItem['status'], string> = {
  waiting: 'waiting',
  reading: 'reading…',
  ready: 'ready',
  error: 'error',
  converting: 'converting…',
  done: 'done',
  cancelled: 'cancelled',
};

function verificationCell(it: BatchItem): HTMLElement {
  const o = it.output;
  if (!o) return h('td', { class: 'muted' }, it.status === 'error' ? (it.error ?? 'error') : it.status === 'cancelled' ? 'cancelled before verification' : '');
  const v = o.verification;
  const px = v.identical ? 'pixel-identical' : v.differingVisiblePixels === 0 ? `${v.differingPixels.toLocaleString()} transparent px lost their hidden colour` : `${v.differingVisiblePixels.toLocaleString()} px differ (max ${v.maxChannelDiff} at ${v.bitDepth}-bit)`;
  const meta = v.metadataOk ? 'metadata as planned' : 'metadata UNEXPECTED';
  return h('td', { class: `verification-cell ${v.identical ? 'identical' : 'differs'}`, 'data-identical': String(v.identical), 'data-metadata-ok': String(v.metadataOk) }, `${px}; ${meta}`);
}

export function renderBatchQueue(batch: BatchState, handlers: { onRemove(index: number): void }): HTMLElement {
  const table = h('table', { class: 'queue', 'data-testid': 'batch-table' });
  table.append(h('thead', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Source'), h('th', {}, 'Status'), h('th', {}, 'Output'), h('th', {}, 'Verification'), h('th', {}, ''))));
  const tbody = h('tbody');
  batch.items.forEach((it, i) => {
    const m = it.info?.metadata;
    const source = it.info
      ? `${label(it.info.format)} · ${it.info.width} × ${it.info.height} · ${m!.bitDepth}-bit${m!.hasAlpha ? ' · alpha' : ''}${m!.hasExif ? ' · EXIF' : ''}${m!.hasGps ? ' (GPS)' : ''}${m!.hasIcc ? ' · ICC' : ''}${m!.hasXmp ? ' · XMP' : ''}`
      : it.status === 'error'
        ? (it.error ?? 'unreadable')
        : '';
    const output = it.output ? `${label(it.output.format)} · ${it.output.bitDepth}-bit · ${formatBytes(it.output.size)}` : '';
    const remove = h('button', { class: 'button secondary small', type: 'button', 'aria-label': `Remove ${it.file.name} from the batch`, 'data-testid': 'batch-remove', onClick: () => handlers.onRemove(i) }, 'Remove');
    remove.disabled = batch.running;
    tbody.append(
      h(
        'tr',
        { 'data-testid': 'batch-row', 'data-status': it.status, 'data-name': it.file.name },
        h('td', { class: 'name' }, `${it.file.name}`, h('div', { class: 'hint' }, formatBytes(it.file.size))),
        h('td', { class: it.status === 'error' ? 'error-text' : '' }, source),
        h('td', { 'data-testid': 'batch-status' }, STATUS_TEXT[it.status]),
        h('td', {}, output),
        verificationCell(it),
        h('td', { class: 'actions' }, it.output ? h('a', { class: 'button secondary small', href: it.output.url, download: it.output.filename, 'data-testid': 'batch-download' }, 'Download') : null, remove),
      ),
    );
  });
  table.append(tbody);
  const c = batchCounts(batch.items);
  const summary = h('p', { class: 'hint', 'data-testid': 'batch-summary' }, `${c.total} files · ${c.ready} readable${c.failed ? ` · ${c.failed} unreadable` : ''}${c.done ? ` · ${c.done} converted` : ''}${c.cancelled ? ` · ${c.cancelled} cancelled` : ''}`);
  return h('div', { class: 'batch', 'data-testid': 'batch-panel' }, h('div', { class: 'table-scroll' }, table), summary, h('p', { class: 'hint' }, 'Each file was decoded once to read these facts and then released; it is decoded again when converted. Settings below apply to every file. The metadata inspector and the quality preview are per-file tools and are not shown in batch mode.'));
}

export function renderBatchLosses(agg: AggregatedLoss[], readable: number): HTMLElement {
  if (readable === 0) return h('p', { class: 'note' }, 'No readable file in the batch.');
  if (agg.length === 0) {
    return h('div', { class: 'ok', 'data-testid': 'loss-none' }, `Nothing, for all ${readable} files. Every output will be pixel-identical to its source and no metadata is dropped or altered.`);
  }
  const ul = h('ul', { class: 'losses', 'data-testid': 'loss-list' });
  for (const l of agg) {
    ul.append(
      h(
        'li',
        { class: l.severity, 'data-loss': l.kind, 'data-severity': l.severity, 'data-count': String(l.count) },
        h('span', { class: 'badge' }, l.severity),
        h('span', {}, h('strong', { 'data-testid': 'loss-count' }, l.count === l.total ? `All ${l.total} files: ` : `${l.count} of ${l.total} files: `), l.message),
      ),
    );
  }
  return ul;
}

export function renderBatchResult(batch: BatchState): HTMLElement {
  const c = batchCounts(batch.items);
  const lines: string[] = [];
  lines.push(`${c.done} of ${c.ready} readable files converted: ${c.identical} verified pixel-identical, ${c.differing} with measured differences${c.metadataUnexpected ? `, ${c.metadataUnexpected} with UNEXPECTED metadata` : ', metadata as planned in all'}.`);
  if (c.cancelled) lines.push(`${c.cancelled} cancelled.`);
  if (c.failed) lines.push(`${c.failed} could not be read.`);
  const status = h('div', { class: `verification ${c.differing || c.metadataUnexpected ? 'differs' : 'identical'}`, 'data-testid': 'batch-verification' }, lines.join(' '));
  const zip = batch.zip
    ? h('p', {}, h('a', { class: 'button', href: batch.zip.url, download: batch.zip.filename, 'data-testid': 'download-zip' }, `Download all (${batch.zip.filename}, ${formatBytes(batch.zip.size)}, ${batch.zip.entries} files)`), h('div', { class: 'hint' }, 'A stored (uncompressed) ZIP written by Airgap itself; the images inside are already compressed.'))
    : batch.zipError
      ? h('p', { class: 'error', role: 'alert', 'data-testid': 'zip-error' }, batch.zipError)
      : null;
  return h('div', { class: 'result batch-result' }, h('div', {}, status, zip));
}
