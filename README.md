# DS Inspector

Click any element in an HTML prototype → see its Coin design-system component,
variant, Figma variable names (`text/primary`, `radius/lg`, `Elevation/Resting`),
deviations from spec, and whether it exists in code (Chromatic story) or only in
design (Figma).

**Live:** https://inscopehq.github.io/design-coin-ds-inspector/

## Use on any prototype
```html
<script src="https://inscopehq.github.io/design-coin-ds-inspector/ds-inspector.js"></script>
```
Add that line before `</body>` — done. Or host the prototype on this site: drop
its folder under `docs/prototypes/<name>/` (script src `../../ds-inspector.js`)
and push.

## Develop
- `node test.mjs` — 74 jsdom checks, must pass
- `node build.mjs` — builds `dist/ds-inspector.js`; copy it to `docs/` to deploy
- `node verify.mjs <prototype.html>` — sweep a prototype for unknown variants / unregistered components
- `node serve.mjs <folder>` — local server that injects the inspector into any .html

`registry.json` is the join table between Figma (Coin), code (Chromatic), and
prototypes. Specs are MEASURED from the Coin Figma file, never hand-written —
see HANDOFF.md and the sync notes before editing.
