import { h } from './dom';

/** One file converts on its own; several form a batch. The app decides; the zone only collects. */
export function createDropzone(onFiles: (files: File[]) => void): HTMLElement {
  // Paste from the clipboard (copied files or image data) loads them like a drop.
  document.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    if (!data) return;
    // Engines differ in which view of a pasted file they populate: read `files`, then `items`.
    let files: File[] = Array.from(data.files ?? []);
    if (!files.length) {
      for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== 'file') continue;
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      onFiles(files);
    }
  });

  const input = h('input', {
    type: 'file',
    multiple: true,
    accept: 'image/png,image/jpeg,image/webp,image/avif,image/jxl,image/tiff,.png,.jpg,.jpeg,.webp,.avif,.jxl,.tif,.tiff',
    'data-testid': 'file-input',
    onChange: () => {
      const files = Array.from(input.files ?? []);
      if (files.length) onFiles(files);
      input.value = '';
    },
  });

  const zone = h(
    'div',
    {
      class: 'dropzone',
      role: 'button',
      tabindex: '0',
      'data-testid': 'dropzone',
      'aria-label': 'Drop images here or press Enter to choose files',
      onClick: () => input.click(),
      onKeyDown: (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter' || ke.key === ' ') {
          ke.preventDefault();
          input.click();
        }
      },
      onDragEnter: (e) => {
        e.preventDefault();
        zone.classList.add('is-over');
      },
      onDragOver: (e) => {
        e.preventDefault();
        (e as DragEvent).dataTransfer!.dropEffect = 'copy';
        zone.classList.add('is-over');
      },
      onDragLeave: () => zone.classList.remove('is-over'),
      onDrop: (e) => {
        e.preventDefault();
        zone.classList.remove('is-over');
        const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
        if (files.length) onFiles(files);
      },
    },
    h('div', { class: 'big' }, 'Drop PNG, JPEG, WebP, AVIF, JPEG XL or TIFF files here'),
    h('div', {}, 'or click to choose files, or paste from the clipboard. Several files convert with the same settings into one ZIP archive.'),
    input,
  );
  return zone;
}
