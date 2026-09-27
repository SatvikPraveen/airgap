#!/usr/bin/env node
/**
 * Fails the build if the third-party notices fall out of step with what is
 * actually bundled. Checks:
 *   1. every runtime dependency in package.json is named in THIRD_PARTY_NOTICES.md;
 *   2. every upstream library we know is compiled into the wasm codecs is named;
 *   3. every `licenses/<file>` referenced from the notices exists, and every
 *      file in licenses/ is referenced;
 *   4. the IJG attribution sentence (required by the libjpeg licence for
 *      binary distributions) is present in the notices and in the README.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), 'utf8');
const notices = read('THIRD_PARTY_NOTICES.md');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));

/** Libraries inside the wasm binaries (not visible to npm), plus the glue generators. */
const BUNDLED_UPSTREAMS = ['mozjpeg', 'libjpeg-turbo', 'libwebp', 'libavif', 'libaom', 'libjxl', 'skcms', 'Highway', 'Brotli', 'Emscripten', 'wasm-bindgen', 'image-rs'];
const IJG = 'This software is based in part on the work of the Independent JPEG Group.';

const problems = [];

for (const dep of Object.keys(pkg.dependencies ?? {})) {
  if (!notices.includes(`\`${dep}\``) && !notices.toLowerCase().includes(dep.toLowerCase())) problems.push(`runtime dependency "${dep}" is not listed in THIRD_PARTY_NOTICES.md`);
}
for (const name of BUNDLED_UPSTREAMS) {
  if (!notices.includes(name)) problems.push(`bundled library "${name}" is not listed in THIRD_PARTY_NOTICES.md`);
}

const referenced = new Set([...notices.matchAll(/`licenses\/([^`]+)`/g)].map((m) => m[1]));
for (const f of referenced) if (!existsSync(join(root, 'licenses', f))) problems.push(`THIRD_PARTY_NOTICES.md references licenses/${f}, which does not exist`);
for (const f of readdirSync(join(root, 'licenses'))) if (!referenced.has(f)) problems.push(`licenses/${f} is not referenced from THIRD_PARTY_NOTICES.md`);

if (!notices.includes(IJG)) problems.push('IJG attribution sentence missing from THIRD_PARTY_NOTICES.md');
if (!readme.includes(IJG)) problems.push('IJG attribution sentence missing from README.md');

if (problems.length) {
  console.error('check-notices: FAILED');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`check-notices: ok (${Object.keys(pkg.dependencies ?? {}).length} npm dependencies, ${BUNDLED_UPSTREAMS.length} bundled upstreams, ${referenced.size} licence texts)`);
