/**
 * The "Transform" fieldset: rotate, mirror, crop and resize. Built once and
 * synced on every render (inputs keep focus while typing). Values commit on
 * `change`, so a half-typed number never triggers a conversion preview.
 * Coordinates: the crop is in the upright source's pixels (as the source
 * thumbnail shows it); the resize is the final output size.
 */
import { orientedSize, type Rotation } from '../transform';
import { h } from './dom';
import { initialTransform, type TransformState } from './state';

export interface TransformPanel {
  el: HTMLFieldSetElement;
  sync(t: TransformState, source: { width: number; height: number }, output: { width: number; height: number }, error: string | null): void;
}

/** Keeps the resize consistent with crop/rotation: off = follows the edit; locked = height from width. */
export function syncResize(t: TransformState, source: { width: number; height: number }): TransformState {
  const base = orientedSize(source.width, source.height, { rotate: t.rotate, flipH: t.flipH, flipV: t.flipV, ...(t.cropOn && { crop: t.crop }) });
  if (!t.resizeOn) return { ...t, width: base.width, height: base.height };
  if (t.lockAspect) return { ...t, height: Math.max(1, Math.round((t.width * base.height) / base.width)) };
  return t;
}

export function createTransformPanel(onChange: (next: TransformState) => void, getSource: () => { width: number; height: number } | null, getState: () => TransformState): TransformPanel {
  const commit = (next: TransformState) => {
    const src = getSource();
    if (src) onChange(syncResize(next, src));
  };
  const num = (testid: string, label: string) => {
    const input = h('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', 'data-testid': testid, 'aria-label': label });
    return input;
  };
  const check = (testid: string) => h('input', { type: 'checkbox', 'data-testid': testid });

  const rotLeft = h('button', { class: 'button secondary small', type: 'button', 'data-testid': 'rotate-left' }, 'Rotate left');
  const rotRight = h('button', { class: 'button secondary small', type: 'button', 'data-testid': 'rotate-right' }, 'Rotate right');
  const flipH = check('flip-h');
  const flipV = check('flip-v');
  const rotLabel = h('span', { class: 'hint', 'data-testid': 'rotation' });
  const cropOn = check('crop-on');
  const cx = num('crop-x', 'Crop left');
  const cy = num('crop-y', 'Crop top');
  const cw = num('crop-w', 'Crop width');
  const ch = num('crop-h', 'Crop height');
  const resizeOn = check('resize-on');
  const rw = num('resize-w', 'Output width');
  const rh = num('resize-h', 'Output height');
  const lock = check('resize-lock');
  const size = h('div', { class: 'hint', 'data-testid': 'transform-size' });
  const err = h('div', { class: 'error-inline', role: 'alert', 'data-testid': 'transform-error', hidden: true });
  const reset = h('button', { class: 'button secondary small', type: 'button', 'data-testid': 'transform-reset' }, 'Reset');

  const rotate = (delta: number) => {
    const t = getState();
    const next = (((t.rotate + delta) % 360) + 360) % 360 as Rotation;
    // A quarter turn swaps the requested output size, so a resize keeps its meaning.
    const swap = (t.rotate - next) % 180 !== 0 && t.resizeOn;
    commit({ ...t, rotate: next, ...(swap && { width: t.height, height: t.width }) });
  };
  rotLeft.addEventListener('click', () => rotate(-90));
  rotRight.addEventListener('click', () => rotate(90));
  flipH.addEventListener('change', () => commit({ ...getState(), flipH: flipH.checked }));
  flipV.addEventListener('change', () => commit({ ...getState(), flipV: flipV.checked }));
  cropOn.addEventListener('change', () => commit({ ...getState(), cropOn: cropOn.checked }));
  const int = (el: HTMLInputElement) => (el.value.trim() === '' ? NaN : Number(el.value));
  for (const [el, key] of [[cx, 'x'], [cy, 'y'], [cw, 'width'], [ch, 'height']] as const) {
    el.addEventListener('change', () => {
      const t = getState();
      commit({ ...t, cropOn: true, crop: { ...t.crop, [key]: int(el) } });
    });
  }
  resizeOn.addEventListener('change', () => commit({ ...getState(), resizeOn: resizeOn.checked }));
  rw.addEventListener('change', () => commit({ ...getState(), resizeOn: true, width: int(rw) }));
  rh.addEventListener('change', () => {
    const t = getState();
    const src = getSource();
    const height = int(rh);
    // Locked: the height drives the width instead.
    if (t.lockAspect && src) {
      const base = orientedSize(src.width, src.height, { rotate: t.rotate, flipH: t.flipH, flipV: t.flipV, ...(t.cropOn && { crop: t.crop }) });
      onChange({ ...t, resizeOn: true, height, width: Math.max(1, Math.round((height * base.width) / base.height)) });
    } else commit({ ...t, resizeOn: true, height });
  });
  lock.addEventListener('change', () => commit({ ...getState(), lockAspect: lock.checked }));
  reset.addEventListener('click', () => {
    const src = getSource();
    if (src) onChange(initialTransform(src.width, src.height));
  });

  const el = h(
    'fieldset',
    { class: 'field transform', 'data-testid': 'transform-field' },
    h('legend', {}, 'Transform'),
    h('div', { class: 'inline' }, rotLeft, rotRight, rotLabel, h('label', { class: 'check' }, flipH, h('span', {}, 'Mirror left-right')), h('label', { class: 'check' }, flipV, h('span', {}, 'Mirror top-bottom'))),
    h(
      'div',
      { class: 'inline' },
      h('label', { class: 'check' }, cropOn, h('span', {}, h('strong', {}, 'Crop'))),
      h('label', { class: 'num' }, 'left ', cx),
      h('label', { class: 'num' }, 'top ', cy),
      h('label', { class: 'num' }, 'width ', cw),
      h('label', { class: 'num' }, 'height ', ch),
    ),
    h(
      'div',
      { class: 'inline' },
      h('label', { class: 'check' }, resizeOn, h('span', {}, h('strong', {}, 'Resize'))),
      h('label', { class: 'num' }, 'width ', rw),
      h('label', { class: 'num' }, 'height ', rh),
      h('label', { class: 'check' }, lock, h('span', {}, 'keep aspect ratio')),
    ),
    h('div', { class: 'inline' }, size, reset),
    err,
    h('div', { class: 'hint' }, 'Crop is in the pixels of the upright source and is applied first, then mirroring, then rotation, then resizing. Crop, rotate and mirror keep every value exactly; resizing computes new values (Lanczos-3) and is listed as a pixel loss.'),
  );

  const setVal = (input: HTMLInputElement, v: number) => {
    if (document.activeElement !== input) input.value = Number.isFinite(v) ? String(v) : '';
  };

  return {
    el,
    sync(t, source, output, error) {
      flipH.checked = t.flipH;
      flipV.checked = t.flipV;
      rotLabel.textContent = t.rotate ? `${t.rotate}° clockwise` : 'not rotated';
      cropOn.checked = t.cropOn;
      setVal(cx, t.crop.x);
      setVal(cy, t.crop.y);
      setVal(cw, t.crop.width);
      setVal(ch, t.crop.height);
      for (const [i, max] of [[cx, source.width - 1], [cy, source.height - 1], [cw, source.width], [ch, source.height]] as const) i.max = String(max);
      resizeOn.checked = t.resizeOn;
      setVal(rw, t.width);
      setVal(rh, t.height);
      lock.checked = t.lockAspect;
      size.textContent = `Output: ${output.width} × ${output.height} px (source ${source.width} × ${source.height})`;
      err.hidden = !error;
      err.textContent = error ?? '';
    },
  };
}
