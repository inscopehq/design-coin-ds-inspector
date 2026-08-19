/**
 * Registry ↔ prototype accuracy check — run before any handoff:
 *
 *   node verify.mjs <prototype.html> [more.html ...]
 *
 * Statically sweeps every class combination in the file(s), runs each through
 * the inspector's identification pipeline, and reports:
 *
 *   1. UNKNOWN VARIANTS — a recognised component wearing a variant word the
 *      registry doesn't know. Either the registry is stale (re-sync from Coin
 *      via the custom-ds-inspector-sync skill) or the prototype invented a
 *      variant (a design decision to review).
 *   2. UNREGISTERED LOOK-ALIKES — classes that look like a component but are
 *      only guessed. Add a data-ds label, a registry match alias, or ignore
 *      knowingly.
 *
 * Exits 1 when either list is non-empty, so it can gate a handoff.
 * Spec-value deviations need real rendering — that is the in-browser Audit's
 * job, not this script's.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node verify.mjs <prototype.html> [...]'); process.exit(2); }

const inspectJS = readFileSync(path.join(HERE, 'inspect.js'), 'utf8');
const tokens = JSON.parse(readFileSync(path.join(HERE, 'tokens.coin.json'), 'utf8'));
const registry = JSON.parse(readFileSync(path.join(HERE, 'registry.json'), 'utf8'));

// Every distinct class combination used anywhere in the files, template
// expressions stripped, deduped by token set.
const combos = new Map();
for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  for (const m of raw.matchAll(/class="([^"]*)"/g)) {
    const toks = m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)
      .filter((t) => /^[a-zA-Z][\w-]*$/.test(t));
    if (!toks.length) continue;
    combos.set([...toks].sort().join(' '), toks);
  }
}

const TAG_FOR = (toks) => {
  const s = toks.join(' ');
  if (/(^| )(btn|button|iconbtn|dx-tbtn)/.test(s)) return 'button';
  if (/(^| )input( |$)/.test(s)) return 'input';
  if (/(^| )select( |$)/.test(s) && !/select--kv/.test(s)) return 'select';
  if (/table/.test(s)) return 'table';
  return 'div';
};

const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
const body = Array.from(combos.values()).map((toks, i) =>
  `<${TAG_FOR(toks)} id="v${i}" class="${toks.join(' ')}">x</${TAG_FOR(toks)}>`).join('\n');
const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`,
  { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'http://verify/' });
const w = dom.window;
w.__DSI_TOKENS = tokens;
w.__DSI_REGISTRY = registry;
const s = w.document.createElement('script');
s.textContent = inspectJS;
w.document.body.append(s);
await new Promise((r) => setTimeout(r, 200));

// Class names the registry already claims — used to recognise a component's
// INTERNAL parts (avatar__mono, modal-overlay, menu-wrap) so they don't get
// reported as unregistered components.
const regClasses = new Set();
for (const c of registry.components) {
  for (const sel of [].concat(c.match || [])) {
    for (const m of String(sel).matchAll(/\.([a-zA-Z0-9_-]+)/g)) regClasses.add(m[1]);
  }
}
const isInternalOf = (tok) => {
  const block = tok.split(/--|__/)[0];
  if (regClasses.has(block)) return true;
  for (const r of regClasses) if (block.startsWith(r + '-')) return true;
  return false;
};

let mapped = 0;
const unknownVariants = [];
const lookalikes = new Map();
Array.from(combos.values()).forEach((toks, i) => {
  const el = w.document.getElementById(`v${i}`);
  let spec;
  try { spec = w.__DSI.buildSpec(el); } catch { return; }
  const c = spec.component;
  if (c.confidence === 'mapped' || c.confidence === 'declared') {
    mapped++;
    if (spec.spec && spec.spec.unknownVariant) {
      unknownVariants.push({ component: c.name, modifier: spec.spec.unknownVariant, classes: toks.join(' ') });
    }
  } else if (c.confidence === 'inferred' && c.name) {
    if (isInternalOf(toks[0])) return; // a registered component's own part
    const block = toks[0].split(/--|__/)[0];
    if (!lookalikes.has(block)) lookalikes.set(block, c.name);
  }
});

console.log(`\nSwept ${combos.size} class combinations across ${files.length} file(s) — ${mapped} map to registered components.\n`);
if (unknownVariants.length) {
  console.log('UNKNOWN VARIANTS (stale registry, or a variant the prototype invented):');
  const seen = new Set();
  for (const u of unknownVariants) {
    const k = `${u.component}|${u.modifier}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  ✗ ${u.component} · "${u.modifier}"   (e.g. class="${u.classes}")`);
  }
  console.log('');
}
if (lookalikes.size) {
  console.log('UNREGISTERED LOOK-ALIKES (guessed, not checked — label or register):');
  for (const [block, guess] of lookalikes) console.log(`  ? .${block} → looks like ${guess}`);
  console.log('');
}
if (!unknownVariants.length && !lookalikes.size) console.log('✓ Clean — every component class is registered and every variant is known.\n');
process.exit(unknownVariants.length || lookalikes.size ? 1 : 0);
