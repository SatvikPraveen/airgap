# Changelog

Airgap converts images entirely in the browser and states, before and after,
exactly what each conversion discards. Every entry below is covered by the
test suites, which run in Chromium, Firefox and WebKit.

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

Phases 1 to 4: PNG, JPEG, WebP, AVIF, JPEG XL and TIFF conversion with a loss
list computed from probed codec capabilities, post-conversion verification
and heat map, metadata inspector with strip-GPS, ICC matrix conversion,
16-bit PNG and TIFF, memory guard and cancel, build provenance attestation.
Released under the MIT licence.
