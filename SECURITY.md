# Security policy

Airgap's central promise is that image bytes never leave the user's device.
Anything that could break that promise is treated as a security issue,
whether or not it involves a conventional vulnerability.

## What to report

- Any path by which image bytes, metadata or derived data could be sent off
  the device: a network request, a beacon, a remote asset, a weakened
  Content-Security-Policy, or a worker that escapes the page's policy.
- Script injection through crafted image files or metadata, for example an
  EXIF or XMP value that reaches the DOM unescaped.
- A crafted file that makes a codec read or write out of bounds in a way that
  goes beyond a crash of the conversion worker.
- A build or supply-chain problem: a bundled file that does not match its
  published checksum, or a vendored codec that does not rebuild from
  `tools/` byte for byte.

A file that merely fails to convert, or makes the worker run out of memory, is
an ordinary bug. Please open a normal issue for those.

## How to report

Use GitHub's private vulnerability reporting:
**Security** tab, then **Report a vulnerability**. Please include the browser
and version, and the file or steps that reproduce the problem. Do not attach
personal photos; a generated image that shows the issue is enough.

You can expect an acknowledgement within a week. A confirmed leak of image
data blocks every deployment until it is fixed.

## Supported versions

Only the latest release and the live site at
https://satvikpraveen.github.io/airgap/ receive fixes.

## Verifying a deployment

Each deployment publishes `checksums.txt` with a GitHub build provenance
attestation. To check that the files you were served came from this
repository's workflow:

```sh
gh attestation verify checksums.txt --repo SatvikPraveen/airgap
```
