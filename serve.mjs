#!/usr/bin/env node
/**
 * Serve any prototype folder with the DS Inspector injected — no edits to
 * your HTML files.
 *
 *   node ~/ds-inspector/serve.mjs                      # serves cwd
 *   node ~/ds-inspector/serve.mjs "~/Desktop/Design Prototypes"
 *   node ~/ds-inspector/serve.mjs . --port 7799
 *   node ~/ds-inspector/serve.mjs . --no-inject        # plain static server
 */
import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const portFlag = argv.indexOf('--port');
const PORT = portFlag > -1 ? Number(argv[portFlag + 1]) : 7788;
const INJECT = !flags.has('--no-inject');

let ROOT = positional[0] || process.cwd();
if (ROOT.startsWith('~')) ROOT = path.join(homedir(), ROOT.slice(1));
ROOT = path.resolve(ROOT);
// If pointed at a file, serve its folder and open that file.
let ENTRY = null;
if (existsSync(ROOT) && (await stat(ROOT)).isFile()) { ENTRY = path.basename(ROOT); ROOT = path.dirname(ROOT); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};

const readJSON = (f) => { try { return JSON.parse(readFileSync(path.join(HERE, f), 'utf8')); } catch { return null; } };

// A prototype folder (or any of its parents up to the served root) can ship
// its own ds-tokens.json / ds-registry.json.
const findUp = (startDir, file) => {
  let dir = startDir || ROOT;
  while (dir && dir.startsWith(ROOT)) {
    const p = path.join(dir, file);
    if (existsSync(p)) return p;
    if (dir === ROOT) break;
    dir = path.dirname(dir);
  }
  return null;
};

const tokensFor = (fromDir) => {
  const local = findUp(fromDir, 'ds-tokens.json');
  if (local) { try { return JSON.parse(readFileSync(local, 'utf8')); } catch {} }
  return readJSON('tokens.coin.json');
};
const registryFor = (fromDir) => {
  // A project's ds-registry.json EXTENDS the central registry: same-name
  // entries override field-by-field, new names are appended. A project never
  // has to copy (and let drift) the whole Coin registry to add its own pieces.
  const central = readJSON('registry.json') || { components: [] };
  const local = findUp(fromDir, 'ds-registry.json');
  if (!local) return central;
  try {
    const extra = JSON.parse(readFileSync(local, 'utf8'));
    const byName = new Map((central.components || []).map((c) => [c.name, c]));
    for (const c of extra.components || []) byName.set(c.name, { ...(byName.get(c.name) || {}), ...c });
    return { ...central, ...extra, components: Array.from(byName.values()) };
  } catch { return central; }
};

function injectInto(html, fromDir) {
  const boot = `
<!-- DS Inspector (injected by serve.mjs — not part of your file) -->
<script>window.__DSI_TOKENS=${JSON.stringify(tokensFor(fromDir))};window.__DSI_REGISTRY=${JSON.stringify(registryFor(fromDir))};</script>
<script src="/__dsi/inspect.js"></script>
`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${boot}</body>`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${boot}</html>`);
  return html + boot;
}

async function listing(dirAbs, urlPath) {
  const entries = await readdir(dirAbs, { withFileTypes: true });
  const rows = entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    .map((e) => {
      const href = path.posix.join(urlPath, encodeURIComponent(e.name)) + (e.isDirectory() ? '/' : '');
      const isHtml = /\.html?$/i.test(e.name);
      return `<li class="${e.isDirectory() ? 'dir' : isHtml ? 'html' : 'file'}"><a href="${href}">${e.isDirectory() ? '📁' : isHtml ? '🔎' : '·'} ${e.name}</a></li>`;
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>DS Inspector — ${urlPath}</title>
<style>
 body{font:14px/1.6 ui-sans-serif,-apple-system,Inter,system-ui;background:#0F1E24;color:#E1E5E4;margin:0;padding:32px 40px}
 h1{font-size:15px;font-weight:600;color:#9AA7A6;margin:0 0 4px}
 .p{font-size:12px;color:#67716E;margin:0 0 20px}
 ul{list-style:none;padding:0;margin:0;max-width:760px}
 li{border-bottom:1px solid #1d3138}
 a{display:block;padding:8px 6px;color:#CDD3D3;text-decoration:none;border-radius:4px}
 a:hover{background:#17282e;color:#fff}
 li.html a{color:#5ED0BB}
</style>
<h1>${urlPath}</h1><p class="p">Click an .html file — the inspector loads with it. Files marked 🔎 are inspectable.</p>
<ul>${urlPath !== '/' ? '<li class="dir"><a href="../">📁 ..</a></li>' : ''}${rows}</ul>`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/__dsi/inspect.js') {
      const js = await readFile(path.join(HERE, 'inspect.js'));
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      return res.end(js);
    }

    const abs = path.join(ROOT, pathname);
    if (!abs.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

    let st;
    try { st = await stat(abs); } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end(`Not found: ${pathname}`); }

    if (st.isDirectory()) {
      for (const idx of ['index.html', 'index.htm']) {
        if (existsSync(path.join(abs, idx))) {
          const html = await readFile(path.join(abs, idx), 'utf8');
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
          return res.end(INJECT ? injectInto(html, abs) : html);
        }
      }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(await listing(abs, pathname.endsWith('/') ? pathname : pathname + '/'));
    }

    const ext = path.extname(abs).toLowerCase();
    if (INJECT && (ext === '.html' || ext === '.htm')) {
      const html = await readFile(abs, 'utf8');
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(injectInto(html, path.dirname(abs)));
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(await readFile(abs));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String(err && err.stack || err));
  }
});

server.listen(PORT, () => {
  const t = tokensFor();
  const url = `http://localhost:${PORT}/${ENTRY ? encodeURIComponent(ENTRY) : ''}`;
  console.log(`\n  DS Inspector`);
  console.log(`  root     ${ROOT}`);
  console.log(`  tokens   ${t ? t.tokens.length : 0} loaded${INJECT ? '' : '  (injection OFF)'}`);
  console.log(`  open     ${url}\n`);
});
