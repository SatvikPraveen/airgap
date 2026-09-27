import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * `import b64 from 'pkg/codec.wasm?b64'` -> a module exporting the file as a
 * base64 string. The page CSP has connect-src 'none', which forbids fetching
 * a .wasm file even from our own origin, so WebAssembly payloads travel
 * inside lazily imported script chunks (script-src 'self') instead.
 */
export function wasmBase64(): Plugin {
  const SUFFIX = '?b64';
  return {
    name: 'airgap-wasm-base64',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!id.endsWith(SUFFIX)) return null;
      const r = await this.resolve(id.slice(0, -SUFFIX.length), importer, { skipSelf: true });
      return r ? r.id + SUFFIX : null;
    },
    async load(id) {
      if (!id.endsWith(SUFFIX)) return null;
      const bytes = await readFile(id.slice(0, -SUFFIX.length));
      return `export default ${JSON.stringify(bytes.toString('base64'))};`;
    },
    // The codec glue also references its .wasm via `new URL(..., import.meta.url)`, which
    // makes Vite emit the raw file as an asset. It is never requested (we always hand the
    // glue a compiled module, and the CSP would block the fetch anyway), so drop it.
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) if (name.endsWith('.wasm')) delete bundle[name];
    },
  };
}

// ---------------------------------------------------------------- licences page

const LICENSES_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'";

const LICENSES_CSS = `:root{--bg:#f6f7f9;--panel:#fff;--ink:#1b2430;--muted:#5b6b7c;--line:#d9dee5;--accent:#0b6bcb;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f141a;--panel:#161d26;--ink:#e6ebf1;--muted:#9aa8b8;--line:#2a3441;--accent:#6cb4ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:880px;margin:0 auto;padding:32px 16px 64px}a{color:var(--accent)}h1{font-size:28px;margin:0 0 6px}h2{font-size:18px;margin:32px 0 10px}
p{margin:0 0 12px}table{width:100%;border-collapse:collapse;font-size:14px;margin:0 0 16px}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow:auto;font-size:12.5px;line-height:1.45;white-space:pre-wrap}
.back{display:inline-block;margin-bottom:18px;font-size:14px}.muted{color:var(--muted)}`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Inline markdown: escaped text with **bold**, `code` and [text](url). */
function inline(md: string): string {
  return escapeHtml(md)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
}

/** Just enough markdown for THIRD_PARTY_NOTICES.md: headings, paragraphs, pipe tables. */
function renderNotices(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,3} /.test(line)) {
      flush();
      const level = line.indexOf(' ');
      out.push(`<h${level}>${inline(line.slice(level + 1))}</h${level}>`);
    } else if (line.startsWith('|')) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) {
        const cells = lines[i]!.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      const [head, ...body] = rows;
      out.push('<table><thead><tr>' + head!.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      for (const r of body) out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      out.push('</tbody></table>');
    } else if (line.trim() === '') flush();
    else para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

function buildLicensesHtml(root: string, base: string): string {
  const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const own = readFileSync(join(root, 'LICENSE'), 'utf8');
  const texts = readdirSync(join(root, 'licenses'))
    .sort()
    .map((f) => `<h2 id="${escapeHtml(f)}"><code>licenses/${escapeHtml(f)}</code></h2>\n<pre>${escapeHtml(readFileSync(join(root, 'licenses', f), 'utf8'))}</pre>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${LICENSES_CSP}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>Airgap: licences</title>
<link rel="icon" href="${base}favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="${base}licenses.css" />
</head>
<body>
<main>
<a class="back" href="${base}">&larr; Back to Airgap</a>
${renderNotices(notices).replace(/^<h1>.*<\/h1>/, '<h1>Licences</h1><p class="muted">Airgap and everything bundled into it. Generated from <code>THIRD_PARTY_NOTICES.md</code> at build time.</p>')}
<h2 id="airgap-license">Airgap licence (<code>LICENSE</code>)</h2>
<pre>${escapeHtml(own)}</pre>
${texts}
</main>
</body>
</html>
`;
}

/**
 * Emits `licenses.html` (+ `licenses.css`) into the build, rendered from
 * THIRD_PARTY_NOTICES.md, LICENSE and licenses/*. Also serves them in `vite dev`.
 * The page is plain HTML with its own strict CSP and no scripts.
 */
export function licensesPage(): Plugin {
  let root = process.cwd();
  let base = '/';
  return {
    name: 'airgap-licenses-page',
    configResolved(config) {
      root = config.root;
      base = config.base;
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'licenses.html', source: buildLicensesHtml(root, base) });
      this.emitFile({ type: 'asset', fileName: 'licenses.css', source: LICENSES_CSS });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (url === `${base}licenses.html`) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(buildLicensesHtml(root, base));
        } else if (url === `${base}licenses.css`) {
          res.setHeader('Content-Type', 'text/css; charset=utf-8');
          res.end(LICENSES_CSS);
        } else next();
      });
    },
  };
}
