#!/usr/bin/env bash
# Builds vendor/libavif/airgap_avif.{js,wasm} with Docker. Usage: tools/libavif/build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
docker build -t airgap-libavif "$here"
mkdir -p "$root/vendor/libavif"
id=$(docker create airgap-libavif)
docker cp "$id:/out/." "$root/vendor/libavif/"
docker rm "$id" >/dev/null
cat "$root/vendor/libavif/SHA256SUMS"
