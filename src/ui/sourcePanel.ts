import { label } from '../capabilities';
import { formatBytes, h } from './dom';
import type { LoadedSource } from './state';

export function renderSource(src: LoadedSource): HTMLElement {
  const m = src.info.metadata;
  const facts: [string, string][] = [
    ['File', `${src.file.name} (${formatBytes(src.file.size)})`],
    ['Format', `${label(src.info.format)}${m.sourceLossless === false ? ' (lossy source)' : ''}`],
    ['Size', `${src.info.width} × ${src.info.height} px`],
    ['Bit depth', `${m.bitDepth}-bit per channel`],
    [
      'Alpha',
      !m.hasAlpha
        ? 'none'
        : !m.hasTransparency
          ? 'channel present, fully opaque'
          : m.hasSemiTransparency
            ? 'yes, with semi-transparent pixels'
            : 'yes, fully transparent pixels only (no partial alpha)',
    ],
    ['EXIF', m.hasExif ? (m.hasGps ? 'present, includes GPS location' : 'present') : 'none'],
    ['ICC profile', m.hasIcc ? 'embedded' : 'none'],
  ];
  if (m.orientation !== undefined && m.orientation !== 1) {
    facts.push(['Orientation', `EXIF tag ${m.orientation} (will be applied to pixels)`]);
  }
  if (m.isAnimated) facts.push(['Animation', 'yes (first frame only)']);

  const dl = h('dl', { class: 'facts', 'data-testid': 'source-facts' });
  for (const [k, v] of facts) {
    dl.append(h('dt', {}, k), h('dd', { 'data-fact': k.toLowerCase().replace(/\s+/g, '-') }, v));
  }
  return h(
    'div',
    { class: 'source' },
    h('div', { class: 'thumb' }, h('img', { src: src.previewUrl, alt: '' })),
    dl,
  );
}
