import { label } from '../capabilities';
import type { MetadataOutcome } from '../convert';
import { formatBytes, h } from './dom';
import type { ConversionOutput } from './state';

const OUTCOME: Record<MetadataOutcome, string> = {
  kept: 'kept',
  removed: 'removed',
  absent: 'not in source',
  unexpected: 'UNEXPECTED',
};

export function renderResult(r: ConversionOutput): HTMLElement {
  const v = r.verification;
  const baseline = v.comparedAgainstFlattened ? 'the flattened image' : v.comparedAgainstConverted ? 'the sRGB-converted image' : 'the source';
  let cls: string;
  let text: string;
  if (v.identical) {
    cls = 'identical';
    text = `Verified: the output was decoded again (${v.verifierId}) and every pixel matches ${baseline} exactly at ${v.bitDepth}-bit (per-channel difference 0, transparent pixels included).`;
  } else if (v.differingVisiblePixels === 0) {
    cls = 'differs';
    text = `Measured: every visible pixel matches ${baseline}, but ${v.differingPixels} fully transparent pixel(s) lost the colour stored under alpha 0 (max channel difference ${v.maxChannelDiff}).`;
  } else {
    cls = 'differs';
    text = `Measured: ${v.differingVisiblePixels} of ${r.pixelCount} pixels differ from ${baseline} (max per-channel difference ${v.maxChannelDiff} at ${v.bitDepth}-bit). This is the actual loss of the encoder you chose.`;
  }

  const meta = h(
    'div',
    { class: `verification ${v.metadataOk ? 'identical' : 'differs'}`, 'data-testid': 'metadata-check', 'data-ok': String(v.metadataOk) },
    `Metadata re-read from the output: EXIF ${OUTCOME[v.metadata.exif]}, GPS ${OUTCOME[v.metadata.gps]}, ICC ${OUTCOME[v.metadata.icc]}, XMP ${OUTCOME[v.metadata.xmp]}.`,
  );

  return h(
    'div',
    { class: 'result' },
    h('div', { class: 'thumb' }, h('img', { src: r.url, alt: '' })),
    h(
      'div',
      {},
      h(
        'dl',
        { class: 'facts' },
        h('dt', {}, 'Output'),
        h('dd', { 'data-testid': 'result-format' }, `${label(r.format)} · ${r.bitDepth}-bit · ${formatBytes(r.size)} · ${r.encoderId}`),
        h('dt', {}, 'File'),
        h('dd', {}, r.filename),
      ),
      h('div', { class: `verification ${cls}`, 'data-testid': 'verification', 'data-identical': String(v.identical) }, text),
      meta,
      h('p', {}, h('a', { class: 'button', href: r.url, download: r.filename, 'data-testid': 'download' }, 'Download')),
    ),
  );
}
