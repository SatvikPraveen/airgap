# Airgap

A static, fully client-side image format converter that tells you exactly what
a conversion throws away before you click Convert.

**Conversion happens entirely in your browser. Image bytes are never
transmitted anywhere.** There is no server side, no upload, no analytics, no
telemetry, and no remote assets at runtime. (The machine running it is not
"air-gapped"; the name refers to the app's own behaviour: it never connects to
anything.)

Phase 1 converts a single PNG, JPEG or WebP file into PNG, JPEG, lossless WebP
or lossy WebP, using the browser's canvas encoder.

## Why this exists

Most converters silently destroy data. Re-encoding through a browser canvas
strips EXIF (including GPS location), strips the ICC colour profile, truncates
16-bit samples to 8-bit, and composites transparency onto black when the target
cannot store alpha. Airgap does the same conversions, but it:

- lists every loss **before** conversion, in a warning panel, split into
  `pixels` (visible pixel values change), `hidden` (only RGB under alpha 0
  changes) and `metadata` (EXIF, ICC);
- offers a **Lossless only** toggle that disables any target which cannot keep
  all visible pixel values of *this* source;
- **refuses to composite RGBA onto black**: converting an image with alpha to
  JPEG requires you to pick a flatten colour (default white) and says the alpha
  channel will be lost;
- **verifies after conversion** by decoding its own output and diffing it
  against what it encoded, and reports the measured result (identical, or how
  many pixels differ and by how much).

## Verify the privacy claim yourself

1. **DevTools.** Open the app, open the browser DevTools Network tab, then
   load and convert an image. After the initial page load you will see no
   requests at all: not to this site, not to anyone.
2. **The CSP.** View the page source. The `Content-Security-Policy` meta tag
   contains `connect-src 'none'` and `default-src 'none'`. That is the browser
   itself refusing to let the page open any connection, regardless of what the
   JavaScript tries to do.
3. **The automated test.** `npm run test:e2e` runs `tests/e2e/privacy.spec.ts`
   against the production build. After the app is ready it routes every request
   through a handler that records and aborts it, records every CSP violation
   the document raises, runs three conversions, and asserts both lists are
   empty. A `fetch()` blocked by CSP never becomes a request, which is why both
   channels are watched. The test was verified to be able to fail: a temporary
   `fetch('https://example.invalid/leak-test')` in `src/ui/app.ts` turned it red
   through the CSP channel, and with `connect-src` relaxed it turned red through
   the request channel. A positive-control test keeps that check in the suite.
4. **Read the source.** `src/` contains no `fetch`, `XMLHttpRequest`,
   `WebSocket`, `sendBeacon`, or `importScripts`. Everything is bundled by Vite
   at build time. The only URLs the app creates are `blob:` URLs for previews
   and the download link, which live in your browser's memory.

## What the canvas codec loses (Phase 1 limitations)

These are real and are surfaced in the UI. They are properties of the
browser's canvas pipeline, which is the only codec in Phase 1.

| Loss | When | Severity |
| --- | --- | --- |
| Lossy encoding | target is JPEG or lossy WebP | pixels |
| Bit depth 16 to 8 | source has >8-bit samples | pixels |
| Alpha channel removed | source has alpha, target is JPEG | pixels (you choose the flatten colour) |
| Semi-transparent RGB rounded | source has 0 < alpha < 255 | pixels |
| RGB under alpha 0 discarded | source has fully transparent pixels | hidden |
| Animation frames dropped | APNG or animated WebP | pixels |
| EXIF stripped (GPS named if present) | source has EXIF | metadata |
| ICC profile stripped | source has ICC | metadata |

Two of these deserve emphasis because they surprised us during development
and are measured by the tests:

- **The 2D canvas stores premultiplied alpha.** A pixel `(200,100,50,1)` comes
  back as `(255,0,0,1)`; a fully transparent pixel comes back as `(0,0,0,0)`.
  So a PNG with partial transparency can *not* be round-tripped
  pixel-identically through the canvas, even PNG to PNG. The alpha channel and
  all fully opaque pixels survive exactly. With **Lossless only** on, a
  semi-transparent source therefore has no available target in Phase 1, and
  the UI says so rather than pretending.
- **Lossless WebP is browser-dependent.** Chromium's canvas encoder produces a
  true VP8L lossless bitstream when `quality` is exactly `1`. The app does not
  assume this: on start-up the worker encodes a 32x32 noise image as WebP at
  quality 1, decodes it, and only enables the "WebP (lossless)" target if the
  result is pixel-identical. The e2e suite confirms a real VP8L round trip in
  Chromium. In a browser where the probe fails, the target is disabled with the
  reason shown, and the lossless-only toggle excludes it.

Pixel values are copied as stored (`colorSpaceConversion: 'none'`); an ICC
profile is dropped rather than applied, and the warning says colours may then
be interpreted as sRGB. EXIF orientation is baked into the pixels so the output
looks the same without the tag.

## Development

Node 20+ and npm.

```sh
npm install
npx playwright install chromium   # once; needed by the browser + e2e tests
npm run dev        # local dev server (relaxes ONLY connect-src for hot reload)
npm run build      # typecheck + production build to dist/ (base /airgap/)
npm run preview    # serve dist/ at http://localhost:4173/airgap/
npm test           # Vitest: node unit tests + canvas codec tests in headless Chromium
npm run test:e2e   # Playwright against the production build
npm run fixtures   # regenerate tests/fixtures/ deterministically
```

### Layout

```
src/codecs/types.ts        Codec interface, DecodedImage, capabilities
src/codecs/canvas.ts       PNG/JPEG/WebP via createImageBitmap + OffscreenCanvas
src/inspect.ts             pure header parsing: bit depth, alpha, EXIF/GPS, ICC, animation
src/capabilities.ts        pure: source + target -> list of losses (the core logic)
src/flatten.ts             pure alpha compositing onto a chosen colour
src/convert.ts             pure orchestration + post-conversion verification
src/worker.ts              runs decode/encode off the main thread
src/ui/                    drag-and-drop, source facts, target picker, loss panel, result
tests/unit/                Vitest, node: capabilities matrix, inspect, flatten, convert
tests/browser/             Vitest browser mode: real codec round trips in Chromium
tests/e2e/                 Playwright: drop, convert, download, decode; privacy trap
tests/fixtures/            generated by scripts/make-fixtures.mjs
```

### Fixtures

`npm run fixtures` writes, deterministically:

- `rgb8.png` 64x48 8-bit RGB (gradients plus a noise band)
- `rgba-partial.png` 64x48 RGBA with opaque, semi-transparent, fully transparent
  (with hidden colour) and alpha=1 bands
- `rgb16.png` 32x32 16-bit RGB with values not representable in 8 bits
- `exif-gps.jpg` 64x48 JPEG with an EXIF APP1 segment containing Orientation and
  a GPS IFD (latitude/longitude)
- `one-pixel.png` 1x1 RGB

`tests/fixtures/pattern.mjs` is the shared pixel formula, so tests assert exact
expected values without trusting any decoder.

## Deploy

Static files in `dist/`, built with Vite `base: '/airgap/'` for GitHub Pages at
`https://<user>.github.io/airgap/`.
