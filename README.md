# Airgap

A static, fully client-side image format converter that tells you exactly what
a conversion throws away before you click Convert, then measures what it
actually threw away afterwards.

**Conversion happens entirely in your browser. Image bytes are never
transmitted anywhere.** There is no server side, no upload, no analytics, no
telemetry, and no remote assets at runtime. (The machine running it is not
"air-gapped"; the name refers to the app's own behaviour: it never connects to
anything.)

Formats: PNG, JPEG, WebP, AVIF, JPEG XL and TIFF in; PNG, JPEG, WebP, AVIF,
JPEG XL and TIFF out. HEIC is deliberately absent (see below).

## Why this exists

Most converters silently destroy data. Airgap:

- lists every loss **before** conversion in a warning panel, split into
  `pixels` (visible pixel values change, or cannot be shown not to) and
  `metadata` (EXIF, XMP, ICC dropped or altered);
- offers a **Lossless only** toggle that disables any target whose *verified*
  codec cannot keep all visible pixel values of *this* source;
- **refuses to composite RGBA onto black**: converting an image with alpha to
  JPEG requires you to pick a flatten colour (default white);
- lets you choose what happens to **EXIF/XMP** (strip all, strip GPS only,
  preserve all) and, separately, to the **ICC profile** (strip, preserve,
  convert to sRGB), and says for each what it does to appearance and to values;
- **probes every codec in your browser before believing it**: a codec's
  declared capabilities are a hypothesis; a 24x24 test image with opaque noise,
  semi-transparent pixels and colour hidden under alpha 0 is encoded, decoded,
  compared exactly and, where possible, cross-checked with the browser's own
  decoder. Whatever cannot be demonstrated is reported as unavailable;
- **verifies after conversion** by decoding its own output, diffing every
  sample against what it encoded (transparent pixels included), and re-reading
  the container to confirm which metadata is present.

## Verify the privacy claim yourself

1. **DevTools.** Open the app, open the Network tab, load and convert an image.
   After the page and its worker have loaded, the only requests you can ever
   see are lazy loads of the app's own codec chunks (`/airgap/assets/*.js`),
   the first time a format is used. Nothing goes anywhere else, and no request
   carries image data.
2. **The CSP.** View the page source. The `Content-Security-Policy` meta tag
   contains `connect-src 'none'` and `default-src 'none'`: the browser itself
   refuses to let the page open any connection. Two details matter:
   - A meta-tag CSP applies to the document, and a dedicated worker started
     from a same-origin URL takes its policy from HTTP response headers that
     GitHub Pages does not send. Airgap therefore starts its worker from a
     `blob:` URL (`worker-src blob:`), and a blob worker inherits the page's
     policy. Verified in Chromium: inside the blob worker, `fetch()` of both
     cross-origin and same-origin URLs raises a `connect-src` violation and no
     request is made.
   - `script-src` includes `'wasm-unsafe-eval'`. This keyword lets the browser
     compile WebAssembly, which the image codecs are. It does **not** enable
     JavaScript `eval()` or `new Function()` (that would be `'unsafe-eval'`,
     which the policy does not contain and a test asserts it never will), and
     it opens no network path. Because `connect-src 'none'` forbids fetching a
     `.wasm` file even from our own origin, the wasm binaries are embedded as
     base64 inside lazily imported script chunks.
3. **The automated tests.** `npm run test:e2e` runs `tests/e2e/privacy.spec.ts`
   against the production build. After the app is ready and the codecs a
   conversion needs are loaded, it routes every request through a handler that
   records and aborts it, records every CSP violation, runs four conversions,
   and asserts both lists are empty. A `fetch()` blocked by CSP never becomes a
   request, which is why both channels are watched. A second test pins down
   lazy loading: while codecs load, every request must be a plain `GET` of a
   file that exists by exact name in `dist/assets`. Positive controls prove
   the trap catches a fetch, an image beacon, a WebSocket, and a fetch from
   inside a worker. The suite was verified to be able to fail (and re-verified
   for Phase 3): a temporary `fetch('https://example.invalid/leak-test')` in
   the app turned it red through the CSP channel, and with `connect-src`
   relaxed it turned red through the request channel.
4. **Read the source.** `src/` contains no `fetch`, `XMLHttpRequest`,
   `WebSocket`, `sendBeacon` or `importScripts` of its own. The bundled codec
   glue can reference its `.wasm` by URL, but it is always handed a compiled
   module instead and the raw `.wasm` files are stripped from the build.

## What is provably lossless (Chromium, measured by the test suites)

Exact means every sample of every pixel, R, G, B and A, including RGB stored
under alpha 0, compared with a plain `===` after decoding the output again.

