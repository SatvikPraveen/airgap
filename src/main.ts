import './style.css';
import { mountApp } from './ui/app';

const app = mountApp(document.getElementById('app') as HTMLElement);

// Installed as a web app with file handlers (manifest.webmanifest), the OS can open an
// image "with Airgap": the file arrives here, in memory, exactly like a drop.
const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (params: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
lq?.setConsumer((params) => {
  const first = params.files?.[0];
  if (first) void first.getFile().then((f) => app.loadFile(f));
});
