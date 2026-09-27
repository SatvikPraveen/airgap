/**
 * Metadata inspector: every EXIF tag in the source, and what the selected
 * mode does to each one, plus the XMP text. The point is that nothing
 * leaves the file without the user having been able to look at it first.
 */
import type { MetadataMode } from '../capabilities';
import { rowFate, type ExifTagRow, type RowFate } from '../metadata/exif-list';
import type { SourceInfo } from '../protocol';
import { formatBytes, h } from './dom';

const FATE_LABEL: Record<RowFate, string> = { kept: 'kept', removed: 'removed', rewritten: 'rewritten' };

export interface MetadataPanelInput {
  info: SourceInfo;
  mode: MetadataMode;
  /** Whether the selected target's encoder can embed EXIF at all (probed). Undefined while unknown. */
  encoderCarriesExif: boolean | undefined;
  open: boolean;
  onToggle: (open: boolean) => void;
}

export function renderMetadataPanel(p: MetadataPanelInput): HTMLElement | null {
  const { info } = p;
  const rows = info.exifTags ?? [];
  const xmp = info.xmpText;
  if (!rows.length && !xmp) return null;

  const carries = p.encoderCarriesExif ?? true;
  const counts: Record<RowFate, number> = { kept: 0, removed: 0, rewritten: 0 };
  const fates = rows.map((r) => {
    const f = rowFate(r, p.mode, carries, !!info.metadata.thumbnailHasMetadata);
    counts[f]++;
    return f;
  });

  const summaryBits: string[] = [];
  if (rows.length) summaryBits.push(`${rows.length} EXIF tag${rows.length === 1 ? '' : 's'}`);
  if (xmp) summaryBits.push(`XMP ${formatBytes(info.xmpBytes ?? xmp.length)}`);
  const modeSummary = rows.length
    ? p.mode === 'strip-all' || !carries
      ? 'all removed'
      : `${counts.kept} kept · ${counts.removed} removed · ${counts.rewritten} rewritten`
    : '';

  const details = h('details', { class: 'metadata-inspector', 'data-testid': 'metadata-inspector' });
  if (p.open) details.setAttribute('open', '');
  details.addEventListener('toggle', () => p.onToggle(details.open));
  details.append(
    h('summary', {}, h('strong', {}, 'Inspect metadata'), h('span', { class: 'hint' }, ` ${summaryBits.join(' · ')}${modeSummary ? ` · with the selected mode: ${modeSummary}` : ''}`)),
  );

  if (rows.length) {
    const table = h('table', { class: 'tags', 'data-testid': 'exif-table' });
    table.append(h('thead', {}, h('tr', {}, h('th', {}, 'IFD'), h('th', {}, 'Tag'), h('th', {}, 'Type'), h('th', {}, 'Value'), h('th', {}, 'Fate'))));
    const tbody = h('tbody');
    rows.forEach((r, i) => {
      const fate = fates[i]!;
      tbody.append(
        h(
          'tr',
          { class: `fate-${fate}`, 'data-fate': fate, 'data-ifd': r.ifd, 'data-tag': r.name },
          h('td', {}, r.ifd),
          h('td', {}, h('code', {}, r.name)),
          h('td', { class: 'muted' }, `${r.type}${r.count > 1 ? `[${r.count}]` : ''}`),
          h('td', { class: 'value' }, r.value),
          h('td', {}, h('span', { class: `fate ${fate}` }, FATE_LABEL[fate])),
        ),
      );
    });
    table.append(tbody);
    details.append(
      h(
        'p',
        { class: 'hint' },
        p.mode === 'strip-all'
          ? 'Strip all: every tag below is removed.'
          : !carries
            ? 'The selected target cannot embed EXIF, so every tag below is removed regardless of mode.'
            : p.mode === 'strip-gps'
              ? 'Strip GPS only: the GPS IFD and its pointer, the MakerNote, and metadata inside the thumbnail are removed; everything else is kept. Orientation is rewritten to 1 because pixels are stored upright.'
              : 'Preserve all: every tag is kept, except Orientation, which is rewritten to 1 because pixels are stored upright.',
      ),
      h('div', { class: 'table-scroll' }, table),
    );
  }

  if (xmp) {
    const removed = p.mode !== 'preserve' || !(p.encoderCarriesExif ?? true);
    details.append(
      h(
        'div',
        { class: 'xmp', 'data-testid': 'xmp-block', 'data-fate': removed ? 'removed' : 'kept' },
        h('p', { class: 'hint' }, h('strong', {}, 'XMP'), ` (${formatBytes(info.xmpBytes ?? xmp.length)}) · `, h('span', { class: `fate ${removed ? 'removed' : 'kept'}` }, removed ? 'removed' : 'kept')),
        h('pre', {}, xmp + (info.xmpTruncated ? '\n… (truncated for display)' : '')),
      ),
    );
  }
  return details;
}
