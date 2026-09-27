# Third-party notices

Airgap is released under the MIT licence (see `LICENSE`). The image codecs it
bundles into its own script chunks are separate works with their own licences.
This file lists every one of them, what it does inside Airgap, and where the
verbatim licence text lives. The same information is published with the app at
`licenses.html`, generated from this file at build time.

**This software is based in part on the work of the Independent JPEG Group.**

Airgap ships no binary that phones home, and every component below runs
entirely inside the user's browser. None of the projects listed here endorse
Airgap; their names appear only to give credit and to satisfy their licence
terms.

## Codec wrappers

| Component | Used for | Licence | Text |
| --- | --- | --- | --- |
| [jSquash](https://github.com/jamsinclair/jSquash) `@jsquash/png`, `@jsquash/jpeg`, `@jsquash/webp`, `@jsquash/avif`, `@jsquash/jxl` by Jamie Sinclair, derived from [Squoosh](https://github.com/GoogleChromeLabs/squoosh) by Google LLC | packaging of the wasm codecs below and their loaders | Apache-2.0 | `licenses/Apache-2.0.txt` |
| [Emscripten](https://emscripten.org/) runtime | JavaScript glue generated for the C/C++ codecs | MIT | `licenses/emscripten.txt` |
| [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) runtime | JavaScript glue generated for the Rust PNG codec | MIT or Apache-2.0 | `licenses/png-crate-and-wasm-bindgen.txt` |

## Codecs compiled to WebAssembly

| Component | Used for | Licence | Text |
| --- | --- | --- | --- |
| [mozjpeg](https://github.com/mozilla/mozjpeg) (a fork of libjpeg-turbo, which incorporates the Independent JPEG Group's libjpeg) | JPEG decode and encode | IJG licence, Modified BSD, zlib | `licenses/libjpeg-turbo.txt`, `licenses/mozjpeg.txt` |
| [libwebp](https://chromium.googlesource.com/webm/libwebp) by Google Inc. | WebP decode and encode | BSD-3-Clause | `licenses/libwebp.txt` |
| [libavif](https://github.com/AOMediaCodec/libavif) by Joe Drago and the AOMedia contributors | AVIF container decode and encode | BSD-2-Clause | `licenses/libavif-and-libaom.txt` |
| [libaom](https://aomedia.googlesource.com/aom/) by the Alliance for Open Media | AV1 decode and encode inside AVIF | BSD-2-Clause and the Alliance for Open Media Patent License 1.0 | `licenses/libavif-and-libaom.txt` |
| [libjxl](https://github.com/libjxl/libjxl) by the JPEG XL Project Authors | JPEG XL decode and encode | BSD-3-Clause | `licenses/libjxl-and-deps.txt` |
| [skcms](https://skia.googlesource.com/skcms/) by Google Inc. | colour management inside libjxl | BSD-3-Clause | `licenses/libjxl-and-deps.txt` |
| [Highway](https://github.com/google/highway) by Google LLC | SIMD abstraction inside libjxl | Apache-2.0 | `licenses/libjxl-and-deps.txt`, `licenses/Apache-2.0.txt` |
| [Brotli](https://github.com/google/brotli) by the Brotli Authors | entropy coding inside libjxl | MIT | `licenses/libjxl-and-deps.txt` |
| Rust [`png`](https://github.com/image-rs/image-png) crate and dependencies by the image-rs contributors | PNG decode (8 and 16-bit) | MIT or Apache-2.0 | `licenses/png-crate-and-wasm-bindgen.txt` |

## Pure JavaScript libraries

| Component | Used for | Licence | Text |
| --- | --- | --- | --- |
| [UTIF.js](https://github.com/photopea/UTIF.js) by Photopea | TIFF decode (all compressions utif supports) | MIT | `licenses/utif.txt` |
| [pako](https://github.com/nodeca/pako) by Vitaly Puzrin and Andrei Tuputcyn (a port of zlib by Jean-loup Gailly and Mark Adler) | zlib for PNG `iCCP` chunks and Airgap's own PNG writer | MIT and Zlib | `licenses/pako.txt` |

## Written by Airgap itself

The header inspector, the loss matrix, the EXIF/XMP/ICC container plumbing,
the ICC matrix/TRC conversion, the baseline TIFF writer, the colour-type-
minimising PNG writer, the runtime probes and the verification step are
Airgap's own code under the MIT licence.

## Patents

AVIF/AV1 is royalty-free under the Alliance for Open Media Patent License 1.0.
JPEG XL's reference implementation is published by its authors under a
patent grant contained in its BSD-style licence. Airgap deliberately does not
ship HEIC/HEVC, whose decoding is covered by patent pools with per-implementer
licensing; the reasoning is recorded in `docs/phase3-codec-survey.md`.

## Keeping this file honest

`npm run check:notices` (run in CI and before every build) fails if a runtime
dependency in `package.json` or a bundled upstream library named in
`scripts/check-notices.mjs` is missing from this file, if any referenced
licence text is absent from `licenses/`, or if the IJG attribution sentence
has been removed from this file or from the README.
