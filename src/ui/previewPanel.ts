/**
 * The live quality preview under the quality slider: the size and the measured
 * pixel difference the current settings produce, with an optional compare view
 * (heat map, wipe) of that preview output. Presentational only.
 */
import { renderCompareView } from './compareView';
import { formatBytes, h } from './dom';
import type { PreviewOutput } from './state';

export interface PreviewView {
  quality: number;
  pixelCount: number;
  preview: PreviewOutput | null;
  /** The preview shown is for the current settings (not left over from a previous one). */
  fresh: boolean;
  busy: boolean;
  error: string | null;
  /** The source is large: previews run only when asked. */
  onDemand: boolean;
  compareOpen: boolean;
  onRun(): void;
  onToggleCompare(open: boolean): void;
}

/** One sentence of measured facts about a preview. */
export function previewSummary(p: PreviewOutput, pixelCount: number): string {
  const v = p.verification;
  const size = formatBytes(p.size);
  if (v.identical) return `Quality ${p.quality}: ${size}, and every pixel is identical at ${v.bitDepth}-bit.`;
  if (v.differingVisiblePixels === 0) return `Quality ${p.quality}: ${size}; every visible pixel is identical, ${v.differingPixels.toLocaleString()} fully transparent pixel(s) lose the colour under alpha 0.`;
  return `Quality ${p.quality}: ${size}; ${v.differingVisiblePixels.toLocaleString()} of ${pixelCount.toLocaleString()} pixels change, max per-channel difference ${v.maxChannelDiff} at ${v.bitDepth}-bit.`;
}

/** The compare view is rebuilt only when the preview it shows changes (the heat map is a canvas). */
let cachedCompare: { key: string; el: HTMLElement } | null = null;

export function renderPreview(view: PreviewView): HTMLElement {
  const root = h('div', { class: 'preview-box' });
  const stat = h('div', { class: 'preview-stat', 'data-testid': 'preview-stat', 'aria-live': 'polite', 'data-busy': String(view.busy), 'data-fresh': String(view.fresh) });

  if (view.onDemand && !view.busy) {
    stat.append(
      h('span', {}, 'This image is large, so the preview does not run on every slider move. '),
      h('button', { class: 'button secondary small', type: 'button', 'data-testid': 'preview-run', onClick: () => view.onRun() }, `Preview at quality ${view.quality}`),
    );
  } else if (view.busy) {
    stat.append(h('span', { class: 'preview-status' }, `Encoding at quality ${view.quality}…`));
  }
  if (view.error && !view.busy) stat.append(h('span', { class: 'preview-error' }, `Preview failed: ${view.error}`));
  if (view.preview) {
    const summary = h('span', { class: view.fresh ? 'preview-summary' : 'preview-summary stale', 'data-testid': 'preview-summary' }, previewSummary(view.preview, view.pixelCount));
    stat.append(summary);
    if (!view.fresh && !view.busy && !view.onDemand) stat.append(h('span', { class: 'preview-status' }, ' (previous settings)'));
  } else if (!view.busy && !view.onDemand && !view.error) {
    stat.append(h('span', { class: 'preview-status' }, 'Measuring what these settings produce…'));
  }
  root.append(h('p', { class: 'hint preview-note' }, 'The preview is the real encode at these settings, decoded again and compared: Convert produces exactly this file.'));
  root.append(stat);

  if (view.preview) {
    const p = view.preview;
    const toggle = h(
      'button',
      { class: 'button secondary small', type: 'button', 'data-testid': 'preview-compare-toggle', 'aria-expanded': String(view.compareOpen) },
      view.compareOpen ? 'Hide changed pixels' : p.diffMask ? `Show changed pixels (${p.verification.differingPixels.toLocaleString()})` : 'Show preview',
    );
    toggle.addEventListener('click', () => view.onToggleCompare(!view.compareOpen));
    root.append(h('div', { class: 'inline' }, toggle));
    if (view.compareOpen) {
      if (!cachedCompare || cachedCompare.key !== p.key) {
        cachedCompare = {
          key: p.key,
          el: renderCompareView({ sourceUrl: p.sourceUrl, outputUrl: p.url, width: p.width, height: p.height, diffMask: p.diffMask, differingPixels: p.verification.differingPixels, sourceComparable: !p.geometryChanged }),
        };
      }
      const host = h('div', { class: view.fresh ? 'preview-compare' : 'preview-compare stale', 'data-testid': 'preview-compare' });
      host.append(cachedCompare.el);
      root.append(host);
    }
  }
  return root;
}
