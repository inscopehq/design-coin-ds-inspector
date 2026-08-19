#!/usr/bin/env node
/**
 * Generate the token table the inspector uses for reverse lookup
 * (computed CSS value -> design-system token name).
 *
 *   node gen-tokens.mjs [path/to/tokens.css] > tokens.coin.json
 *
 * Defaults to the Coin colors_and_type.css in ~/disclosure-library.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const src = process.argv[2] || path.join(homedir(), 'disclosure-library', 'colors_and_type.css');
const css = readFileSync(src, 'utf8');

// Pull every :root { ... } block and collect custom properties in order.
const raw = {};
const rootBlocks = css.match(/:root\s*\{[\s\S]*?\n\}/g) || [];
for (const block of rootBlocks) {
  const declRe = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = declRe.exec(block))) raw[m[1]] = m[2].trim().replace(/\s*\/\*[\s\S]*?\*\/\s*/g, '').trim();
}

// Resolve var() chains so --fg-1 lands on a literal value, while remembering the alias path.
const resolved = {};
const aliasOf = {};
function resolve(name, seen = new Set()) {
  if (resolved[name] !== undefined) return resolved[name];
  if (seen.has(name)) return raw[name];
  seen.add(name);
  let v = raw[name];
  if (v === undefined) return undefined;
  const varMatch = v.match(/^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/);
  if (varMatch) {
    aliasOf[name] = varMatch[1];
    v = resolve(varMatch[1], seen) ?? v;
  }
  resolved[name] = v;
  return v;
}
Object.keys(raw).forEach((n) => resolve(n));

function classify(name, value) {
  if (/^--(fs-)/.test(name)) return 'font-size';
  if (/^--(lh-)/.test(name)) return 'line-height';
  if (/^--(fw-)/.test(name)) return 'font-weight';
  if (/^--(tracking-)/.test(name)) return 'letter-spacing';
  if (/^--(font-)/.test(name)) return 'font-family';
  if (/^--(sp-)/.test(name)) return 'spacing';
  if (/^--(radius)/.test(name)) return 'radius';
  if (/^--(shadow)/.test(name)) return 'shadow';
  if (/^--(gradient)/.test(name)) return 'gradient';
  if (/^(#|rgb|hsl)/i.test(value)) return 'color';
  if (/^-?[\d.]+(px|rem|em|%)$/.test(value)) return 'size';
  return 'other';
}

// "--teal-primary-dark" -> "Teal / Primary Dark"; matches how these read in Figma.
function pretty(name) {
  const parts = name.replace(/^--/, '').split('-');
  const head = parts.shift();
  const title = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return parts.length ? `${title(head)} / ${parts.map(title).join(' ')}` : title(head);
}

const tokens = Object.keys(raw).map((name) => ({
  name,
  value: resolved[name],
  raw: raw[name],
  alias: aliasOf[name] || null,
  group: classify(name, resolved[name] || ''),
  label: pretty(name),
}));

process.stdout.write(
  JSON.stringify({ source: src, generated: 'run gen-tokens.mjs to refresh', tokens }, null, 2) + '\n'
);
