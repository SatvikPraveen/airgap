import { h } from './dom';

export function createDropzone(onFile: (file: File) => void): HTMLElement {
  // Paste from the clipboard (a copied file or image data) loads it like a drop.
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f) {
        e.preventDefault();
        onFile(f);
        return;
      }
    }
  });

  const input = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp,image/avif,image/jxl,image/tiff,.png,.jpg,.jpeg,.webp,.avif,.jxl,.tif,.tiff',
    'data-testid': 'file-input',
    onChange: () => {
      const f = input.files?.[0];
      if (f) onFile(f);
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
      'aria-label': 'Drop an image here or press Enter to choose a file',
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
        const f = (e as DragEvent).dataTransfer?.files?.[0];
        if (f) onFile(f);
      },
    },
    h('div', { class: 'big' }, 'Drop a PNG, JPEG, WebP, AVIF, JPEG XL or TIFF here'),
    h('div', {}, 'or click to choose a file, or paste an image from the clipboard. One file at a time in this version.'),
    input,
  );
  return zone;
}
