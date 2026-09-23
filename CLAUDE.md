# Airgap — project rules

Fully client-side image format converter. Images never leave the user's machine.

## Non-negotiables
- No backend, no upload, no analytics, no telemetry, ever.
- No CDN or remote assets at runtime. Everything bundled at build time.
- Any change that could send bytes off-device is a blocking bug.
- Vite + TypeScript + vanilla DOM. No UI framework.
- Tests must pass before any commit.

## Naming discipline
The app is called Airgap. In user-facing copy do NOT claim the machine is
air-gapped — it isn't. The accurate claim: conversion happens entirely in
your browser; image bytes are never transmitted anywhere.

## Deploy target
GitHub Pages at a subpath. Vite base must be '/airgap/'.
