# Phase 3 codec survey (Step 1: investigate before coding)

Date: 2026-09-23. Deploy target: GitHub Pages (static, no COOP/COEP headers,
so `SharedArrayBuffer` is unavailable). Page CSP today:
`default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'none'`.

Tags: **[V]** verified by running a command, reading the file, or observing
behaviour in a browser. **[I]** inferred from documentation or general knowledge.

## 0. Findings about our own constraints (verified in headless Chromium 153)

Probe site and script: scratchpad `csp/` (a static page with our exact meta CSP,
served by `python3 -m http.server`, driven by Playwright).

1. **WebAssembly is blocked under `script-src 'self'`.** [V]
   `WebAssembly.instantiate()` in the document throws
   `CompileError: ... violates the following Content Security Policy directive
   because 'unsafe-eval' is not an allowed source of script`. Adding
   `'wasm-unsafe-eval'` to `script-src` allows it. That keyword permits wasm
   compilation only; it does not permit JS `eval` and has no network effect.
2. **The meta-tag CSP does not apply inside our dedicated worker.** [V]
   A worker created from a same-origin URL got its CSP from the worker
   script's HTTP response headers, of which GitHub Pages sends none. In the
   probe the worker instantiated wasm freely and `fetch()` of a same-origin
   URL returned 200. This affects Phase 1 today: all codec code runs in the
   worker, so the README/UI sentence "its CSP forbids every outgoing
   connection" overstates the mechanical guarantee for worker code. The e2e
   privacy trap is unaffected: Playwright observed the worker's cross-origin
   request in the same probe [V], so a leak from the worker would still fail
   the test.
3. **Remedy: a blob-URL worker inherits the document CSP.** [V]
   With `worker-src blob:` and the worker created from
   `URL.createObjectURL(new Blob([source]))`: `fetch()` of both cross-origin
   and same-origin URLs is blocked with a `connect-src` violation raised
   inside the worker scope; Playwright saw no request at all; `import()` of an
   absolute same-origin URL still works (governed by `script-src 'self'`);
   `WebAssembly.instantiate` works with `'wasm-unsafe-eval'`; and a
   `WebAssembly.Module` compiled on the main thread transfers to the worker
   via `postMessage` and instantiates there.
4. **`connect-src 'none'` forbids fetching a `.wasm` file, even same-origin.** [V]
   So wasm must arrive as script: base64 inside a lazily `import()`ed JS
   chunk. Measured gzip cost of base64 versus raw wasm (single-threaded
   builds): 1.27x (png) to 1.39x (avif decoder) [V, `gzip -9` on both].
   The alternative is `connect-src 'self'`, which would change the headline
   claim; not recommended.

## 1. wasm-vips 0.0.18 (2026-06-09) — disqualified

- MIT wrapper; libvips 8.18.3; bundles mozjpeg, libpng, libwebp, libtiff,
  libheif 1.23.0 + aom (AVIF only; `WITH_LIBDE265=OFF`, so **no HEIC**),
  libjxl 0.11.2, libexif, lcms2. [V: tarball `versions.json`, `build.sh`,
  `strings` on the wasm]
- Metadata: savers take `keep` (exif/xmp/iptc/icc/other), `profile`;
  `iccTransform`/`iccImport` exist; 16-bit via `ushort` band format. [V: d.ts]
- Payload: `vips.wasm` 1.98 MB gz (1.60 MB brotli) + 30 KB loader, and the
  loader by default also pulls `vips-heif.wasm` (1.23 MB gz) and
  `vips-jxl.wasm` (0.77 MB gz): ~4.0 MB gz out of the box. [V: measured]
- **Cross-origin isolation is a hard requirement.** README: "Since wasm-vips
  requires the `SharedArrayBuffer` API, the website needs to opt-in to a
  cross-origin isolated state". The loader allocates
  `WebAssembly.Memory({shared: true})`; `build.sh` passes `-pthread`
  unconditionally with no no-threads switch. Maintainer, issue #18 (2022):
  "a hard-requirement. There's no workaround". Issue #127 (2026-08-20), asking
  for a `USE_PTHREADS=0` variant for a browser-side converter: "not possible,
  since libvips requires threading functionality to be available, so the use
  of the SharedArrayBuffer API _cannot_ be disabled". [V: README, loader
  grep, `gh api` on the issues]
- Also needs `'unsafe-eval'` (embind `eval`/`new Function` in the loader). [V]
- Only escape hatch is the coi-serviceworker reload hack, which the maintainer
  points at for GitHub Pages. That is a service worker that intercepts every
  response to inject COOP/COEP headers and forces a reload; it is fragile and
  would put a network-layer interceptor into a privacy tool. Not acceptable.

## 2. @jsquash/* (jamsinclair/jSquash, Squoosh codecs) — viable

All Apache-2.0 wrappers; ESM; wasm resolved via `new URL(x.wasm,
import.meta.url)`; every package exports `init(WebAssembly.Module | bytes)`
so we can feed the module ourselves. [V: d.ts, READMEs]