| Round trip | Exact? | Evidence |
| --- | --- | --- |
| PNG 8-bit RGBA to PNG, WebP lossless, AVIF lossless, TIFF | **yes** | codec round trips, pipeline verification, downloaded bytes re-read by pngjs / image-js |
| PNG 16-bit RGBA to PNG, TIFF | **yes, at 16-bit** | pngjs and image-js read back identical Uint16 samples |
| AVIF 10-bit and 12-bit RGBA to AVIF lossless | **yes** | codec round trips |
| TIFF 8/16-bit (straight alpha) to PNG/WebP/AVIF/TIFF | **yes** | fixtures written by an independent writer, read by utif, verified by image-js |
| WebP lossless, AVIF lossless sources to any lossless target | **yes** | fixture decodes match the generating pattern exactly |
| JPEG XL, either direction | **no** | see below |
| Anything through the canvas fallback with transparency | **no** | canvas is premultiplied: semi-transparent RGB rounds, RGB under alpha 0 is zeroed |
| Any 16-bit source to WebP or JPEG XL | no, 8-bit output | flagged as `bit-depth` |
| TIFF with associated (premultiplied) alpha | no | un-premultiplying rounds; flagged as `associated-alpha` |

Round trips that are exact today are only ever *offered* as lossless after the
probe has demonstrated them in the running browser.

### JPEG XL is decode and lossy-encode only

The `@jsquash/jxl` encoder/decoder pair (a libjxl snapshot from January 2022,
decoding through a float path) reproduces our alpha test image with a maximum
channel difference of 1 on a handful of pixels, opaque ones included. That is
not exact, so the probe refuses to mark it lossless and the "JPEG XL
(lossless)" target is disabled with the reason shown. There is no independent
JPEG XL decoder in the browser to attribute the error to one side, so
JPEG XL *sources* also carry a `decoder-unverified` pixel loss: the output
cannot be called lossless. If a future package fixes this, the probe will
notice and the tests in `tests/browser/wasm-codecs.test.ts` that assert the
current behaviour will fail, which is the intended signal.

### RGB under alpha 0 is a pixel loss

Fully transparent pixels still carry RGB. Sprite sheets and game textures put
deliberate colour bleed under alpha-0 borders so that bilinear filtering does
not pull fringing into visible edges; flattening those to `0,0,0,0` destroys
real information even though no viewer shows it. Phase 1 classified this as a
"hidden" loss that did not trip the lossless-only toggle. Phase 3 reclassifies
it as a **pixels** loss: any pipeline that cannot keep it (the canvas fallback)
is excluded by lossless-only, and the tests assert exact equality over the full
RGBA tuple without skipping alpha-0 regions.

## Metadata and colour

**EXIF / XMP**, defaulting to strip all:

- *Strip all*: EXIF and XMP removed.
- *Strip GPS only*: the GPS IFD is removed from EXIF and nothing else is
  touched (asserted on parsed tags by exifr, an independent reader). XMP is
  removed too, because it can carry location and Airgap does not edit XMP
  selectively.
- *Preserve all*: EXIF and XMP carried through byte-for-byte, with **one
  exception that the loss panel states**: Airgap stores pixels upright, so a
  carried EXIF Orientation tag is rewritten to 1. Carrying the original tag
  would make viewers rotate the already-rotated image again. Tested with an
  Orientation=6 fixture.

**ICC profile**, defaulting to strip:

- *Strip*: pixel values preserved, appearance not (viewers assume sRGB).
- *Preserve*: values and appearance preserved, if the target can embed a
  profile.
- *Convert to sRGB*: appearance preserved, values changed, profile dropped.
  Only matrix/TRC profiles (sRGB, Display P3, Adobe RGB, ProPhoto and the
  like) are converted. On a LUT-based profile the option is **disabled with
  the reason shown**; Airgap never approximates a LUT with the matrix path.

Which targets can carry what: PNG, JPEG, WebP and TIFF carry EXIF, ICC and
XMP (verified by the probe: what goes in must come back out). AVIF and
JPEG XL cannot carry any of them through the codecs in use; choosing
"preserve" for those targets lists the loss and the post-conversion check
reports "removed".

The JPEG XL decoder applies the embedded ICC profile itself (to sRGB) and
cannot be told not to; that conversion is reported as a pixel loss for JXL
sources with a profile.

## HEIC

Left out of this phase. `libheif-js` can decode HEIC without cross-origin
isolation, but the package ships no LICENSE file, so its LGPL-3 obligations
cannot be met against absent terms, and HEVC decoding is patent-pool licensed.
The decision and the evidence are in `docs/phase3-codec-survey.md`. It may
return later as an explicit opt-in module.

## Codec selection

