/// <reference types="vite/client" />

declare module '*.wasm?b64' {
  const base64: string;
  export default base64;
}

/** Full commit hash the build came from ("-dev" suffix for local builds). Injected by vite.config.ts. */
declare const __AIRGAP_COMMIT__: string;
