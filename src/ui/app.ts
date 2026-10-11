/**
 * Application shell: owns state, wires the worker, re-renders panels.
 * All the "what will be lost" logic lives in src/capabilities.ts; this file
 * only presents it. Codecs are never named here: only capability fields.
 */
import { aggregateLosses, outputFilename } from '../batch';
import { computeLosses, isPixelLossless, needsFlatten, type IccMode, type Loss, type MetadataMode, type TargetSpec } from '../capabilities';
import type { CodecCapabilities, ImageFormat } from '../codecs/types';
import type { SourceInfo } from '../protocol';
import { uniqueNames, writeZip, zipSize, ZIP_MAX_BYTES } from '../zip';
import { renderBatchLosses, renderBatchQueue, renderBatchResult } from './batchPanel';
import { parseHexColor } from '../flatten';
import { clear, h } from './dom';
import { createDropzone } from './dropzone';
import { renderLosses } from './lossPanel';
import { renderMetadataPanel } from './metadataPanel';
import { renderResult } from './resultPanel';
import { renderSource } from './sourcePanel';
import { initialState, TARGET_ORDER, TARGETS, type AppState, type BatchItem, type TargetKey } from './state';
import { inspect } from '../inspect';
import { previewOnDemand, sizeRefusal, sizeWarning } from '../limits';
import { createPreviewScheduler } from './preview';
import { renderPreview } from './previewPanel';
import { WorkerCancelledError, WorkerClient, type ConvertedMessage } from './workerClient';
import type { ConversionPlan } from '../convert';

/** "build abc1234" linking to the commit, plus the checksums file the deploy workflow attests. */
function buildLink(): HTMLElement {
  const full = __AIRGAP_COMMIT__;
  const sha = full.replace(/-dev$/, '');
  const short = sha.slice(0, 7) + (full.endsWith('-dev') ? ' (local build)' : '');
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return h('span', { 'data-testid': 'build-commit' }, 'build unknown');
  return h(
    'span',
    { 'data-testid': 'build-commit' },
    'build ',
    h('a', { href: `https://github.com/SatvikPraveen/airgap/commit/${sha}`, rel: 'noopener noreferrer', title: 'The commit this build was made from' }, h('code', {}, short)),
    ' · ',
    h('a', { href: 'checksums.txt', title: 'SHA-256 of every file this build ships; attested by the deploy workflow' }, 'checksums'),
  );
}

export interface AppHandle {
  /** Load a file as if it had been dropped (used by the OS file-handler launch queue). */
  loadFile(file: File): Promise<void>;
  /** Several files form a batch; one is the single-file flow. */
  loadFiles(files: File[]): Promise<void>;
}

