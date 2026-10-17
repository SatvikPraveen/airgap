# Changelog

Airgap converts images entirely in the browser and states, before and after,
exactly what each conversion discards. Every entry below is covered by the
test suites, which run in Chromium, Firefox and WebKit.

## Unreleased

- Documentation: contents list, badges and refreshed screenshots in the
  README (with a dark-mode variant); `CONTRIBUTING.md`, `SECURITY.md` and a
  pull-request template; the codec survey moved to `docs/codec-survey.md`.
- Dependencies: Playwright 1.64 (WebKit 27.2), TypeScript 7, pako 3, Vite and
  Vitest updates. WebKit 27.2 differences are measured and recorded in the
  README's engine table; on macOS WebKit, `createImageBitmap` mishandles
  `premultiplyAlpha: 'none'`, so the HEIC and canvas decoders no longer ask
  for it.

## 0.3.0 (2026-10-11)

### New
- **Animated PNG (APNG)** in and out. Every frame, frame delay and the loop
  count are kept and verified frame by frame. Airgap's own reader composites
  each frame as the specification says, and its writer stores later frames
  as changed rectangles. Other targets keep one still image, and the loss
  list says which one. Checked against a model of the specification and the
  browsers' own APNG decoders. UPNG.js, a test-only dependency, has two
  compositing bugs, which are documented and pinned in the tests.
- **Animated WebP** in and out, converting to and from APNG. Frames are
  composited exactly as libwebp's animation decoder does, including its
  integer blending, and checked against it sample for sample. A delay that
  WebP cannot hold in whole milliseconds is listed before conversion.
- **Animated AVIF (image sequences)** in and out, with exact fractional
  timing, through libavif 1.4.2 + libaom 3.15.2, now built by Airgap
  (`tools/libavif`). It replaces the jSquash AVIF build and is smaller.
- **libjxl 0.12.0, built by Airgap** (`tools/libjxl`), replaces the 2022
  snapshot. Its decoder is exact, 16-bit JPEG XL is written and read, and ICC,
  EXIF and XMP are carried.
- **Reversible JPEG recompression:** JPEG to JPEG XL, verified by rebuilding
  the JPEG byte for byte. Metadata modes still apply.
- Codec builds are reproducible: pinned Dockerfiles, SHA256SUMS, and a
  workflow that rebuilds and compares.

- **HEIC, read only**, through the browser's or operating system's own
  licensed decoder; Airgap ships no HEVC code. Safari's image decoder is
  tried first. Otherwise Airgap reads the HEIF container itself (grids, alpha,
  rotation) and decodes the HEVC tiles with WebCodecs, converting YUV to RGB
  itself. That reaches Chrome where the system has an HEVC decoder. HEIC is
  never a target and always carries the decoder-unverified loss.
- Tests can run in Google Chrome (`AIRGAP_BROWSERS=chrome`) as well as
  Playwright's Chromium, Firefox and WebKit.

### Fixed
- Licence texts: libaom's patent licence, libjxl's patent grant and skcms's
  licence are now included verbatim (they were missing).

## 0.2.0 (2026-10-11)

Licence: Airgap's own code is now Apache-2.0 (see `LICENSE` and `NOTICE`).
Releases up to and including commit d3cf05d remain available under MIT.

### New
- **Live quality preview.** For lossy targets, the real encode runs as the
  slider moves and reports size and measured pixel difference. A test
  confirms Convert produces exactly the previewed file.
- **Batch conversion.** Several files, one set of settings, per-file
  verification, losses counted per file, one ZIP written by Airgap itself.
- **Crop, rotate, mirror, resize** as declared edits. Crop and rotation keep
  every value and are allowed under "Lossless only". Resizing (Lanczos-3,
  premultiplied alpha) is listed as a pixel loss.
- **Lossless JPEG XL.** jxl-oxide, an independent decoder, reads and verifies
  JPEG XL. It showed that libjxl's encoder was exact and its 2022 decoder was
  off by one.
- **LUT-based ICC profiles** (lut8, lut16, lutAtoB) convert to sRGB, checked
  against LittleCMS: 98.8-99.1% identical, never more than one level apart.
- **QOI** in and out, with Airgap's own codec, byte-identical to the
  reference encoder.
- **Optional oxipng** for PNG output, kept only when verified identical and
  smaller.
- **Three-engine CI.** Measured differences between engines are pinned in
  tests and reported by the app.

### Fixed
- JPEG XL sources: EXIF and XMP were silently dropped in "preserve" mode;
  Brotli-compressed metadata boxes went unreported.
- A preview finishing after Convert reset the result's compare view.
- Firefox could not load the worker's codec chunks under the CSP.

## 0.1.0 (2026-09-27)

First release: PNG, JPEG, WebP, AVIF, JPEG XL and TIFF conversion with a loss
list computed from probed codec capabilities, post-conversion verification
and heat map, metadata inspector with strip-GPS, ICC matrix conversion,
16-bit PNG and TIFF, memory guard and cancel, build provenance attestation.
Released under the MIT licence.
