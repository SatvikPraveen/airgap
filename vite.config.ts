import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import { licensesPage, wasmBase64 } from './vite-plugins';

/**
 * The committed index.html carries the strict production CSP
 * (connect-src 'none', etc.). Vite's dev server needs a WebSocket for
 * hot-module reload, which that CSP forbids. This plugin relaxes ONLY the
 * connect-src directive, ONLY in `vite dev`. `vite build` and `vite preview`
 * (which the e2e suite runs against) serve the strict CSP unchanged.
 */
function devOnlyCsp(): Plugin {
  return {
    name: 'airgap-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      // Only touch the <meta> tag's content attribute, not the explanatory comment above it.
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/,
        (_m, open: string, policy: string, close: string) =>
          open +
          policy
            .replace("connect-src 'none'", "connect-src 'self' ws: wss:")
            // Vite dev injects styles from JS; the production build ships a real stylesheet.
            .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
            // Vite dev may start workers from their dev-server URL rather than a blob.
            .replace('worker-src blob:', "worker-src blob: 'self'") +
          close,
      );
    },
  };
}

/** Commit the build came from: CI passes it in; locally it is read from git. Shown in the footer. */
function buildCommit(): string {
  const fromEnv = process.env['AIRGAP_COMMIT'];
  if (fromEnv) return fromEnv;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() + '-dev';
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  base: '/airgap/',
  define: {
    __AIRGAP_COMMIT__: JSON.stringify(buildCommit()),
  },
  plugins: [devOnlyCsp(), wasmBase64(), licensesPage()],
  build: {
    target: 'es2022',
    // Never inline assets as data: URIs; keep everything as plain same-origin files.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  worker: {
    format: 'es',
    plugins: () => [wasmBase64()],
  },
  optimizeDeps: {
    // Upstream jSquash guidance: keep the wasm packages out of the dev pre-bundler.
    exclude: ['@jsquash/png', '@jsquash/jpeg', '@jsquash/webp', '@jsquash/avif', '@jsquash/jxl'],
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  server: {
    port: 5173,
  },
});
