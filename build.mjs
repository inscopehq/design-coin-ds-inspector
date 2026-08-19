#!/usr/bin/env node
/**
 * Bundle the inspector, the tokens and the component registry into ONE file
 * that any prototype can include with a single <script> tag — no server, works
 * straight off the file system.
 *
 *   node build.mjs            ->  dist/ds-inspector.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(HERE, f), 'utf8');

const tokens = JSON.parse(read('tokens.coin.json'));
const registry = JSON.parse(read('registry.json'));
const inspect = read('inspect.js');

const out = `/* DS Inspector — single-file build.
 * Include in any prototype:  <script src="ds-inspector.js"></script>
 * Contains ${tokens.tokens.length} design tokens and ${registry.components.length} component definitions.
 * Rebuild with: node build.mjs
 */
window.__DSI_TOKENS = ${JSON.stringify(tokens)};
window.__DSI_REGISTRY = ${JSON.stringify(registry)};
${inspect}
`;

mkdirSync(path.join(HERE, 'dist'), { recursive: true });
const dest = path.join(HERE, 'dist', 'ds-inspector.js');
writeFileSync(dest, out);
console.log(`${dest}  ${(out.length / 1024).toFixed(0)} KB  · ${tokens.tokens.length} tokens · ${registry.components.length} components`);
