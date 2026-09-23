import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

/**
 * `import b64 from 'pkg/codec.wasm?b64'` -> a module exporting the file as a
 * base64 string. The page CSP has connect-src 'none', which forbids fetching
 * a .wasm file even from our own origin, so WebAssembly payloads travel
 * inside lazily imported script chunks (script-src 'self') instead.
 */
export function wasmBase64(): Plugin {
  const SUFFIX = '?b64';
  return {
    name: 'airgap-wasm-base64',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!id.endsWith(SUFFIX)) return null;
      const r = await this.resolve(id.slice(0, -SUFFIX.length), importer, { skipSelf: true });
      return r ? r.id + SUFFIX : null;
    },
    async load(id) {
      if (!id.endsWith(SUFFIX)) return null;
      const bytes = await readFile(id.slice(0, -SUFFIX.length));
      return `export default ${JSON.stringify(bytes.toString('base64'))};`;
    },
    // The codec glue also references its .wasm via `new URL(..., import.meta.url)`, which
    // makes Vite emit the raw file as an asset. It is never requested (we always hand the
    // glue a compiled module, and the CSP would block the fetch anyway), so drop it.
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) if (name.endsWith('.wasm')) delete bundle[name];
    },
  };
}
