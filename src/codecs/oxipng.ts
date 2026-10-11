/**
 * oxipng (single-threaded wasm build from @jsquash/oxipng) as an optional
 * post-processing step for PNG output. It only rewrites how the PNG is stored
 * (filters, deflate, colour type, bit depth); convert() keeps its output only
 * after decoding it to the same pixels and finding the same metadata.
 */
import { compileWasm } from './wasm/shared';

type Glue = typeof import('@jsquash/oxipng/codec/pkg/squoosh_oxipng.js');

let gluePromise: Promise<Glue> | undefined;
function loadGlue(): Promise<Glue> {
  return (gluePromise ??= Promise.all([import('@jsquash/oxipng/codec/pkg/squoosh_oxipng.js'), import('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm?b64')]).then(async ([glue, { default: b64 }]) => {
    glue.initSync(await compileWasm(b64)); // a compiled module: no fetch
    return glue;
  }));
}

/** oxipng preset 2 (its default). optimize_alpha stays OFF: it would rewrite the colour under alpha 0. */
export const OXIPNG_LEVEL = 2;

export async function optimisePng(bytes: Uint8Array): Promise<Uint8Array> {
  const glue = await loadGlue();
  return glue.optimise(bytes, OXIPNG_LEVEL, false, false);
}
