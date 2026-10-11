# Codecs built by Airgap

These WebAssembly modules are compiled by this repository, not taken from a
package. Each comes from a pinned Dockerfile in `tools/` and a small C
interface. Plain C functions over linear memory, no embind, means the
generated JavaScript needs no `eval` or `new Function`, which the app's
Content-Security-Policy forbids.

| Module | Sources | Build | Interface |
| --- | --- | --- | --- |
| `libjxl/airgap_jxl.{js,wasm}` | libjxl v0.12.0 with its bundled Highway, Brotli and skcms | `tools/libjxl/Dockerfile` | `tools/libjxl/airgap_jxl.cc` |
| `libavif/airgap_avif.{js,wasm}` | libavif v1.4.2, libaom v3.15.2 | `tools/libavif/Dockerfile` | `tools/libavif/airgap_avif.c` |

Toolchain: `emscripten/emsdk:5.0.7` (manifest digest `sha256:4e332f7343b6f66320bf72f7ecc01a3d9f3866721a13b0e5c7b96505d6ab148a`).
Single-threaded (no SharedArrayBuffer), `-sDYNAMIC_EXECUTION=0`, no
filesystem, memory growth on.

Rebuild:

```sh
tools/libjxl/build.sh     # writes vendor/libjxl/* and prints SHA256SUMS
tools/libavif/build.sh    # writes vendor/libavif/*
git diff --stat vendor/   # empty when the build reproduced the committed bytes
```

`SHA256SUMS` in each directory lists the committed files. The
"Reproduce codec builds" workflow rebuilds both on GitHub's runners and fails
if the bytes differ. Licences for everything compiled in are listed in
`THIRD_PARTY_NOTICES.md`.