export function mountApp(root: HTMLElement): AppHandle {
  const state: AppState = initialState();
  const worker = new WorkerClient();
  worker.onCaps = (caps) => {
    state.caps = caps;
    render();
  };
  worker.onCrash = (err) => {
    state.error = `${err.message} The worker has been restarted; the source is being reloaded.`;
    void recover();
  };

  // The preview runs the real pipeline at the current settings so its numbers are what
  // Convert will produce. Scheduling policy (debounce, one in flight, newest wins) lives
  // in preview.ts and is unit-tested there.
  const previewer = createPreviewScheduler<{ id: number; plan: ConversionPlan; quality: number }, ConvertedMessage>({
    run: (requestId, p) => worker.preview(p.id, requestId, p.plan),
    onResult(key, _requestId, out) {
      const src = state.source;
      if (!src) return;
      discardPreview();
      state.previewError = null;
      state.preview = {
        key,
        quality: previewQualityOf(key),
        url: URL.createObjectURL(new Blob([out.bytes], { type: out.mime })),
        size: out.bytes.byteLength,
        verification: out.verification,
        ...(out.diffMask && { diffMask: out.diffMask }),
        width: src.info.width,
        height: src.info.height,
        sourceUrl: src.previewUrl,
      };
      render();
    },
    onError(_key, _requestId, err) {
      if (err instanceof WorkerCancelledError) return;
      state.previewError = err.message;
      render();
    },
    onBusy(busy) {
      state.previewBusy = busy;
      render();
    },
  });

  // ---- static skeleton ---------------------------------------------------

  const errorBox = h('div', { class: 'error', role: 'alert', 'data-testid': 'error', hidden: true });
  const dropzone = createDropzone((files) => void loadFiles(files));
  const sourceHost = h('div', { 'data-testid': 'source-panel' });
  const metadataHost = h('div');
  const targetSelect = h('select', { 'data-testid': 'target', 'aria-label': 'Target format' });
  const targetNote = h('div', { class: 'hint', 'data-testid': 'target-note' });
  const losslessOnly = h('input', { type: 'checkbox', 'data-testid': 'lossless-only' });
  const quality = h('input', { type: 'range', min: '1', max: '100', step: '1', 'data-testid': 'quality' });
  const qualityValue = h('span', { 'data-testid': 'quality-value' });
  const previewHost = h('div', { class: 'preview', 'data-testid': 'preview' });
  const qualityField = h(
    'div',
    { class: 'field', 'data-testid': 'quality-field' },
    h('label', { for: 'quality' }, 'Quality ', qualityValue),
    quality,
    h('div', { class: 'hint' }, 'Lower is smaller and loses more. 100 is still lossy for a lossy target.'),
    previewHost,
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
  const cancelBtn = h('button', { class: 'button secondary', type: 'button', 'data-testid': 'cancel', hidden: true }, 'Cancel');
  const noticeBox = h('p', { class: 'note', 'data-testid': 'notice', hidden: true });
  const resultHost = h('div', { 'data-testid': 'result-panel' });
  const resultSection = h('section', { class: 'panel', hidden: true }, h('h2', {}, h('span', { class: 'step' }, '4'), 'Result'), resultHost);
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
    h(
      'header',
      { class: 'masthead' },
      h('img', { class: 'mark', src: 'favicon.svg', alt: '', width: '44', height: '44' }),
      h('div', {}, h('h1', {}, 'Airgap'), h('p', {}, 'Image format converter that tells you exactly what a conversion throws away.')),
    ),
    h(
      'div',
      { class: 'privacy' },
      h(
        'div',
        {},
        h('strong', {}, 'Conversion happens entirely in your browser.'),
        ' Image bytes are never transmitted anywhere: this page has no server side and its ',
        h('code', {}, 'Content-Security-Policy'),
        ' forbids every outgoing connection (',
        h('code', {}, "connect-src 'none'"),
        '), for the page and for its worker. Verify it yourself in the DevTools Network tab.',
      ),
      h(
        'div',
        { class: 'pills', 'aria-label': 'Privacy properties' },
        h('span', { class: 'pill ok' }, 'no upload'),
        h('span', { class: 'pill ok' }, 'no server'),
        h('span', { class: 'pill ok' }, 'no analytics'),
        h('span', { class: 'pill' }, "connect-src 'none'"),
        h('span', { class: 'pill' }, 'codecs probed before trusted'),
        h('span', { class: 'pill' }, 'output re-decoded and verified'),
      ),
    ),
    errorBox,
    h('section', { class: 'panel' }, h('h2', {}, h('span', { class: 'step' }, '1'), 'Source'), dropzone, sourceHost, noticeBox, metadataHost),
    h(
      'section',
      { class: 'panel' },
      h('h2', {}, h('span', { class: 'step' }, '2'), 'Target'),
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
    h('section', { class: 'panel' }, h('h2', {}, h('span', { class: 'step' }, '3'), 'What this conversion will discard'), lossHost),
    h('section', { class: 'panel action' }, convertBtn, cancelBtn, status),
    resultSection,
    h(
      'footer',
      {},
      h('p', {}, 'Every codec is probed in this browser before its capabilities are believed. Every loss listed above is reported, never hidden.'),
      h(
        'p',
        { class: 'footer-links' },
        h('a', { href: 'https://github.com/SatvikPraveen/airgap', rel: 'noopener noreferrer' }, 'Source on GitHub'),
        ' · ',
        h('a', { href: 'licenses.html', 'data-testid': 'licenses-link' }, 'Licences and third-party notices'),
        ' · ',
        buildLink(),
      ),
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
  convertBtn.addEventListener('click', () => void (state.batch ? runBatch() : runConversion()));
  cancelBtn.addEventListener('click', () => cancelWork());

  // ---- derived -------------------------------------------------------------

  const encoderCaps = (format: ImageFormat): CodecCapabilities | undefined => state.caps[format]?.encode?.capabilities;
  const decoderCaps = (): CodecCapabilities | undefined => state.source?.info.decoder.capabilities;
  /** Readable files of the batch (their facts are known), or an empty list outside batch mode. */
  const batchInfos = (): SourceInfo[] => (state.batch ? state.batch.items.filter((it) => it.info).map((it) => it.info!) : []);
  /** Every source whose facts drive the controls: the single source, or each readable batch file. */
  const allInfos = (): SourceInfo[] => (state.source ? [state.source.info] : batchInfos());

  function targetSpec(key: TargetKey): TargetSpec {
    const t = TARGETS[key];
    return { format: t.format, lossless: t.lossless, metadataMode: state.metadataMode, iccMode: state.iccMode };
  }

  /** The plan Convert would run right now, or null when the target is not ready. */
  function currentPlan(): ConversionPlan | null {
    const src = state.source;
    const enc = encoderCaps(TARGETS[state.target].format);
    if (!src || !enc) return null;
    return planFor(src.info, enc);
  }

  /** Identity of a preview: the source and every setting that changes the output bytes. */
  const previewKey = (id: number, plan: ConversionPlan): string => `${id}|${state.quality}|${JSON.stringify(plan)}`;
  const previewQualityOf = (key: string): number => Number(key.split('|')[1]);

  function lossesFor(info: SourceInfo, key: TargetKey): Loss[] | null {
    const enc = encoderCaps(TARGETS[key].format);
    if (!enc) return null;
    return computeLosses({ format: info.format, metadata: info.metadata }, targetSpec(key), { decoder: info.decoder.capabilities, encoder: enc });
  }

  function targetLosses(key: TargetKey): Loss[] | null {
    return state.source ? lossesFor(state.source.info, key) : null;
  }

  /** Per readable batch file, in queue order; null until the encoder is probed. */
  function batchLossLists(key: TargetKey): Loss[][] | null {
    const infos = batchInfos();
    const lists: Loss[][] = [];
    for (const info of infos) {
      const l = lossesFor(info, key);
      if (!l) return null;
      lists.push(l);
    }
    return lists;
  }

  /** The plan for one file (single or batch) under the current settings. */
  function planFor(info: SourceInfo, enc: CodecCapabilities): ConversionPlan {
    const flatten = needsFlatten({ format: info.format, metadata: info.metadata }, enc);
    return {
      target: targetSpec(state.target),
      quality: state.quality / 100,
      ...(flatten ? { background: parseHexColor(state.background) } : {}),
    };
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
      if (state.batch) {
        // One file that would lose pixels excludes the target for the whole batch: the panel says which.
        const lists = batchLossLists(key);
        if (lists ? lists.some((l) => !isPixelLossless(l)) : !t.lossless) return 'excluded by lossless-only';
      } else {
        const losses = targetLosses(key);
        if (losses ? !isPixelLossless(losses) : !t.lossless) return 'excluded by lossless-only';
      }
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
        if (err instanceof WorkerCancelledError) return; // the restart clears and re-probes on demand
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
    noticeBox.hidden = !state.notice;
    noticeBox.textContent = state.notice ?? '';

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
    renderPreviewSection(lossyTarget);

    const src = state.source;
    const infos = allInfos();
    const flatten = !!enc && infos.some((info) => needsFlatten({ format: info.format, metadata: info.metadata }, enc));
    backgroundField.hidden = !flatten;
    background.value = state.background;
    backgroundHex.textContent = state.background;

    const metas = infos.map((info) => info.metadata);
    metadataField.hidden = !metas.some((m) => m.hasExif || m.hasXmp);
    metadataRadios.reset();
    metadataRadios.sync();
    const iccSources = infos.filter((info) => info.metadata.hasIcc && !info.decoder.capabilities.decodeAppliesIcc);
    iccField.hidden = iccSources.length === 0;
    iccRadios.reset();
    const iccDisabled: Partial<Record<IccMode, string>> = {};
    const nonMatrix = iccSources.find((info) => info.metadata.iccKind !== 'matrix');
    if (nonMatrix) {
      const kind = nonMatrix.metadata.iccKind ?? 'unknown';
      const who = state.batch?.items.find((it) => it.info === nonMatrix)?.file.name;
      iccDisabled['convert-srgb'] = state.batch
        ? `Not available: ${who ?? 'a file in the batch'} has a ${kind} profile. Airgap converts matrix/TRC profiles only and will not approximate a LUT-based profile.`
        : `Not available: this is a ${kind} profile. Airgap converts matrix/TRC profiles only and will not approximate a LUT-based profile.`;
      if (state.iccMode === 'convert-srgb') state.iccMode = 'strip';
    }
    iccRadios.sync(iccDisabled);

    clear(sourceHost);
    if (src) sourceHost.append(renderSource(src));
    else if (state.batch) sourceHost.append(renderBatchQueue(state.batch, { onRemove: removeFromBatch }));
    clear(metadataHost);
    if (src) {
      const panel = renderMetadataPanel({
        info: src.info,
        mode: state.metadataMode,
        encoderCarriesExif: enc ? enc.metadata.exif : undefined,
        open: state.inspectorOpen,
        onToggle: (open) => (state.inspectorOpen = open),
      });
      if (panel) metadataHost.append(panel);
    }

    clear(lossHost);
    const batchLists = state.batch ? batchLossLists(state.target) : null;
    const losses = targetLosses(state.target);
    if (state.batch && batchLists) lossHost.append(renderBatchLosses(aggregateLosses(batchLists), batchLists.length));
    else if (losses) lossHost.append(renderLosses(losses));
    else if (src || state.batch) lossHost.append(h('p', { class: 'note' }, 'Waiting for the target encoder to be verified in this browser…'));
    else lossHost.append(h('p', { class: 'note' }, 'Load an image to see what the selected conversion would discard.'));

    const targetAvailable = targetDisabledReason(state.target) === null && !!enc;
    if (infos.length && enc && targetDisabledReason(state.target) !== null) {
      lossHost.append(
        h('p', { class: 'note', 'data-testid': 'no-target' }, state.batch ? 'No verified target can convert every file in this batch without changing visible pixel values. Turn off "Lossless only" to convert anyway; the list above stays honest about what goes, and for how many files.' : 'No verified target can convert this source without changing visible pixel values. Turn off "Lossless only" to convert anyway; the list above stays honest about what goes.'),
      );
    }
    const readable = batchInfos().length;
    convertBtn.textContent = state.batch ? `Convert ${readable} file${readable === 1 ? '' : 's'}` : 'Convert';
    convertBtn.disabled = !state.ready || (!src && readable === 0) || state.busy !== 'idle' || !targetAvailable;
    cancelBtn.hidden = state.busy === 'idle';
    status.textContent =
      state.busy === 'loading'
        ? state.batch
          ? 'Reading each file…'
          : 'Decoding…'
        : state.busy === 'converting'
          ? state.batch
            ? `Converting and verifying file ${state.batch.items.filter((it) => it.status === 'done' || it.status === 'converting').length} of ${readable}…`
            : 'Converting and verifying…'
          : state.ready
            ? ''
            : 'Starting the conversion worker…';

    clear(resultHost);
    const batchDone = !!state.batch && state.batch.items.some((it) => it.output);
    resultSection.hidden = !state.result && !batchDone;
    if (state.result) resultHost.append(renderResult(state.result));
    else if (state.batch && batchDone) resultHost.append(renderBatchResult(state.batch));
  }

  /**
   * Decides whether a preview should exist for the current plan and asks the scheduler
   * for it; the scheduler ignores repeats, so calling this on every render is cheap.
   */
  function renderPreviewSection(lossyTarget: boolean): void {
    const src = state.source;
    const plan = lossyTarget && targetDisabledReason(state.target) === null ? currentPlan() : null;
    if (!src || !plan) {
      previewer.reset();
      discardPreview();
      state.previewError = null;
      clear(previewHost);
      return;
    }
    const key = previewKey(src.id, plan);
    const onDemand = previewOnDemand(src.info.width, src.info.height);
    const wanted = !onDemand || state.previewArmedKey === key;
    if (wanted && state.ready && state.busy === 'idle') previewer.request(key, { id: src.id, plan, quality: state.quality });
    clear(previewHost);
    previewHost.append(
      renderPreview({
        quality: state.quality,
        pixelCount: src.info.width * src.info.height,
        preview: state.preview,
        fresh: state.preview?.key === key,
        busy: state.previewBusy,
        error: state.previewError,
        onDemand: onDemand && !wanted,
        compareOpen: state.previewCompareOpen,
        onRun: () => {
          state.previewArmedKey = key;
          render();
        },
        onToggleCompare: (open) => {
          state.previewCompareOpen = open;
          render();
        },
      }),
    );
  }

  function discardPreview(): void {
    if (state.preview) URL.revokeObjectURL(state.preview.url);
    state.preview = null;
  }

  // ---- actions -------------------------------------------------------------------

  function discardResult(): void {
    if (state.result) URL.revokeObjectURL(state.result.url);
    state.result = null;
  }

  async function loadFiles(files: File[]): Promise<void> {
    if (files.length === 1) {
      discardBatch();
      await loadFile(files[0]!);
    } else if (files.length > 1) await startBatch(files);
  }

  function discardBatchOutputs(): void {
    const b = state.batch;
    if (!b) return;
    for (const it of b.items) {
      if (it.output) URL.revokeObjectURL(it.output.url);
      delete it.output;
    }
    if (b.zip) URL.revokeObjectURL(b.zip.url);
    b.zip = null;
    b.zipError = null;
  }

  function discardBatch(): void {
    discardBatchOutputs();
    state.batch = null;
  }

  function discardSource(): void {
    if (state.source) {
      worker.unload(state.source.id);
      URL.revokeObjectURL(state.source.previewUrl);
      state.source = null;
    }
  }

  /** Reads every file once (header guard, then a decode in the worker for the facts) and releases it. */
  async function startBatch(files: File[]): Promise<void> {
    state.error = null;
    state.notice = null;
    state.busy = 'loading';
    discardResult();
    previewer.reset();
    discardPreview();
    state.previewError = null;
    discardSource();
    discardBatch();
    const items: BatchItem[] = files.map((file) => ({ file, status: 'waiting' }));
    state.batch = { items, running: false, zip: null, zipError: null };
    render();
    try {
      for (const it of items) {
        if (state.batch?.items !== items) return; // a new drop replaced this batch
        it.status = 'reading';
        render();
        try {
          const bytes = await it.file.arrayBuffer();
          let header: ReturnType<typeof inspect> | null = null;
          try {
            header = inspect(new Uint8Array(bytes));
          } catch {
            header = null;
          }
          if (header) {
            const refusal = sizeRefusal(header.width, header.height);
            if (refusal) throw new Error(refusal);
          }
          const { id, info } = await worker.load(bytes);
          worker.unload(id);
          it.info = info;
          it.status = 'ready';
        } catch (err) {
          if (err instanceof WorkerCancelledError) throw err;
          it.status = 'error';
          it.error = (err as Error).message;
        }
        render();
      }
    } catch (err) {
      if (!(err instanceof WorkerCancelledError)) state.error = (err as Error).message;
    } finally {
      if (state.batch?.items === items) {
        for (const it of items) if (it.status === 'waiting' || it.status === 'reading') it.status = 'cancelled';
        state.busy = 'idle';
        render();
      }
    }
  }

  function removeFromBatch(index: number): void {
    const b = state.batch;
    if (!b || b.running) return;
    const [it] = b.items.splice(index, 1);
    if (it?.output) URL.revokeObjectURL(it.output.url);
    if (b.zip) {
      URL.revokeObjectURL(b.zip.url);
      b.zip = null;
    }
    if (b.items.length === 1 && b.items[0]!.file) {
      // A batch of one is just a file: back to the single-file flow with its inspector and preview.
      const file = b.items[0]!.file;
      discardBatch();
      void loadFile(file);
      return;
    }
    if (b.items.length === 0) discardBatch();
    render();
  }

  /** Converts every readable file in order; completed outputs survive a cancel. */
  async function runBatch(): Promise<void> {
    const b = state.batch;
    const t = TARGETS[state.target];
    const enc = encoderCaps(t.format);
    if (!b || !enc) return;
    state.error = null;
    state.busy = 'converting';
    b.running = true;
    discardBatchOutputs();
    render();
    try {
      for (const it of b.items) {
        if (!it.info) continue;
        it.status = 'converting';
        render();
        try {
          const bytes = await it.file.arrayBuffer();
          const { id, info } = await worker.load(bytes);
          try {
            const out = await worker.convert(id, planFor(info, enc));
            const outBytes = new Uint8Array(out.bytes);
            it.output = {
              bytes: outBytes,
              url: URL.createObjectURL(new Blob([outBytes], { type: out.mime })),
              filename: outputFilename(it.file.name, t.format),
              size: outBytes.byteLength,
              format: t.format,
              bitDepth: out.bitDepth,
              encoderId: out.encoderId,
              verification: out.verification,
            };
            it.status = 'done';
          } finally {
            worker.unload(id);
          }
        } catch (err) {
          if (err instanceof WorkerCancelledError) {
            it.status = 'cancelled';
            throw err;
          }
          it.status = 'error';
          it.error = (err as Error).message;
        }
        render();
      }
    } catch (err) {
      if (!(err instanceof WorkerCancelledError)) state.error = (err as Error).message;
    } finally {
      b.running = false;
      buildZip(b);
      state.busy = 'idle';
      render();
    }
  }

  /** One stored ZIP of every output, with collision-free names. */
  function buildZip(b: typeof state.batch & object): void {
    const done = b.items.filter((it) => it.output);
    if (done.length === 0) return;
    const names = uniqueNames(done.map((it) => it.output!.filename));
    const entries = done.map((it, i) => ({ name: names[i]!, data: it.output!.bytes, mtime: new Date(it.file.lastModified || Date.now()) }));
    const size = zipSize(entries);
    if (size > ZIP_MAX_BYTES) {
      b.zipError = `The outputs total ${(size / 1024 ** 3).toFixed(2)} GB; a ZIP archive without ZIP64 is limited to 4 GB. Download the files individually from the table.`;
      return;
    }
    const zip = writeZip(entries);
    const stamp = new Date().toISOString().slice(0, 10);
    b.zip = { url: URL.createObjectURL(new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' })), filename: `airgap-${t(state.target)}-${stamp}.zip`, size: zip.byteLength, entries: entries.length };
  }
  const t = (key: TargetKey): string => TARGETS[key].format;

  async function loadFile(file: File): Promise<void> {
    state.error = null;
    state.notice = null;
    state.busy = 'loading';
    discardResult();
    previewer.reset();
    discardPreview();
    state.previewError = null;
    state.previewArmedKey = null;
    render();
    try {
      const bytes = await file.arrayBuffer();
      // Memory guard, from the header alone, before any pixels are decoded. If the
      // header cannot be read the worker reports the real error.
      let header: ReturnType<typeof inspect> | null = null;
      try {
        header = inspect(new Uint8Array(bytes));
      } catch {
        header = null;
      }
      if (header) {
        const refusal = sizeRefusal(header.width, header.height);
        if (refusal) throw new Error(refusal);
        state.notice = sizeWarning(header.width, header.height, header.metadata.bitDepth);
      }
      const { id, info } = await worker.load(bytes);
      discardSource();
      state.source = { id, file, info, previewUrl: URL.createObjectURL(file) };
    } catch (err) {
      if (!(err instanceof WorkerCancelledError)) state.error = (err as Error).message;
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
      const plan = currentPlan();
      if (!plan) throw new Error('The target encoder is not ready.');
      const out = await worker.convert(src.id, plan);
      const blob = new Blob([out.bytes], { type: out.mime });
      const filename = outputFilename(src.file.name, t.format);
      state.result = {
        url: URL.createObjectURL(blob),
        size: blob.size,
        mime: out.mime,
        format: t.format,
        bitDepth: out.bitDepth,
        encoderId: out.encoderId,
        ...(out.colorLayout && { colorLayout: out.colorLayout }),
        filename,
        verification: out.verification,
        target: state.target,
        pixelCount: src.info.width * src.info.height,
        width: src.info.width,
        height: src.info.height,
        ...(out.diffMask && { diffMask: out.diffMask }),
        sourceUrl: src.previewUrl,
      };
    } catch (err) {
      if (!(err instanceof WorkerCancelledError)) state.error = (err as Error).message;
    } finally {
      state.busy = 'idle';
      render();
    }
  }

  /** Cancel = terminate the worker (wasm cannot be interrupted) and recover. */
  function cancelWork(): void {
    if (state.busy === 'idle') return;
    worker.restart('Cancelled.');
    void recover();
  }

  /**
   * After a restart the new worker knows nothing: probed codecs, the loaded
   * image, everything is gone. Re-initialise, then reload the current source
   * so the user keeps their place.
   */
  async function recover(): Promise<void> {
    previewer.reset();
    state.caps = {};
    state.ensuring.clear();
    state.ensureErrors = {};
    state.ready = false;
    state.busy = 'idle';
    render();
    try {
      state.caps = await worker.init();
      state.ready = true;
    } catch (err) {
      state.error = `Could not restart the conversion worker: ${(err as Error).message}`;
      render();
      return;
    }
    render();
    const src = state.source;
    if (src) await loadFile(src.file);
    // A batch keeps its facts and finished outputs; nothing needs reloading.
    if (state.batch) {
      state.batch.running = false;
      buildZip(state.batch);
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

  return { loadFile, loadFiles };
}
