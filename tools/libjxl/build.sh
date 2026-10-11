#!/usr/bin/env bash
# Builds vendor/libjxl/airgap_jxl.{js,wasm} with Docker. Usage: tools/libjxl/build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
docker build -t airgap-libjxl "$here"
mkdir -p "$root/vendor/libjxl"
id=$(docker create airgap-libjxl)
docker cp "$id:/out/." "$root/vendor/libjxl/"
docker rm "$id" >/dev/null
cat "$root/vendor/libjxl/SHA256SUMS"
