import { label } from '../capabilities';
import { iccKindLabel } from '../metadata/icc';
import { formatBytes, h } from './dom';
import type { LoadedSource } from './state';

export function renderSource(src: LoadedSource): HTMLElement {
  const m = src.info.metadata;
  const ex = src.info.exifSummary;
  const facts: [string, string][] = [
    ['File', `${src.file.name} (${formatBytes(src.file.size)})`],
    ['Format', `${label(src.info.format)}${m.sourceLossless === false ? ' (lossy source)' : ''}`],
    ['Size', `${src.info.width} × ${src.info.height} px`],
    ['Bit depth', m.bitDepthUncertain ? `unknown (assumed ${m.bitDepth}-bit)` : `${m.bitDepth}-bit per channel`],
    [
      'Alpha',
      !m.hasAlpha
        ? 'none'
        : !m.hasTransparency
          ? 'channel present, fully opaque'
          : m.hasSemiTransparency
            ? `yes, with semi-transparent pixels${m.alphaAssociated ? ' (stored premultiplied)' : ''}`
            : 'yes, fully transparent pixels only (no partial alpha)',
    ],
    [
      'EXIF',
      !m.hasExif
        ? 'none'
        : ex
          ? `${ex.tagCount} tags${ex.make || ex.model ? ` · ${[ex.make, ex.model].filter(Boolean).join(' ')}` : ''}${ex.dateTime ? ` · ${ex.dateTime}` : ''}${m.hasGps ? ' · includes GPS location' : ''}${ex.hasMakerNote ? ' · MakerNote' : ''}${ex.hasThumbnail ? ' · thumbnail' : ''}`
          : m.hasGps
            ? 'present, includes GPS location'
            : 'present',
    ],
    ['ICC profile', m.hasIcc ? `${m.iccDescription ? `"${m.iccDescription}" · ` : ''}${iccKindLabel(m.iccKind ?? 'unknown')}` : 'none'],
    ['XMP', m.hasXmp ? 'present' : 'none'],
    ['Decoder', `${src.info.decoder.codecId}${src.info.decoder.capabilities.exactAlpha ? ' · exact alpha' : m.hasAlpha ? ' · alpha NOT exact' : ''}`],
  ];
  if (m.orientation !== undefined && m.orientation !== 1) {
    facts.push(['Orientation', `EXIF tag ${m.orientation} (applied to pixels)`]);
  }
  if (m.isAnimated) facts.push(['Frames', 'multiple (first only)']);

  const dl = h('dl', { class: 'facts', 'data-testid': 'source-facts' });
  for (const [k, v] of facts) {
    dl.append(h('dt', {}, k), h('dd', { 'data-fact': k.toLowerCase().replace(/\s+/g, '-') }, v));
  }
  return h('div', { class: 'source' }, h('div', { class: 'thumb' }, h('img', { src: src.previewUrl, alt: '' })), dl);
}
