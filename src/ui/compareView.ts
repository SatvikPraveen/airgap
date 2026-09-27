/**
 * Before/after viewer for a conversion: source, output, a heat map of every
 * pixel the verification found changed, and a wipe between source and
 * output. All drawn from in-memory blobs; nothing leaves the page.
 */
import { h } from './dom';

export interface CompareInput {
  sourceUrl: string;
  outputUrl: string;
  width: number;
  height: number;
  /** Per-pixel change magnitude, 0..255, or undefined when the output is identical. */
  diffMask?: Uint8Array | undefined;
  differingPixels: number;
}

type View = 'output' | 'source' | 'diff' | 'wipe';

/** Heat map colour for a change magnitude 1..255: yellow for small, red for large. */
function heat(v: number): [number, number, number] {
  const t = Math.min(1, Math.log2(1 + v) / 8); // log scale: a difference of 1 must still be visible
  return [255, Math.round(220 * (1 - t)), 0];
}

export function renderCompareView(c: CompareInput): HTMLElement {
  let view: View = c.diffMask ? 'diff' : 'output';
  let fit = true;
  let wipe = 50;

  const stage = h('div', { class: 'compare-stage', 'data-testid': 'compare-stage' });
  const tabs = h('div', { class: 'compare-tabs', role: 'tablist' });
  const zoomBtn = h('button', { class: 'button secondary small', type: 'button', 'data-testid': 'compare-zoom' });
  const wipeInput = h('input', { type: 'range', min: '0', max: '100', value: String(wipe), 'aria-label': 'Wipe position', 'data-testid': 'compare-wipe' });

  const options: { key: View; label: string; disabled?: boolean }[] = [
    { key: 'output', label: 'Output' },
    { key: 'source', label: 'Source' },
    { key: 'diff', label: c.diffMask ? `Changed pixels (${c.differingPixels.toLocaleString()})` : 'Changed pixels (none)', disabled: !c.diffMask },
    { key: 'wipe', label: 'Wipe' },
  ];
  const buttons = new Map<View, HTMLButtonElement>();
  for (const o of options) {
    const b = h('button', { class: 'tab', type: 'button', role: 'tab', 'data-testid': `compare-${o.key}` }, o.label);
    b.disabled = !!o.disabled;
    b.addEventListener('click', () => {
      view = o.key;
      draw();
    });
    buttons.set(o.key, b);
    tabs.append(b);
  }
  zoomBtn.addEventListener('click', () => {
    fit = !fit;
    draw();
  });
  wipeInput.addEventListener('input', () => {
    wipe = Number(wipeInput.value);
    applyWipe();
  });

  let diffCanvas: HTMLCanvasElement | undefined;
  function diffLayer(): HTMLCanvasElement {
    if (diffCanvas) return diffCanvas;
    const canvas = h('canvas', { width: c.width, height: c.height, class: 'layer', 'data-testid': 'diff-canvas' });
    const ctx = canvas.getContext('2d');
    if (ctx && c.diffMask) {
      const img = ctx.createImageData(c.width, c.height);
      const d = img.data;
      const m = c.diffMask;
      for (let i = 0; i < m.length; i++) {
        const v = m[i]!;
        if (v === 0) continue;
        const [r, g, b] = heat(v);
        d[i * 4] = r;
        d[i * 4 + 1] = g;
        d[i * 4 + 2] = b;
        d[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }
    diffCanvas = canvas;
    return canvas;
  }

  const wipeTop = h('div', { class: 'wipe-top' });
  function applyWipe(): void {
    wipeTop.style.clipPath = `inset(0 ${100 - wipe}% 0 0)`;
  }

  function img(src: string, testid: string): HTMLImageElement {
    return h('img', { src, alt: '', class: 'layer', draggable: false, 'data-testid': testid });
  }

  function draw(): void {
    for (const [k, b] of buttons) b.setAttribute('aria-selected', String(k === view));
    stage.classList.toggle('fit', fit);
    stage.classList.toggle('actual', !fit);
    stage.dataset['view'] = view;
    zoomBtn.textContent = fit ? 'View at 1:1' : 'Fit to panel';
    wipeInput.hidden = view !== 'wipe';
    while (stage.firstChild) stage.removeChild(stage.firstChild);
    const frame = h('div', { class: 'frame' });
    frame.style.aspectRatio = `${c.width} / ${c.height}`;
    frame.style.setProperty('--w', String(c.width));
    if (!fit) {
      frame.style.width = `${c.width}px`;
      frame.style.height = `${c.height}px`;
    }
    if (view === 'source') frame.append(img(c.sourceUrl, 'compare-img-source'));
    else if (view === 'output') frame.append(img(c.outputUrl, 'compare-img-output'));
    else if (view === 'diff') {
      const under = img(c.outputUrl, 'compare-img-output');
      under.classList.add('dimmed');
      frame.append(under, diffLayer());
    } else {
      wipeTop.replaceChildren(img(c.sourceUrl, 'compare-img-source'));
      frame.append(img(c.outputUrl, 'compare-img-output'), wipeTop, h('div', { class: 'wipe-label left' }, 'source'), h('div', { class: 'wipe-label right' }, 'output'));
      applyWipe();
    }
    stage.append(frame);
  }

  draw();
  return h(
    'div',
    { class: 'compare', 'data-testid': 'compare-view' },
    h('div', { class: 'compare-bar' }, tabs, zoomBtn),
    wipeInput,
    stage,
    c.diffMask
      ? h('p', { class: 'hint' }, 'Heat map: yellow marks a pixel whose largest channel difference is 1, red marks the largest differences (log scale). Drawn from the same comparison the verification reports.')
      : h('p', { class: 'hint' }, 'The verification found no pixel that differs, so there is nothing to highlight.'),
  );
}
