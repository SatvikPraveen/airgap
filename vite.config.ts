import { defineConfig, type Plugin } from 'vite';

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
      return html.replace("connect-src 'none'", "connect-src 'self' ws: wss:");
    },
  };
}

export default defineConfig({
  base: '/airgap/',
  plugins: [devOnlyCsp()],
  build: {
    target: 'es2022',
    // Never inline assets as data: URIs; keep everything as plain same-origin files.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  worker: {
    format: 'es',
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  server: {
    port: 5173,
  },
});
