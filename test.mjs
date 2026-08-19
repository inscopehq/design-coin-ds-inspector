/**
 * Headless smoke test — loads inspect.js into jsdom against a fixture that
 * mixes on-system and off-system styling, then drives a click and reads back
 * what the panel produced.
 *
 *   node test.mjs
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const inspectJS = readFileSync(path.join(HERE, 'inspect.js'), 'utf8');
const tokens = JSON.parse(readFileSync(path.join(HERE, 'tokens.coin.json'), 'utf8'));
const registry = JSON.parse(readFileSync(path.join(HERE, 'registry.json'), 'utf8'));
// Simulate a component that exists in code: Button gets a Storybook story.
const regButton = registry.components.find((c) => c.name === 'Button');
regButton.story = 'https://example--app.chromatic.com/?path=/story/button--default';
// Pin the spec to the fixture's own values — these tests exercise the checking
// mechanism, not the live Coin numbers (which the real registry now carries).
const pinnedSpec = {
  'background-color': '--teal-primary',
  color: '--white',
  'border-radius': '--radius-sm',
  'font-size': '--fs-body',
  'font-weight': '--fw-semibold',
};
regButton.variants = { Default: pinnedSpec, Primary: pinnedSpec };

const fixture = `<!doctype html><html><head><style>
  :root { --teal-primary:#34A290; --fg-1:#0F1E24; --sp-s:12px; --radius-sm:5px; --fs-body:14px; }
  .btn { background: var(--teal-primary); color: #FFFFFF; padding: var(--sp-s) 16px;
         border-radius: var(--radius-sm); font-size: var(--fs-body); font-weight: 600; border: 0; }
  .btn--ghost { background: #F2F4F4; color: #0F1E24; }
  #typ { font-family: Geist; font-size: 14px; font-weight: 500; line-height: 20px; }
  .hoverable { background: #FFFFFF; }
  .hoverable:hover { background: #2C8A7B; }
  .wrong { background: #2E9184; border-radius: 9px; }   /* nearly-right teal, wrong radius */
  .kpi-label { color: #6A7370; font-size: 13px; padding: 7px; }
  .card { background:#fff; border:1px solid #E1E5E4; border-radius:12px; padding:16px; display:flex; gap:12px; }
  #figbox { background:#FFFFFF; color:#5C5C5C; border:1px solid #E4E4E4; border-radius:10px;
            padding:24px; box-shadow: rgba(0,0,0,0.08) 0px 1px 3px 0px, rgba(0,0,0,0.06) 0px 0px 1px 0px; }
</style></head><body>
  <div class="card">
    <button class="btn btn--primary" data-ds="Button" data-ds-variant="Primary" data-ds-size="Medium">
      <svg class="icon" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg> Save
    </button>
    <button class="btn btn--ghost">Cancel</button>
    <button class="btn btn--sm" id="sized">Small</button>
    <div class="wiz-step" id="localcomp">Step</div>
    <button class="hoverable" id="hov">Hover me</button>
    <p id="typ">Total engagements this year</p>
    <button class="btn wrong" id="wrong" data-ds="Button" data-ds-variant="Primary" style="margin-top: 3px">Off-spec</button>
    <span class="kpi-label">Total engagements</span>
    <button class="select select--kv"><span class="select__k" id="selk">Status</span> All</button>
    <div id="figbox"><i>x</i></div>
  </div>
</body></html>`;

const vc = new VirtualConsole();
const logs = [];
vc.on('log', (...a) => logs.push(a.join(' ')));
vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) console.error('jsdom error:', e.message); });

const dom = new JSDOM(fixture, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/test.html' });
const { window } = dom;
window.__DSI_TOKENS = tokens;
window.__DSI_REGISTRY = registry;
// A page-local registry extension (how a single-file-build prototype adds
// its own components without a rebuild).
window.__DSI_REGISTRY_LOCAL = { components: [{ name: 'Wizard step', match: ['.wiz-step'], library: 'EWS v0' }] };

const s = window.document.createElement('script');
s.textContent = inspectJS;
window.document.body.append(s);

// The inspector boots on DOMContentLoaded; jsdom fires that after construction.
await new Promise((r) => {
  if (window.document.readyState !== 'loading') return r();
  window.document.addEventListener('DOMContentLoaded', r);
  setTimeout(r, 2000);
});

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
};

console.log('\nBoot');
check('inspector loaded', logs.some((l) => l.includes('DS Inspector')), logs.join(' | '));
check('panel mounted in shadow DOM', !!window.document.querySelector('[data-dsi-ui="panel"]')?.shadowRoot);

// Reach the internals the way a user does: click, then read the panel.
const click = (el) => {
  const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
};
const panelText = () => window.document.querySelector('[data-dsi-ui="panel"]').shadowRoot.textContent;

console.log('\nDeclared component (data-ds)');
click(window.document.querySelector('[data-ds="Button"]'));
let txt = panelText();
check('shows component name', txt.includes('Button'));
check('marked as declared', window.__DSI.buildSpec(window.document.querySelector('[data-ds="Button"]')).component.confidence === 'declared');
check('shows declared variant', txt.includes('Primary'), txt.slice(0, 200));
check('shows declared size', txt.includes('Medium'));
check('resolves authored var to token', txt.includes('--teal-primary'), 'expected --teal-primary in panel');
check('maps spacing token', txt.includes('--sp-s') || txt.includes('--sp'), 'expected a --sp-* token');
check('maps radius token', txt.includes('--radius-sm'));
check('lists matched CSS', txt.includes('CSS rules'));
check('says where it came from in plain words', txt.includes('From the design system'));
check('uses plain property names, not CSS', txt.includes('Corner radius') && txt.includes('Text size'));

console.log('\nUndeclared component, matched by registry selector');
click(window.document.querySelector('.btn--ghost'));
txt = panelText();
check('resolves Button from registry', txt.includes('Button'));
check('treats a registry match as design-system', txt.includes('From the design system'));
check('detects BEM modifier as variant', txt.includes('ghost'));

console.log('\nUndeclared component, heuristic only (not in registry)');
const guessSpec = window.__DSI.buildSpec(window.document.querySelector('.kpi-label'));
check('guesses Stat from .kpi class', guessSpec.component.name === 'Stat', guessSpec.component.name);
check('flags as inferred', guessSpec.component.confidence === 'inferred', guessSpec.component.confidence);
click(window.document.querySelector('.kpi-label'));
check('panel suggests data-ds annotation', panelText().includes('data-ds'));

console.log('\nOff-system value detection');
click(window.document.querySelector('.kpi-label'));
txt = panelText();
check('flags off-system colour', txt.includes('off-system'), txt.slice(0, 400));
check('suggests nearest token', /nearest/.test(txt));

console.log('\nDeviation from the component spec');
// .btn--primary declares Primary but paints itself the wrong teal.
const off = window.document.querySelector('#wrong');
const offSpec = window.__DSI.buildSpec(off);
check('finds the Button spec', !!offSpec.spec && offSpec.spec.variant === 'Primary', JSON.stringify(offSpec.spec));
check('reports the wrong background', offSpec.spec.diffs.some((d) => d.prop === 'background-color'), JSON.stringify(offSpec.spec?.diffs));
check('names the token it should be', offSpec.spec.diffs.some((d) => d.token === '--teal-primary'));
click(off);
txt = panelText();
check('panel says it deviates', txt.includes('Deviates from the Button spec'), txt.slice(0, 200));
check('panel phrases it as should be', txt.includes('should be'));

console.log('\nFigma vocabulary — values resolve to variable/style names');
const figSpec = window.__DSI.buildSpec(window.document.querySelector('#figbox'));
const figOf = (prop) => (figSpec.props.find((p) => p.prop === prop) || {}).figma;
check('text colour resolves to text/*', figOf('color') === 'text/secondary', figOf('color'));
check('border resolves to border/*', figOf('border-top-color') === 'border/subtle', figOf('border-top-color'));
check('radius resolves to radius/*', figOf('border-radius') === 'radius/lg', figOf('border-radius'));
check('padding resolves to spacing/*', figOf('padding-top') === 'spacing/24', figOf('padding-top'));
check('shadow resolves to a named Elevation style', figOf('box-shadow') === 'Elevation/Resting', figOf('box-shadow'));
check('figma-named values are not off-system', !figSpec.props.some((p) => p.offSystem && p.figma), JSON.stringify(figSpec.props.filter((p) => p.offSystem).map((p) => p.prop)));

console.log('\nBEM children are parts, not component guesses');
const partSpec = window.__DSI.buildSpec(window.document.querySelector('#selk'));
check('select__k belongs to Filter Trigger', partSpec.component.partOf === 'Filter Trigger', JSON.stringify(partSpec.component));
check('never guessed as a separate Select', !(partSpec.component.confidence === 'inferred'), partSpec.component.confidence);
click(window.document.querySelector('#selk'));
check('panel says whose part it is', panelText().includes('Filter Trigger'));

console.log('\nText is a typography instance, not an unlabelled component');
const typSpec = window.__DSI.buildSpec(window.document.querySelector('#typ'));
check('bare text identifies as a type-style instance', typSpec.component.confidence === 'text', typSpec.component.confidence);
check('matches the Coin type style', typSpec.component.typeStyle && typSpec.component.typeStyle.name === 'Label/Default', JSON.stringify(typSpec.component.typeStyle));
click(window.document.querySelector('#typ'));
txt = panelText();
check('panel names the type style', txt.includes('Label/Default'));
check('panel confirms the typography match', txt.includes('Matches the Label/Default type style'), txt.slice(0, 300));
check('panel does not nag about data-ds for text', !txt.includes('Not labelled as a component'));

console.log('\nTransient UI (open menus) survives inspection');
// A prototype-style "any click closes the menu" handler.
let menuClosed = 0;
window.document.addEventListener('mousedown', () => menuClosed++);
window.document.addEventListener('click', () => menuClosed++);
// Pause, then Alt+click an element: the page must never see the events.
window.__DSI.setMode(false);
const target = window.document.querySelector('.btn--ghost');
target.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, altKey: true }));
target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
check('alt+click while paused is shielded from the page', menuClosed === 0, `page saw ${menuClosed} events`);
check('alt+click while paused still selects', panelText().includes('Ghost') || panelText().includes('Button'));
// Clicking the panel itself must not count as a page click either.
window.__DSI.setMode(true);
const panelHost = window.document.querySelector('[data-dsi-ui="panel"]');
menuClosed = 0;
panelHost.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
panelHost.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
check('panel clicks never reach the prototype', menuClosed === 0, `page saw ${menuClosed} events`);

console.log('\nPage-local registry extension');
const localSpec = window.__DSI.buildSpec(window.document.querySelector('#localcomp'));
check('local component recognised via __DSI_REGISTRY_LOCAL', localSpec.component.name === 'Wizard step' && localSpec.component.confidence === 'mapped', JSON.stringify(localSpec.component));

console.log('\nSize modifiers are not variants');
const sized = window.__DSI.buildSpec(window.document.querySelector('#sized'));
check('btn--sm falls back to the Default spec', sized.spec && sized.spec.variant === 'Default', JSON.stringify(sized.spec));
check('no unknown-variant for a size modifier', !sized.spec.unknownVariant);

console.log('\nChanges on top of the design system');
check('detects the bolt-on class as a change', offSpec.overrides.some((o) => o.from.includes('.wrong')), JSON.stringify(offSpec.overrides));
check('records what the base component says', offSpec.overrides.some((o) => o.base && o.base.includes('--teal-primary')));
check('detects the inline style as a change', offSpec.overrides.some((o) => o.from === 'inline style' && o.value === '3px'));
click(off);
txt = panelText();
check('panel shows the changes-on-top section', txt.includes('on top of Button'), txt.slice(0, 300));
check('panel names the source selector', txt.includes('.wrong'));

console.log('\nDesign-system provenance');
check('panel links to Figma', txt.includes('Figma ↗'));
check('panel shows the library path', txt.includes('Coin design system'));
check('in-code component says use the real one', txt.includes('In code — use the real component'), txt.slice(0, 400));
check('in-code component links to Storybook', txt.includes('Storybook ↗'));

console.log('\nInteractions');
const hovSpec = window.__DSI.buildSpec(window.document.querySelector('#hov'));
check('reads hover styles from the CSS', hovSpec.interactions.some((g) => g.state === 'hover' && g.changes.some((c) => /2C8A7B|44, 138, 123/i.test(c.to))), JSON.stringify(hovSpec.interactions));
click(window.document.querySelector('#hov'));
check('panel shows the hover state', panelText().includes('On hover'));
click(window.document.querySelector('svg.icon'));
txt = panelText();
check('design-only component says not in code yet', txt.includes('In design, not in code yet'), txt.slice(0, 300));

console.log('\nMatching the component spec');
const rightSpec = window.__DSI.buildSpec(window.document.querySelector('[data-ds="Button"]'));
check('no differences on a correct button', rightSpec.spec && rightSpec.spec.diffs.length === 0, JSON.stringify(rightSpec.spec?.diffs));
check('no changes-on-top on a correct button', rightSpec.overrides.length === 0, JSON.stringify(rightSpec.overrides));
click(window.document.querySelector('[data-ds="Button"]'));
check('panel confirms the match', panelText().includes('Matches the Button spec'));

console.log('\nComposition');
const cardSpec = window.__DSI.buildSpec(window.document.querySelector('.card'));
check('card knows what it is made of', cardSpec.madeOf.length >= 3, JSON.stringify(cardSpec.madeOf.map((m) => m.name)));
check('finds the nested Buttons', cardSpec.madeOf.filter((m) => m.name === 'Button').length >= 2);
check('finds the Icon inside the Button', cardSpec.madeOf.some((m) => m.name === 'Icon' && m.depth === 1), JSON.stringify(cardSpec.madeOf));
check('button reports its own Icon', rightSpec.madeOf.some((m) => m.name === 'Icon'));
click(window.document.querySelector('.card'));
check('panel lists the composition', panelText().includes('Made of'));

console.log('\nContainment');
check('button knows it sits inside the Card', rightSpec.insideOf.some((x) => x.name === 'Card'), JSON.stringify(rightSpec.insideOf));

console.log('\nPage audit');
const shadow = window.document.querySelector('[data-dsi-ui="panel"]').shadowRoot;
const auditBtn = Array.from(shadow.querySelectorAll('button')).find((b) => b.textContent === 'Audit');
check('audit button present', !!auditBtn);
auditBtn?.click();
await new Promise((r) => setTimeout(r, 400)); // renderAudit waits for frame replies
txt = panelText();
check('reports coverage %', /on-system/.test(txt), txt.slice(0, 300));
check('lists off-system colours', /Off-system colours/.test(txt));
check('lists undeclared components', /Undeclared components/.test(txt));
const occBtns = Array.from(shadow.querySelectorAll('.occbtn'));
check('findings show which component they are on', occBtns.length > 0, `${occBtns.length} occurrence chips`);
occBtns[0]?.click();
check('clicking a finding selects the offending element', !panelText().includes('Handoff audit'), panelText().slice(0, 120));

console.log('\nMarkdown export');
let copied = '';
window.navigator.clipboard = { writeText: (t) => { copied = t; return Promise.resolve(); } };
click(window.document.querySelector('[data-ds="Button"]'));
Array.from(shadow.querySelectorAll('button')).find((b) => b.textContent === '⤓')?.click();
check('produces markdown spec', copied.includes('| Property | Value | Token |'), copied.slice(0, 200));
check('markdown names the component', copied.includes('Button'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