**Isolation: not required on the default path.** [V] Decoders and the
png/jpeg/webp/qoi encoders ship only non-shared-memory wasm. avif/jxl/oxipng
ship additional `_mt` builds that are chosen only when
`wasm-feature-detect.threads()` is true, which requires `SharedArrayBuffer`;
on a non-isolated page it is undefined and the check returns false. Upstream
README: "No dynamic code execution, the packages can be run in strict
environments that do not allow code evaluation." The single-threaded glue
contains no `eval`/`new Function`. [V: grep]

**Metadata: none, anywhere.** [V] No decoder exposes EXIF/ICC/XMP and no
encoder accepts them (grep of all `.d.ts` and wrappers). `@jsquash/jpeg`
reads EXIF only to rotate when `preserveOrientation: true`; `@jsquash/jxl`
consumes the ICC to convert to sRGB then drops it.

**No `@jsquash/tiff`, no `@jsquash/heic`.** [V: npm 404, repo tree]

| package | version (date) | codec inside | decode | encode | lossless | exact RGBA | 16-bit | gz decode / dec+enc |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| png 3.1.1 | 2025-05-20 | Rust `png` 0.17.10 | RGBA8 or RGBA16 | RGBA 8/16, no compression options | yes | yes [V: straight samples, no canvas] | both ways [V] | 87 / 88 KB |
| jpeg 1.6.0 | 2025-05-12 | mozjpeg 3.3.1 | RGBA8 (opt. EXIF rotate) | quality, progressive, chroma... | no (format) | n/a; alpha silently dropped, no compositing [V] | no | 75 / 146 KB |
| webp 1.5.0 | 2025-05-12 | libwebp ~1.1 snapshot (2020-11) | RGBA8 (still images only) | full `WebPConfig` | `lossless:1` | **only with `exact:1`** (default 0 discards RGB under alpha 0) [V: libwebp header + wrapper passes config through] | no | 60 / 187 KB |
| avif 2.1.1 | 2025-05-20 | libavif 1.0.1 + aom 3.7.0 | 8/10/12/16-bit | 8/10/12-bit, `lossless:true` (IDENTITY matrix + 4:4:4) [V: source] | yes | [I] unpremultiplied defaults | yes | 350 KB / 1.48 MB |
| jxl 1.3.0 | 2025-07-12 | libjxl 0.7-dev snapshot (2022-01) | RGBA8 sRGB via skcms float path | `lossless:true` (1.3.0), effort, quality | yes | [I] likely; must test | no | 326 / 855 KB |
| oxipng 2.3.0 | 2024-06-18 | oxipng 9.0 | (optimiser only) | re-optimise PNG bytes, keeps chunks with `optimiseAlpha:false` | yes | yes | buffer path yes | 80 KB |
| qoi 1.1.0 | 2025-05-12 | qoi.h | RGBA8 | RGBA8 | yes | yes | no | 17 / 34 KB |

Licensing to-dos if adopted [V: tarballs]: jpeg's `LICENSE.codec.md` requires
the sentence "This software is based in part on the work of the Independent
JPEG Group" in product documentation; avif and jxl tarballs ship no codec
licence text, so libavif/aom (BSD-2 + AOM patent licence) and libjxl/skcms
(BSD-3) notices must be added by us.

Codec ages [V]: mozjpeg 3.3.1 (2017), libwebp 2020 snapshot, libjxl Jan 2022
snapshot, libavif 1.0.1/aom 3.7.0 (2023). Old snapshots matter mainly as
robustness on hostile input; here the input is the user's own file inside a
wasm sandbox in their own browser, so the exposure is a crash, not a breach.

Vite notes [V: upstream README]: add `optimizeDeps.exclude` for the packages;
a known Vite bug with nested workers affects the `_mt` variants, which we
never load but which Vite will still emit as chunks.

## 3. HEIC — decoding is available without isolation; licensing is the question

| candidate | version (date) | licence | inside | decode/encode | gz | SAB |
| --- | --- | --- | --- | --- | --- | --- |
| libheif-js 1.23.2 | 2026-09-05 | LGPL-3.0 | libheif 1.23.2 (LGPL-3) + libde265 1.0.15 (LGPL-3.0-or-later) | HEIC decode only (no AVIF) | 469 KB wasm + 29 KB loader (697 KB inlined) | **No** [V: decoded a HEIC in Node 20 with `SharedArrayBuffer` deleted; wasm memory not shared; upstream builds with `ENABLE_MULTITHREADING_SUPPORT=OFF`] |
| heic-to 1.5.2 | 2026-05-26 | LGPL-3.0 | same libs, **JS-only build (no wasm)** | decode via canvas | 729 KB | No |
| @imagemagick/magick-wasm 0.0.43 | 2026-08-25 | Apache-2.0 wrapper; NOTICE carries libheif/libde265 LGPL | ImageMagick 7.1.2 Q8 with heic, jxl, aom, libtiff, lcms | HEIC read only; AVIF/JXL/TIFF/WebP/PNG r/w [V: runtime `supportedFormats`] | **5.16 MB** | No (x86 build) |

