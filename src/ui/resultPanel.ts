import { label } from '../capabilities';
import type { MetadataOutcome } from '../convert';
import { renderCompareView } from './compareView';
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
  const baseline = v.comparedAgainstFlattened
    ? 'the flattened image'
    : v.comparedAgainstConverted
      ? 'the sRGB-converted image'
      : v.comparedAgainstTransformed
        ? 'the source after your crop, rotation or resize'
        : 'the source';
  let cls: string;
  let text: string;
  if (v.reconstruction) {
    const rc = v.reconstruction;
    cls = rc.identical ? 'identical' : 'differs';
    const saved = 1 - r.size / rc.jpegBytes;
    text = rc.identical
      ? `Reversible: the JPEG rebuilt from this JPEG XL file is byte-identical to the JPEG Airgap prepared (${rc.jpegBytes.toLocaleString()} bytes, with your metadata choices applied). The JPEG XL is ${(100 * saved).toFixed(1)}% ${saved >= 0 ? 'smaller' : 'larger'}. Decoded pixels ${v.identical ? 'also match the source decode exactly' : `differ from Airgap's own JPEG decode by up to ${v.maxChannelDiff} (JPEG decoders may differ in IDCT and chroma upsampling; the coefficients are identical)`}.`
      : 'Measured: the JPEG rebuilt from this file is NOT identical to the prepared JPEG. Do not rely on this file being reversible.';
  } else if (v.animation) {
    const a = v.animation;
    const timing = `${a.timingKept ? 'every frame delay kept' : 'frame delays CHANGED'}, ${a.loopsKept ? 'loop count kept' : 'loop count CHANGED'}`;
    if (v.identical && a.timingKept && a.loopsKept) {
      cls = 'identical';
      text = `Verified: the output was decoded again (${v.verifierId}) and all ${a.frames} frames, composited as a viewer shows them, match ${baseline} exactly at ${v.bitDepth}-bit; ${timing}.`;
    } else {
      cls = 'differs';
      text = `Measured: ${a.frames - a.framesIdentical} of ${a.frames} frames differ from ${baseline} (max per-channel difference ${v.maxChannelDiff} at ${v.bitDepth}-bit); ${timing}.`;
    }
  } else if (v.identical) {
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

  const compare = renderCompareView({
    sourceUrl: r.sourceUrl,
    outputUrl: r.url,
    width: r.width,
    height: r.height,
    diffMask: r.diffMask,
    differingPixels: v.differingPixels,
    sourceComparable: !r.geometryChanged,
  });

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
        ...(r.optimization
          ? [
              h('dt', {}, 'Optimised'),
              h(
                'dd',
                { 'data-testid': 'result-optimization', 'data-used': String(r.optimization.used) },
                r.optimization.used
                  ? `${r.optimization.tool}: ${formatBytes(r.optimization.before)} → ${formatBytes(r.optimization.after)} (−${(100 * (1 - r.optimization.after / r.optimization.before)).toFixed(1)}%), decoded again and identical`
                  : `${r.optimization.tool} output not used: ${r.optimization.reason}. The writer's ${formatBytes(r.optimization.before)} file is kept.`,
              ),
            ]
          : []),
        h('dt', {}, 'Size'),
        h('dd', { 'data-testid': 'result-size' }, `${r.width} × ${r.height} px`),
        ...(r.colorLayout ? [h('dt', {}, 'Stored as'), h('dd', { 'data-testid': 'result-layout' }, r.colorLayout)] : []),
        h('dt', {}, 'File'),
        h('dd', {}, r.filename),
      ),
      h('div', { class: `verification ${cls}`, 'data-testid': 'verification', 'data-identical': String(v.identical) }, text),
      meta,
      h('p', {}, h('a', { class: 'button', href: r.url, download: r.filename, 'data-testid': 'download' }, 'Download')),
    ),
    compare,
  );
}
