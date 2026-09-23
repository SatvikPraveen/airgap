/**
 * Application shell: owns state, wires the worker, re-renders panels.
 * All the "what will be lost" logic lives in src/capabilities.ts; this file
 * only presents it.
 */
import { computeLosses, isPixelLossless, needsFlatten, type Loss } from '../capabilities';
import { EXTENSION } from '../codecs/types';
import { parseHexColor } from '../flatten';
import { clear, h } from './dom';
import { createDropzone } from './dropzone';
import { renderLosses } from './lossPanel';
import { renderResult } from './resultPanel';
import { renderSource } from './sourcePanel';
import { initialState, TARGET_ORDER, TARGETS, type AppState, type TargetKey } from './state';
import { WorkerClient } from './workerClient';

export function mountApp(root: HTMLElement): void {
  const state: AppState = initialState();
  const worker = new WorkerClient();

  // ---- static skeleton ---------------------------------------------------

  const errorBox = h('div', { class: 'error', role: 'alert', 'data-testid': 'error', hidden: true });
  const dropzone = createDropzone((f) => void loadFile(f));
  const sourceHost = h('div', { 'data-testid': 'source-panel' });
  const targetSelect = h('select', { 'data-testid': 'target', 'aria-label': 'Target format' });
  const losslessOnly = h('input', { type: 'checkbox', 'data-testid': 'lossless-only' });
  const quality = h('input', { type: 'range', min: '1', max: '100', step: '1', 'data-testid': 'quality' });
  const qualityValue = h('span', { 'data-testid': 'quality-value' });
  const qualityField = h(
    'div',
    { class: 'field', 'data-testid': 'quality-field' },
    h('label', { for: 'quality' }, 'Quality ', qualityValue),
    quality,
    h('div', { class: 'hint' }, 'Lower is smaller and loses more. 100 is still lossy for JPEG and lossy WebP.'),
  );
  quality.id = 'quality';
  const background = h('input', { type: 'color', 'data-testid': 'background' });
  const backgroundHex = h('code', { 'data-testid': 'background-hex' });
  const backgroundField = h(
    'div',
    { class: 'field', 'data-testid': 'background-field' },
    h('label', { for: 'background' }, 'Flatten transparency onto'),
    h('div', { class: 'inline' }, background, backgroundHex),
    h(
      'div',
      { class: 'hint' },
      'JPEG cannot store an alpha channel. The alpha channel will be lost and every transparent or semi-transparent pixel will be blended onto this colour. Nothing is composited onto black unless you choose black.',
    ),
  );
  background.id = 'background';
  const webpNote = h('div', { class: 'hint', 'data-testid': 'webp-note' });
  const lossHost = h('div', { 'data-testid': 'loss-panel' });
  const convertBtn = h('button', { class: 'button', type: 'button', 'data-testid': 'convert' }, 'Convert');
  const resultHost = h('div', { 'data-testid': 'result-panel' });
  const resultSection = h('section', { class: 'panel', hidden: true }, h('h2', {}, 'Result'), resultHost);
  const status = h('span', { class: 'hint', 'data-testid': 'status', 'aria-live': 'polite' });

  for (const key of TARGET_ORDER) {
    targetSelect.append(h('option', { value: key }, TARGETS[key].label));
  }

  clear(root);
  root.append(
    h(
      'header',
      { class: 'masthead' },
      h('h1', {}, 'Airgap'),
      h('p', {}, 'Image format converter that tells you exactly what a conversion throws away.'),
    ),
    h(
      'div',
      { class: 'privacy' },
      h('strong', {}, 'Conversion happens entirely in your browser.'),
      ' Image bytes are never transmitted anywhere: this page has no server side and its ',
      h('code', {}, 'Content-Security-Policy'),
      ' forbids every outgoing connection (',
      h('code', {}, "connect-src 'none'"),
      '). Verify it yourself in the DevTools Network tab.',
    ),
    errorBox,
    h('section', { class: 'panel' }, h('h2', {}, '1. Source'), dropzone, sourceHost),
    h(
      'section',
      { class: 'panel' },
      h('h2', {}, '2. Target'),
      h(
        'div',
        { class: 'controls' },
        h('div', { class: 'field' }, h('label', { for: 'target' }, 'Convert to'), targetSelect, webpNote),
        h(
          'label',
          { class: 'check' },
          losslessOnly,
          h(
            'span',
            {},
            h('strong', {}, 'Lossless only'),
            h(
              'div',
              { class: 'hint' },
              'Disable every target that cannot keep all visible pixel values of this source. (EXIF and ICC are dropped by every conversion in this version; see the list below.)',
            ),
          ),
        ),
        qualityField,
        backgroundField,
      ),
    ),
    h('section', { class: 'panel' }, h('h2', {}, '3. What this conversion will discard'), lossHost),
    h('section', { class: 'panel' }, h('div', { class: 'inline' }, convertBtn, status)),
    resultSection,
    h(
      'footer',
      {},
      'Phase 1: PNG, JPEG and WebP through the browser canvas encoder. Every loss listed above is a property of that encoder and is reported, never hidden.',
    ),
  );
  targetSelect.id = 'target';

  // ---- events --------------------------------------------------------------

  targetSelect.addEventListener('change', () => {
    state.target = targetSelect.value as TargetKey;
    render();
  });
  losslessOnly.addEventListener('change', () => {
    state.losslessOnly = losslessOnly.checked;
    render();
  });
  quality.addEventListener('input', () => {
    state.quality = Number(quality.value);
    render();
  });
  background.addEventListener('input', () => {
    state.background = background.value;
    render();
  });
  convertBtn.addEventListener('click', () => void runConversion());

  // ---- derived -------------------------------------------------------------

  function targetLosses(key: TargetKey): Loss[] | null {
    if (!state.source || !state.caps) return null;
    const t = TARGETS[key];
    return computeLosses(
      { format: state.source.info.format, metadata: state.source.info.metadata },
      { format: t.format, lossless: t.lossless },
      state.caps[t.format],
    );
  }

  /** A target is unavailable when the encoder cannot do it or lossless-only excludes it. */
  function targetDisabledReason(key: TargetKey): string | null {
    const t = TARGETS[key];
    if (!state.caps) return 'starting';
    if (t.format === 'webp' && t.lossless && !state.caps.webp.lossless) {
      return 'not available in this browser';
    }
    if (state.losslessOnly) {
      const losses = targetLosses(key);
      if (losses ? !isPixelLossless(losses) : !t.lossless) return 'excluded by lossless-only';
    }
    return null;
  }

  // ---- render ----------------------------------------------------------------

  function render(): void {
    root.setAttribute('aria-busy', String(!state.ready || state.busy !== 'idle'));
    document.documentElement.toggleAttribute('data-ready', state.ready);

    errorBox.hidden = !state.error;
    errorBox.textContent = state.error ?? '';

    // Target options.
    for (const opt of Array.from(targetSelect.options)) {
      const key = opt.value as TargetKey;
      const reason = targetDisabledReason(key);
      opt.disabled = reason !== null;
      opt.textContent = reason ? `${TARGETS[key].label} — ${reason}` : TARGETS[key].label;
    }
    if (targetDisabledReason(state.target) !== null) {
      const fallback = TARGET_ORDER.find((k) => targetDisabledReason(k) === null);
      if (fallback) state.target = fallback;
    }
    targetSelect.value = state.target;
    losslessOnly.checked = state.losslessOnly;

    webpNote.textContent = state.probe
      ? `WebP lossless: ${state.probe.detail}`
      : 'Checking whether this browser can encode lossless WebP…';

    const t = TARGETS[state.target];
    const caps = state.caps?.[t.format];
    const lossyTarget = !t.lossless || (caps ? !caps.lossless : false);
    qualityField.hidden = !lossyTarget;
    quality.value = String(state.quality);
    qualityValue.textContent = String(state.quality);

    const flatten = !!(state.source && caps && needsFlatten({ format: state.source.info.format, metadata: state.source.info.metadata }, caps));
    backgroundField.hidden = !flatten;
    background.value = state.background;
    backgroundHex.textContent = state.background;

    clear(sourceHost);
    if (state.source) sourceHost.append(renderSource(state.source));

    clear(lossHost);
    const losses = targetLosses(state.target);
    if (losses) {
      lossHost.append(renderLosses(losses));
      const o = state.source?.info.metadata.orientation;
      if (o !== undefined && o !== 1) {
        lossHost.append(
          h('p', { class: 'note' }, `Note: the EXIF orientation tag (${o}) is applied to the pixels so the output looks the same without the tag.`),
        );
      }
    } else {
      lossHost.append(h('p', { class: 'note' }, 'Load an image to see what the selected conversion would discard.'));
    }

    const targetAvailable = targetDisabledReason(state.target) === null;
    if (!targetAvailable && state.source) {
      lossHost.append(
        h(
          'p',
          { class: 'note', 'data-testid': 'no-target' },
          'No target can convert this source without changing visible pixel values in this version. Turn off "Lossless only" to convert anyway; the list above stays honest about what goes.',
        ),
      );
    }
    convertBtn.disabled = !state.ready || !state.source || state.busy !== 'idle' || !targetAvailable;
    status.textContent =
      state.busy === 'loading' ? 'Decoding…' : state.busy === 'converting' ? 'Converting and verifying…' : '';

    clear(resultHost);
    resultSection.hidden = !state.result;
    if (state.result) resultHost.append(renderResult(state.result));
  }

  // ---- actions -------------------------------------------------------------------

  function discardResult(): void {
    if (state.result) URL.revokeObjectURL(state.result.url);
    state.result = null;
  }

  async function loadFile(file: File): Promise<void> {
    state.error = null;
    state.busy = 'loading';
    discardResult();
    render();
    try {
      const bytes = await file.arrayBuffer();
      const { id, info } = await worker.load(bytes);
      if (state.source) {
        worker.unload(state.source.id);
        URL.revokeObjectURL(state.source.previewUrl);
      }
      state.source = { id, file, info, previewUrl: URL.createObjectURL(file) };
    } catch (err) {
      state.error = (err as Error).message;
    } finally {
      state.busy = 'idle';
      render();
    }
  }

  async function runConversion(): Promise<void> {
    if (!state.source || !state.caps) return;
    state.error = null;
    state.busy = 'converting';
    discardResult();
    render();
    try {
      const t = TARGETS[state.target];
      const caps = state.caps[t.format];
      const flatten = needsFlatten({ format: state.source.info.format, metadata: state.source.info.metadata }, caps);
      const plan = {
        target: { format: t.format, lossless: t.lossless },
        quality: state.quality / 100,
        ...(flatten ? { background: parseHexColor(state.background) } : {}),
      };
      const out = await worker.convert(state.source.id, plan);
      const blob = new Blob([out.bytes], { type: out.mime });
      const base = state.source.file.name.replace(/\.[^.]+$/, '') || 'image';
      const ext = EXTENSION[t.format];
      const filename = `${base}.${ext}` === state.source.file.name ? `${base}-converted.${ext}` : `${base}.${ext}`;
      state.result = {
        url: URL.createObjectURL(blob),
        size: blob.size,
        mime: out.mime,
        format: t.format,
        filename,
        verification: out.verification,
        target: state.target,
        pixelCount: state.source.info.width * state.source.info.height,
      };
    } catch (err) {
      state.error = (err as Error).message;
    } finally {
      state.busy = 'idle';
      render();
    }
  }

  // ---- boot ----------------------------------------------------------------------

  render();
  worker
    .init()
    .then((ready) => {
      state.caps = ready.caps;
      state.probe = ready.webpLosslessProbe;
      state.ready = true;
      render();
    })
    .catch((err: Error) => {
      state.error = `Could not start the conversion worker: ${err.message}`;
      render();
    });
}
