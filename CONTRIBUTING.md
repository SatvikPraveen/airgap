# Contributing to Airgap

Thank you for your interest. Issues and pull requests are welcome.

## Non-negotiables

These hold for every change. A pull request that breaks one is not merged.

- **No bytes leave the device.** No backend, upload, analytics, telemetry,
  remote fonts, CDN scripts or any other runtime network access. The page's
  Content-Security-Policy keeps `connect-src 'none'`, and the end-to-end
  privacy trap must stay green.
- **Losses are declared, never hidden.** If a change can alter pixel values,
  geometry or metadata, the loss list must say so before conversion, and the
  verification must measure it afterwards.
- **Capabilities are probed, not assumed.** A codec is offered for a role only
  after its runtime probe demonstrated that role in the running browser.
- **Vite, TypeScript and the plain DOM.** No UI framework.
- **Accurate wording.** Do not claim the user's machine is air-gapped. The
  accurate claim is that conversion happens entirely in the browser and image
  bytes are never transmitted anywhere.

## Setting up

Node 20 or newer.

```sh
npm install
npx playwright install chromium firefox webkit
npm run dev
```

## Before opening a pull request

Run the full suite. All of it must pass.

```sh
npm run check:notices
npm run typecheck
npm test                     # node unit tests and real-codec tests in Chromium
npm run build
npm run check:budget
npm run test:e2e
AIRGAP_BROWSERS=chromium,firefox,webkit npm test   # when codec or canvas behaviour changes
```

CI runs the browser and end-to-end suites in Chromium, Firefox and WebKit. An
engine difference is pinned in `tests/browser/engine-matrix.test.ts`, not
papered over.

## Dependencies and codecs

- Every bundled third-party component must be listed in
  `THIRD_PARTY_NOTICES.md` with its verbatim licence in `licenses/`.
  `npm run check:notices` enforces this.
- New codecs must be permissively licensed and must not be covered by a
  patent pool that licenses per implementation. HEVC, for example, is only
  ever decoded by the platform's own decoder.
- libjxl and libavif are built by Airgap from `tools/`. If you change their
  build, rebuild with the pinned Dockerfiles and commit the new `vendor/`
  files together with their `SHA256SUMS`.
- Keep the gzipped bundle within the budget in
  `scripts/check-bundle-budget.mjs`. Load codecs lazily.

## Commits

One concern per commit, with a message that says what changed and why.
Update `CHANGELOG.md` under "Unreleased" for anything a user would notice.

## Licence

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), the licence of this project.
