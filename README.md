# DS Inspector

Click any element in an HTML prototype → see its Coin design-system component,
variant, Figma variable names (`text/primary`, `radius/lg`, `Elevation/Resting`),
deviations from spec, and whether it exists in code (Chromatic story) or only in
design (Figma).

**Live (org members only — sign in with your inscopehq GitHub account):** https://didactic-bassoon-9mw3ykp.pages.github.io/

## Use on any prototype

**Hosted here (recommended):** add your prototype as a folder under
`docs/prototypes/<name>/`, add this line before `</body>`, push — it goes live
on the site behind org sign-in:
```html
<script src="../../ds-inspector.js"></script>
```

**Deployed elsewhere:** copy `dist/ds-inspector.js` next to your HTML and use
`<script src="ds-inspector.js"></script>` — the site's script URL won't load
cross-origin because the site requires GitHub org sign-in.

## Develop
- `node test.mjs` — 74 jsdom checks, must pass
- `node build.mjs` — builds `dist/ds-inspector.js`; copy it to `docs/` to deploy
- `node verify.mjs <prototype.html>` — sweep a prototype for unknown variants / unregistered components
- `node serve.mjs <folder>` — local server that injects the inspector into any .html

`registry.json` is the join table between Figma (Coin), code (Chromatic), and
prototypes. Specs are MEASURED from the Coin Figma file, never hand-written —
see HANDOFF.md and the sync notes before editing.