Every format has an ordered list of codecs; the first whose probe demonstrates
the needed role wins, and the browser canvas is always registered last as the
fallback (declaring `exactAlpha: false`, 8-bit, no EXIF orientation of its
own). Selection and the loss computation read probed capability fields only;
no codec is ever special-cased by name. If the preferred decoder rejects a
particular file (mozjpeg refuses CMYK JPEGs, libwebp refuses animations), the
next decoder is tried for that file and the source panel names the one used.

| Format | Preferred codec | Fallback |
| --- | --- | --- |
| PNG | @jsquash/png (Rust `png`), 8/16-bit | canvas |
| JPEG | @jsquash/jpeg (mozjpeg) | canvas |
| WebP | @jsquash/webp (libwebp, `exact: 1`) | canvas |
| AVIF | @jsquash/avif (libavif + aom), 8/10/12-bit | canvas (decode only) |
| JPEG XL | @jsquash/jxl (libjxl snapshot), 8-bit | none |
| TIFF | utif (decode) + own baseline writer, 8/16-bit | none |

The TIFF writer is uncompressed baseline, little-endian, single strip, straight
alpha declared as `ExtraSamples=2`, and is validated against two independent
readers (utif and image-js `tiff`), never only against its matching reader.
Fixture TIFFs come from a third, independent writer in the fixture script.

Known limitation: AVIF `irot`/`imir` rotation properties are detected and
reported as a pixel loss but not applied by the decoder in use.

## Bundle size

Measured with `node scripts/bundle-report.mjs` after `npm run build`
(gzip -9). Before Phase 3, first paint was 8.4 KB plus a 3.8 KB worker.

| Payload | gzipped |
| --- | --- |
| First paint (HTML + CSS + main JS, includes the inline bootstrap worker) | 11.2 KB |
| Worker module (registry, conversion pipeline, metadata layer, pako) | 30.6 KB |
| PNG codec (lazy) | 106 KB |
| JPEG codec (lazy) | 177 KB |
| WebP codec (lazy) | 228 KB |
| TIFF (lazy, pure JS) | 28 KB |
| JPEG XL codec (lazy) | 1.13 MB |
| AVIF codec (lazy) | 1.95 MB |

A user converting a single JPEG downloads the first two rows plus the codecs
for JPEG and the chosen target. Base64 embedding costs about 1.3x on the
gzipped wasm compared with a raw `.wasm` file; that is the price of keeping
`connect-src 'none'`.

## Development

Node 20+ and npm.

```sh
npm install
npx playwright install chromium   # once; needed by the browser + e2e tests
npm run dev        # local dev server (relaxes ONLY connect-src/style-src/worker-src for HMR)
npm run build      # typecheck + production build to dist/ (base /airgap/)
npm run preview    # serve dist/ at http://localhost:4173/airgap/
npm test           # Vitest: node unit tests + real-codec tests in headless Chromium
npm run test:e2e   # Playwright against the production build
npm run fixtures   # regenerate tests/fixtures/ deterministically
node scripts/bundle-report.mjs
```

### Layout

```
src/codecs/types.ts        Codec interface, PixelData (8/10/12/16-bit RGBA), capabilities
src/codecs/probe.ts        runtime capability probe (pure: codec API only)
src/codecs/registry.ts     per-format ordered codecs, lazy loading, per-file fallback
src/codecs/canvas.ts       browser canvas fallback (exactAlpha: false)
src/codecs/wasm/*.ts       @jsquash-backed PNG, JPEG, WebP, AVIF, JPEG XL
src/codecs/tiff.ts         utif decode + own baseline writer
src/inspect.ts             pure header parsing for all six formats
src/capabilities.ts        pure: source + target + probed pipeline -> list of losses
src/convert.ts             pure orchestration: ICC, bit depth, flatten, metadata, verification
src/metadata/tiff-ifd.ts   generic TIFF IFD parser/serializer
src/metadata/exif.ts       EXIF summarise, strip GPS, normalise orientation
src/metadata/containers.ts EXIF/ICC/XMP in and out of JPEG, PNG, WebP containers
src/metadata/icc.ts        ICC parse, matrix/LUT classification, matrix/TRC -> sRGB
src/worker-boot.ts         inline blob: bootstrap so the worker inherits the CSP
src/worker.ts              conversion worker
src/ui/                    drag-and-drop, source facts, target picker, modes, loss panel, result
tests/unit/                Vitest, node: matrix, metadata layer, ICC, TIFF writer vs two readers
tests/browser/             Vitest browser mode: real codecs, probes, full pipeline, exifr
tests/e2e/                 Playwright: downloads re-read independently, privacy trap
tests/fixtures/            generated by scripts/make-fixtures.mjs
docs/                      Phase 3 codec survey
```

## Deploy

Static files in `dist/`, built with Vite `base: '/airgap/'` for GitHub Pages at
`https://<user>.github.io/airgap/`.
