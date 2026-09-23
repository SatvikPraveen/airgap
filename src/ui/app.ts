/**
 * Application shell: owns state, wires the worker, re-renders panels.
 * All the "what will be lost" logic lives in src/capabilities.ts; this file
 * only presents it. Codecs are never named here: only capability fields.
 */
import { computeLosses, isPixelLossless, needsFlatten, type IccMode, type Loss, type MetadataMode, type TargetSpec } from '../capabilities';
import { EXTENSION, type CodecCapabilities, type ImageFormat } from '../codecs/types';
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
  worker.onCaps = (caps) => {
    state.caps = caps;
    render();
  };

  // ---- static skeleton ---------------------------------------------------

  const errorBox = h('div', { class: 'error', role: 'alert', 'data-testid': 'error', hidden: true });
  const dropzone = createDropzone((f) => void loadFile(f));
  const sourceHost = h('div', { 'data-testid': 'source-panel' });
  const targetSelect = h('select', { 'data-testid': 'target', 'aria-label': 'Target format' });
  const targetNote = h('div', { class: 'hint', 'data-testid': 'target-note' });
  const losslessOnly = h('input', { type: 'checkbox', 'data-testid': 'lossless-only' });
  const quality = h('input', { type: 'range', min: '1', max: '100', step: '1', 'data-testid': 'quality' });
  const qualityValue = h('span', { 'data-testid': 'quality-value' });
  const qualityField = h(
    'div',
    { class: 'field', 'data-testid': 'quality-field' },
    h('label', { for: 'quality' }, 'Quality ', qualityValue),
    quality,
    h('div', { class: 'hint' }, 'Lower is smaller and loses more. 100 is still lossy for a lossy target.'),
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
      'This target cannot store an alpha channel. The alpha channel will be lost and every transparent or semi-transparent pixel will be blended onto this colour. Nothing is composited onto black unless you choose black.',
    ),
  );
  background.id = 'background';

  const metadataField = h('fieldset', { class: 'field', 'data-testid': 'metadata-field' });
  const iccField = h('fieldset', { class: 'field', 'data-testid': 'icc-field' });
  const lossHost = h('div', { 'data-testid': 'loss-panel' });
  const convertBtn = h('button', { class: 'button', type: 'button', 'data-testid': 'convert' }, 'Convert');
  const resultHost = h('div', { 'data-testid': 'result-panel' });
  const resultSection = h('section', { class: 'panel', hidden: true }, h('h2', {}, 'Result'), resultHost);
  const status = h('span', { class: 'hint', 'data-testid': 'status', 'aria-live': 'polite' });

  for (const key of TARGET_ORDER) targetSelect.append(h('option', { value: key }, TARGETS[key].label));

  const radios = <T extends string>(
    name: string,
    options: { value: T; label: string; hint: string; testid: string }[],
    get: () => T,
    set: (v: T) => void,
  ) => {
    const host = h('div', { class: 'radios' });
    const inputs: { input: HTMLInputElement; hintEl: HTMLElement; value: T }[] = [];
    for (const o of options) {
      const input = h('input', { type: 'radio', name, value: o.value, 'data-testid': o.testid });
      input.addEventListener('change', () => {
        if (input.checked) {
          set(o.value);
          render();
        }
      });
      const hintEl = h('div', { class: 'hint' }, o.hint);
      host.append(h('label', { class: 'check' }, input, h('span', {}, h('strong', {}, o.label), hintEl)));
      inputs.push({ input, hintEl, value: o.value });
    }
    return {
      host,
      sync(disabled: Partial<Record<T, string>> = {}) {
        const current = get();
        for (const { input, hintEl, value } of inputs) {
          input.checked = value === current;
          const reason = disabled[value];
          input.disabled = !!reason;
          if (reason) hintEl.textContent = reason;
        }
      },
      reset() {
        for (const { hintEl, value } of inputs) hintEl.textContent = options.find((o) => o.value === value)!.hint;
      },
    };
  };

  const metadataRadios = radios<MetadataMode>(
    'metadata',
    [
      { value: 'strip-all', label: 'Strip all metadata', hint: 'Remove EXIF and XMP entirely (default).', testid: 'meta-strip-all' },
      { value: 'strip-gps', label: 'Strip GPS only', hint: 'Remove the GPS location; keep camera, timestamps, orientation and everything else. XMP is removed too because it can carry location.', testid: 'meta-strip-gps' },
      { value: 'preserve', label: 'Preserve all metadata', hint: 'Carry EXIF and XMP through unchanged, except the Orientation tag which is set to 1 because the pixels are stored upright.', testid: 'meta-preserve' },
    ],
    () => state.metadataMode,
    (v) => (state.metadataMode = v),
  );
  const iccRadios = radios<IccMode>(
    'icc',
    [
      { value: 'strip', label: 'Strip profile', hint: 'Keeps pixel VALUES; appearance may change because viewers will assume sRGB (default).', testid: 'icc-strip' },
      { value: 'preserve', label: 'Preserve profile', hint: 'Keeps values AND appearance, if the target format can embed a profile.', testid: 'icc-preserve' },
      { value: 'convert-srgb', label: 'Convert to sRGB', hint: 'Keeps APPEARANCE; changes pixel values. Matrix/TRC profiles only.', testid: 'icc-convert' },
    ],
    () => state.iccMode,
    (v) => (state.iccMode = v),
  );
  metadataField.append(h('legend', {}, 'EXIF / XMP metadata'), metadataRadios.host);
  iccField.append(h('legend', {}, 'ICC colour profile'), iccRadios.host);

  clear(root);
  root.append(
    h('header', { class: 'masthead' }, h('h1', {}, 'Airgap'), h('p', {}, 'Image format converter that tells you exactly what a conversion throws away.')),
    h(
      'div',
      { class: 'privacy' },
      h('strong', {}, 'Conversion happens entirely in your browser.'),
      ' Image bytes are never transmitted anywhere: this page has no server side and its ',
      h('code', {}, 'Content-Security-Policy'),
      ' forbids every outgoing connection (',
      h('code', {}, "connect-src 'none'"),
      '), for the page and for its worker. Verify it yourself in the DevTools Network tab.',
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
        h('div', { class: 'field' }, h('label', { for: 'target' }, 'Convert to'), targetSelect, targetNote),
        h(
          'label',
          { class: 'check' },
          losslessOnly,
          h(
            'span',
            {},
            h('strong', {}, 'Lossless only'),
            h('div', { class: 'hint' }, 'Disable every target whose verified codec cannot keep all visible pixel values of this source. Metadata choices are separate and listed below.'),
          ),
        ),
        qualityField,
        backgroundField,
        metadataField,
        iccField,
      ),
    ),
    h('section', { class: 'panel' }, h('h2', {}, '3. What this conversion will discard'), lossHost),
    h('section', { class: 'panel' }, h('div', { class: 'inline' }, convertBtn, status)),
    resultSection,
    h('footer', {}, 'Every codec is probed in this browser before its capabilities are believed. Every loss listed above is reported, never hidden.'),
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

  const encoderCaps = (format: ImageFormat): CodecCapabilities | undefined => state.caps[format]?.encode?.capabilities;
  const decoderCaps = (): CodecCapabilities | undefined => state.source?.info.decoder.capabilities;

  function targetSpec(key: TargetKey): TargetSpec {
    const t = TARGETS[key];
    return { format: t.format, lossless: t.lossless, metadataMode: state.metadataMode, iccMode: state.iccMode };
  }

  function targetLosses(key: TargetKey): Loss[] | null {
    const dec = decoderCaps();
    const enc = encoderCaps(TARGETS[key].format);
    if (!state.source || !dec || !enc) return null;
    return computeLosses({ format: state.source.info.format, metadata: state.source.info.metadata }, targetSpec(key), { decoder: dec, encoder: enc });
  }

  /** Why a target option is unavailable, or null. Reads probed capability fields only. */
  function targetDisabledReason(key: TargetKey): string | null {
    const t = TARGETS[key];
    const err = state.ensureErrors[t.format];
    if (err) return `unavailable: ${err}`;
    // A lossy request is lossy by definition; no probe needed to exclude it.
    if (state.losslessOnly && !t.lossless) return 'excluded by lossless-only';
    const enc = encoderCaps(t.format);
    if (!enc) return null; // not yet probed: selectable, selecting triggers the probe
    if (!enc.encode) return 'no encoder in this browser';
    if (t.lossless && !enc.lossless) return 'lossless not verified in this browser';
    if (state.losslessOnly) {
      const losses = targetLosses(key);
      if (losses ? !isPixelLossless(losses) : !t.lossless) return 'excluded by lossless-only';
    }
    return null;
  }

  function ensureEncoder(format: ImageFormat): void {
    const key = `${format}:encode`;
    if (state.caps[format]?.encode || state.ensuring.has(key) || state.ensureErrors[format]) return;
    state.ensuring.add(key);
    worker
      .ensure(format, 'encode')
      .catch((err: Error) => {
        state.ensureErrors[format] = err.message;
      })
      .finally(() => {
        state.ensuring.delete(key);
        render();
      });
  }

  // ---- render ----------------------------------------------------------------

  function render(): void {
    root.setAttribute('aria-busy', String(!state.ready || state.busy !== 'idle'));
    document.documentElement.toggleAttribute('data-ready', state.ready);

    errorBox.hidden = !state.error;
    errorBox.textContent = state.error ?? '';

    // Selecting a target loads and probes its encoder on demand.
    const current = TARGETS[state.target];
    if (state.ready) ensureEncoder(current.format);

    for (const opt of Array.from(targetSelect.options)) {
      const key = opt.value as TargetKey;
      const t = TARGETS[key];
      const reason = targetDisabledReason(key);
      const probing = state.ensuring.has(`${t.format}:encode`);
      const unverified = !encoderCaps(t.format) && !state.ensureErrors[t.format];
      opt.disabled = reason !== null;
      opt.textContent = reason ? `${t.label} — ${reason}` : probing ? `${t.label} — verifying…` : unverified ? `${t.label} — select to verify` : t.label;
    }
    if (targetDisabledReason(state.target) !== null) {
      const fallback = TARGET_ORDER.find((k) => targetDisabledReason(k) === null && encoderCaps(TARGETS[k].format));
      if (fallback) state.target = fallback;
    }
    targetSelect.value = state.target;
    losslessOnly.checked = state.losslessOnly;

    const enc = encoderCaps(current.format);
    const encResolved = state.caps[current.format]?.encode;
    targetNote.textContent = encResolved
      ? `Encoder ${encResolved.codecId}: ${encResolved.probe.detail || 'probed'}`
      : state.ensuring.has(`${current.format}:encode`)
        ? `Loading and verifying the ${current.label} encoder in this browser…`
        : (state.ensureErrors[current.format] ?? '');

    const lossyTarget = !current.lossless || (enc ? !enc.lossless : false);
    qualityField.hidden = !lossyTarget;
    quality.value = String(state.quality);
    qualityValue.textContent = String(state.quality);

    const src = state.source;
    const flatten = !!(src && enc && needsFlatten({ format: src.info.format, metadata: src.info.metadata }, enc));
    backgroundField.hidden = !flatten;
    background.value = state.background;
    backgroundHex.textContent = state.background;

    const m = src?.info.metadata;
    metadataField.hidden = !(m && (m.hasExif || m.hasXmp));
    metadataRadios.reset();
    metadataRadios.sync();
    const dec = decoderCaps();
    iccField.hidden = !(m && m.hasIcc && dec && !dec.decodeAppliesIcc);
    iccRadios.reset();
    const iccDisabled: Partial<Record<IccMode, string>> = {};
    if (m && m.hasIcc && m.iccKind !== 'matrix') {
      iccDisabled['convert-srgb'] = `Not available: this is a ${m.iccKind ?? 'unknown'} profile. Airgap converts matrix/TRC profiles only and will not approximate a LUT-based profile.`;
      if (state.iccMode === 'convert-srgb') state.iccMode = 'strip';
    }
    iccRadios.sync(iccDisabled);

    clear(sourceHost);
    if (src) sourceHost.append(renderSource(src));

    clear(lossHost);
    const losses = targetLosses(state.target);
    if (losses) lossHost.append(renderLosses(losses));
    else if (src) lossHost.append(h('p', { class: 'note' }, 'Waiting for the target encoder to be verified in this browser…'));
    else lossHost.append(h('p', { class: 'note' }, 'Load an image to see what the selected conversion would discard.'));

    const targetAvailable = targetDisabledReason(state.target) === null && !!enc;
    if (src && enc && targetDisabledReason(state.target) !== null) {
      lossHost.append(
        h('p', { class: 'note', 'data-testid': 'no-target' }, 'No verified target can convert this source without changing visible pixel values. Turn off "Lossless only" to convert anyway; the list above stays honest about what goes.'),
      );
    }
    convertBtn.disabled = !state.ready || !src || state.busy !== 'idle' || !targetAvailable;
    status.textContent = state.busy === 'loading' ? 'Decoding…' : state.busy === 'converting' ? 'Converting and verifying…' : '';

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
    const src = state.source;
    const enc = encoderCaps(TARGETS[state.target].format);
    if (!src || !enc) return;
    state.error = null;
    state.busy = 'converting';
    discardResult();
    render();
    try {
      const t = TARGETS[state.target];
      const flatten = needsFlatten({ format: src.info.format, metadata: src.info.metadata }, enc);
      const plan = {
        target: targetSpec(state.target),
        quality: state.quality / 100,
        ...(flatten ? { background: parseHexColor(state.background) } : {}),
      };
      const out = await worker.convert(src.id, plan);
      const blob = new Blob([out.bytes], { type: out.mime });
      const base = src.file.name.replace(/\.[^.]+$/, '') || 'image';
      const ext = EXTENSION[t.format];
      const filename = `${base}.${ext}` === src.file.name ? `${base}-converted.${ext}` : `${base}.${ext}`;
      state.result = {
        url: URL.createObjectURL(blob),
        size: blob.size,
        mime: out.mime,
        format: t.format,
        bitDepth: out.bitDepth,
        encoderId: out.encoderId,
        filename,
        verification: out.verification,
        target: state.target,
        pixelCount: src.info.width * src.info.height,
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
    .then((caps) => {
      state.caps = caps;
      state.ready = true;
      render();
    })
    .catch((err: Error) => {
      state.error = `Could not start the conversion worker: ${err.message}`;
      render();
    });
}