Patent position, facts only, not legal advice [V: sources fetched]:

- HEVC is covered by patent pools: Access Advance (HEVC Advance), the former
  MPEG LA / Via LA HEVC programme (acquired by Access Advance 2025-12-15), and
  historically Velos Media (joint programme ended 2022/23), plus unaffiliated
  holders. LGPL code licences say nothing about third-party standard-essential
  patents; libde265 and libheif carry **no patent note at all** (checked
  README, COPYING, libde265.org).
- Access Advance FAQ: "In general, HEVC software downloaded by users requires
  a license. However, there are some situations wherein a license is not
  needed." Its 2016 announcement said it "will not seek a license or
  royalties on HEVC functionality implemented in application layer software
  downloaded to mobile devices or personal computers after the initial sale
  of the device, where the HEVC encoding or decoding is fully executed in
  software on a general purpose CPU" (browsers, media players, applications),
  "subject to certain exceptions/conditions". The current site does not
  restate that policy explicitly.
- Browser vendors: caniuse lists HEIC image support only in Safari 17+ on
  Apple platforms, "complex and expensive to license"; Mozilla's bug 1402293
  is P5 with "It's patented, so it's unlikely that it will be implanted into
  Firefox." Chrome has no HEIC image support on any OS (its HEVC support is
  video playback via hardware decoders).
- AVIF is royalty-free under the AOM Patent License 1.0 [V: aomedia.org].

Also relevant: the airgap repository currently has **no LICENSE file** [V].
LGPL-3 obligations (ship notices, make library source available, allow
relinking) are trivially met if the app itself is open source; they are
harder to argue if the wasm is base64-inlined into an app bundle of a
closed-source project.

## 4. TIFF — no wasm candidate; three pure-JS options

| package | version (date) | licence | gz | 16-bit | alpha | compressions | encode | tags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| utif 3.1.0 | npm 2019-06, repo 2026-05 | MIT | 19 KB (+pako) | decodes; `toRGBA8` keeps high byte | straight copy; `ExtraSamples` ignored | none, CCITT G3/G4, LZW, JPEG, Deflate, PackBits, some RAW/DNG | 8-bit RGBA uncompressed; writes `ExtraSamples=1` (associated, wrong for straight alpha; overridable) | raw `tNNN` on decode; arbitrary tags on encode |
| geotiff 3.0.5 | 2026-03 | MIT | 200 KB (+91 KB worker) | native typed arrays incl. float | checks `ExtraSamples`, no un-premultiply | none, PackBits, LZW, Deflate, JPEG, LERC, ZSTD | `writeArrayBuffer`, uncompressed, 16-bit possible | raw `fileDirectory` incl. ICC, ExifIFD |
| tiff 7.1.3 (image-js) | 2025-12 | MIT | ~20 KB | yes | detects associated alpha and **un-premultiplies** | none, LZW, Deflate only (PackBits/JPEG throw) | none | EXIF sub-IFD parsed |

## 5. JPEG XL / AVIF alternatives

- jxl-oxide-wasm 0.12.6 (2026-05-29, MIT OR Apache-2.0, 604 KB gz, no
  threads): current spec-conforming **decoder only**; output is PNG bytes
  (16-bit when the source is >8-bit, with ICC/cICP), no raw pixel accessor.
- @saschazar/wasm-avif 2.0.1 (2022, stale, 916 KB gz): 8-bit API. Not better
  than @jsquash/avif.
- avif.js: obsolete service-worker polyfill. No.

## 6. PNG pure-JS alternatives and metadata libraries

- fast-png 8.0.0 (2025-12, MIT, ~34 KB): 16-bit both ways, reads tEXt/iCCP/
  pHYs/tRNS, drops eXIf; writes only IHDR/PLTE/tRNS/tEXt/IDAT. pngjs: drops
  every ancillary chunk. Neither carries EXIF.
- EXIF handling: exifr (read only, no WebP, unmaintained since 2021),
  piexifjs (JPEG only, abandoned 2019), exif-be-gone (strip all, Node
  streams), @uswriting/exiftool (full ExifTool via WASI Perl, 7.5 MB gz).
  **Nothing lightweight writes EXIF into PNG or WebP or strips only GPS.**
  Our Phase 1 `inspect.ts` already parses the containers and the TIFF IFD
  structure; the missing pieces (copy a TIFF blob into APP1 / `eXIf` /
  `EXIF`, drop the GPSInfo tag from IFD0, rewrite Orientation, copy ICC into
  APP2 / `iCCP` (zlib via `CompressionStream`) / `ICCP`) are container
  plumbing, not codec work, and are fully unit-testable on parsed tags.
