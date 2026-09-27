#!/usr/bin/env node
/**
 * Writes dist/checksums.txt: the SHA-256 of every file in dist/, in the
 * `sha256sum -c` format. The deploy workflow attests this one file with
 * GitHub build provenance, so anyone can verify that what GitHub Pages
 * serves is exactly what the workflow built from a given commit:
 *
 *   gh attestation verify checksums.txt --repo SatvikPraveen/airgap
 *   sha256sum -c checksums.txt            # against files fetched from the site
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const lines = [];
for (const file of walk(dist)) {
  const rel = relative(dist, file);
  if (rel === 'checksums.txt') continue;
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  lines.push(`${hash}  ${rel}`);
}
writeFileSync(join(dist, 'checksums.txt'), lines.join('\n') + '\n');
console.log(`checksums.txt: ${lines.length} files`);
