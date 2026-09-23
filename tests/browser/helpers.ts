export async function fixtureBytes(name: string): Promise<Uint8Array> {
  const url = new URL(`../fixtures/${name}`, import.meta.url).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Exact per-channel comparison. Returns the first mismatch, or null if identical. */
export function firstMismatch(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): { index: number; a: number; b: number } | null {
  if (a.length !== b.length) return { index: -1, a: a.length, b: b.length };
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return { index: i, a: a[i]!, b: b[i]! };
  }
  return null;
}

export function maxChannelDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > m) m = d;
  }
  return m;
}
