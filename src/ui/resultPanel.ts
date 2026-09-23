import { label } from '../capabilities';
import { formatBytes, h } from './dom';
import type { ConversionOutput } from './state';

export function renderResult(r: ConversionOutput): HTMLElement {
  const v = r.verification;
  let cls: string;
  let text: string;
  if (v.identical) {
    cls = 'identical';
    text = `Verified: the output was decoded again and every pixel matches${
      v.comparedAgainstFlattened ? ' the flattened image' : ' the source'
    } exactly (per-channel difference 0).`;
  } else if (v.differingVisiblePixels === 0) {
    cls = 'hidden-only';
    text = `Verified: every visible pixel matches. ${v.differingPixels} fully transparent pixel(s) lost the colour stored under alpha 0 (max channel difference ${v.maxChannelDiff}).`;
  } else {
    cls = 'differs';
    text = `Measured: ${v.differingVisiblePixels} of ${r.pixelCount} pixels differ from ${
      v.comparedAgainstFlattened ? 'the flattened image' : 'the source'
    } (max per-channel difference ${v.maxChannelDiff} of 255). This is the actual loss of the encoder you chose.`;
  }

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
        h('dd', {}, `${label(r.format)} · ${formatBytes(r.size)}`),
        h('dt', {}, 'File'),
        h('dd', {}, r.filename),
      ),
      h(
        'div',
        { class: `verification ${cls}`, 'data-testid': 'verification', 'data-identical': String(v.identical) },
        text,
      ),
      h('p', {}, h('a', { class: 'button', href: r.url, download: r.filename, 'data-testid': 'download' }, 'Download')),
    ),
  );
}
