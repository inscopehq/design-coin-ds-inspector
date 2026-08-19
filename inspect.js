/* =========================================================================
   DS Inspector — click any element in an HTML prototype, see which design
   system component / variant / tokens it is using.

   Runs in every same-origin frame. The top frame owns the panel; child
   frames (incl. srcdoc iframes) act as probes and post specs upward.
   ========================================================================= */
(() => {
  if (window.__DSI_LOADED__) return;
  window.__DSI_LOADED__ = true;

  const IS_TOP = (() => { try { return window.top === window; } catch { return false; } })();
  const SELF_SRC = (document.currentScript && document.currentScript.src) || '';
  const BASE = SELF_SRC.replace(/\/inspect\.js.*$/, '');

  /* ---------------------------------------------------------------- utils */
  const $ = (t, props = {}, kids = []) => {
    const el = document.createElement(t);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    (Array.isArray(kids) ? kids : [kids]).forEach((k) => k && el.append(k));
    return el;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ------------------------------------------------------- token indexing */
  // Normalise any CSS value into a comparable string. Colours go through the
  // browser so #34A290 / rgb(52,162,144) / var chains all collapse to one form.
  const normProbe = document.createElement('span');
  normProbe.style.display = 'none';
  const normCache = new Map();
  function normColor(v) {
    if (!v) return '';
    if (normCache.has(v)) return normCache.get(v);
    let out = v;
    try {
      normProbe.style.color = '';
      normProbe.style.color = v;
      if (normProbe.style.color) {
        (document.body || document.documentElement).append(normProbe);
        out = getComputedStyle(normProbe).color || v;
        normProbe.remove();
      }
    } catch { /* not a colour */ }
    normCache.set(v, out);
    return out;
  }
  const normLen = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();

  const Tokens = {
    list: [],          // {name, value, alias, group, label, norm, rgb}
    byNorm: new Map(), // normalised value -> [tokens]
    add(tok) {
      const isColor = tok.group === 'color' || /^(#|rgb|hsl)/i.test(tok.value || '');
      const norm = isColor ? normColor(tok.value) : normLen(tok.value);
      if (!norm) return;
      const rec = { ...tok, norm, rgb: isColor ? parseRGB(norm) : null };
      this.list.push(rec);
      if (!this.byNorm.has(norm)) this.byNorm.set(norm, []);
      this.byNorm.get(norm).push(rec);
    },
    match(value, group) {
      const isColor = /^(rgb|#|hsl)/i.test(String(value).trim());
      const key = isColor ? normColor(value) : normLen(value);
      const hits = this.byNorm.get(key) || [];
      if (!hits.length) return null;
      // Prefer a token from the expected group, then a semantic alias
      // (--fg-1) over the raw ramp entry (--black-100) it points at.
      const inGroup = group ? hits.filter((h) => h.group === group) : [];
      const pool = inGroup.length ? inGroup : hits;
      return pool.find((h) => h.alias) || pool[0];
    },
    nearestColor(value) {
      const rgb = parseRGB(normColor(value));
      if (!rgb) return null;
      let best = null;
      for (const t of this.list) {
        if (!t.rgb) continue;
        const d = Math.sqrt(
          (t.rgb[0] - rgb[0]) ** 2 + (t.rgb[1] - rgb[1]) ** 2 + (t.rgb[2] - rgb[2]) ** 2
        );
        if (!best || d < best.dist) best = { token: t, dist: d };
      }
      return best;
    },
  };
  function parseRGB(s) {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return p.length >= 3 ? [p[0], p[1], p[2]] : null;
  }

  // 1) Bundled design-system table (injected by the server as __DSI_TOKENS).
  // 2) Custom properties actually declared on :root in this page's stylesheets
  //    — so a prototype defining its own tokens is inspected against those too.
  function buildTokenIndex() {
    const bundled = (window.__DSI_TOKENS && window.__DSI_TOKENS.tokens) || [];
    bundled.forEach((t) => Tokens.add({ ...t, origin: 'design-system' }));

    const local = {};
    forEachRule((rule) => {
      if (!(rule.style && rule.selectorText)) return;
      if (!/(^|,)\s*(:root|html|body)\s*(,|$)/.test(rule.selectorText)) return;
      for (const prop of rule.style) {
        if (prop.startsWith('--')) local[prop] = rule.style.getPropertyValue(prop).trim();
      }
    });
    const rootStyle = getComputedStyle(document.documentElement);
    const seen = new Set(bundled.map((t) => t.name));
    for (const [name, rawVal] of Object.entries(local)) {
      if (seen.has(name)) continue;
      let value = rawVal;
      if (/var\(/.test(value)) value = rootStyle.getPropertyValue(name).trim() || value;
      Tokens.add({
        name, value, alias: null, origin: 'page',
        group: /color|bg|fg|border|shadow/i.test(name) || /^(#|rgb)/i.test(value) ? 'color' : 'other',
        label: name.replace(/^--/, ''),
      });
    }
  }

  /* -------------------------------------------------- Figma vocabulary */
  // Coin's Figma variables and effect styles — so every value the panel shows
  // resolves to the NAME a developer sees in Figma dev mode (text/primary,
  // border/subtle, radius/lg, Elevation/Resting), without opening Figma.
  const FIGVARS = (window.__DSI_REGISTRY && window.__DSI_REGISTRY.variables) || [];
  const FIGFX = (window.__DSI_REGISTRY && window.__DSI_REGISTRY.effects) || [];
  const FIGCOLORS = new Map(); // normalised colour -> [variable names]

  function buildFigmaIndex() {
    for (const v of FIGVARS) {
      if (v.type !== 'color') continue;
      const k = normColor(v.value);
      if (!FIGCOLORS.has(k)) FIGCOLORS.set(k, []);
      FIGCOLORS.get(k).push(v.name);
    }
  }

  // Pick the variable name a designer would have bound for this property:
  // text colours prefer text/*, backgrounds prefer background/* and */bg,
  // borders prefer border/*; semantic names beat raw ramp entries.
  function figmaColorFor(value, prop) {
    if (!value) return null;
    const list = FIGCOLORS.get(normColor(value));
    if (!list || !list.length) return null;
    const p = String(prop || '');
    const prefs = /background/.test(p) ? ['background/', 'button/', '-bg']
      : /border/.test(p) ? ['border/']
      : /^(color|fill|stroke)$/.test(p) ? ['text/'] : [];
    for (const pref of prefs) {
      const hit = list.find((n) => n.startsWith(pref) || n.endsWith(pref));
      if (hit) return hit;
    }
    return list.find((n) => !/\/\d+$/.test(n)) || list[0];
  }

  function figmaNumberFor(v, prefix) {
    const n = parseFloat(v);
    if (isNaN(n)) return null;
    const hit = FIGVARS.find((x) => x.type === 'number' && x.name.startsWith(prefix) && Math.abs(x.value - n) < 0.01);
    return hit ? hit.name : null;
  }

  // Match a computed box-shadow against the named Elevation styles.
  function splitShadows(s) {
    const out = []; let d = 0, cur = '';
    for (const ch of String(s)) {
      if (ch === '(') d++;
      if (ch === ')') d--;
      if (ch === ',' && !d) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }
  function parseShadow(s) {
    const m = s.match(/rgba?\(([^)]+)\)/);
    const ch = m ? m[1].split(/[,\s/]+/).filter(Boolean) : [];
    const alpha = ch.length >= 4 ? parseFloat(ch[3]) : 1;
    const nums = s.replace(/rgba?\([^)]+\)/, '').match(/-?\d+\.?\d*(px)?/g);
    if (!nums || nums.length < 2) return null;
    const px = nums.map(parseFloat);
    return { x: px[0], y: px[1], blur: px[2] || 0, spread: px[3] || 0, alpha };
  }
  function effectNameFor(css) {
    if (!css || css === 'none' || !FIGFX.length) return null;
    const parsed = splitShadows(css).map(parseShadow).filter(Boolean);
    if (!parsed.length) return null;
    for (const st of FIGFX) {
      const fx = st.effects.filter((e) => !e.inner);
      if (fx.length !== parsed.length) continue;
      const ok = fx.every((e) => parsed.some((sh) =>
        Math.abs(sh.x - e.x) <= 0.5 && Math.abs(sh.y - e.y) <= 0.5 &&
        Math.abs(sh.blur - e.blur) <= 0.5 && Math.abs(sh.spread - (e.spread || 0)) <= 0.5 &&
        Math.abs(sh.alpha - e.alpha) <= 0.02));
      if (ok) return st.name;
    }
    return null;
  }

  function forEachRule(fn) {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin
      if (!rules) continue;
      const walk = (list, media) => {
        for (const rule of Array.from(list)) {
          // A plain style rule now also carries `cssRules` (empty, but truthy)
          // because CSSStyleRule extends CSSGroupingRule for CSS nesting —
          // so test for declarations first, and recurse independently.
          if (rule.style && rule.selectorText) fn(rule, media, sheet);
          if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules, rule.conditionText || media);
        }
      };
      walk(rules, null);
    }
  }

  /* ------------------------------------------- component / variant mapping */
  // A page can extend the bundled registry by defining __DSI_REGISTRY_LOCAL
  // BEFORE the inspector script: same-name entries override field-by-field,
  // new names are appended. This is how a single-file-build prototype adds
  // its own components without a rebuild.
  const REGISTRY = (() => {
    const base = (window.__DSI_REGISTRY && window.__DSI_REGISTRY.components) || [];
    const extra = (window.__DSI_REGISTRY_LOCAL && window.__DSI_REGISTRY_LOCAL.components) || [];
    if (!extra.length) return base;
    const byName = new Map(base.map((c) => [c.name, c]));
    for (const c of extra) byName.set(c.name, Object.assign({}, byName.get(c.name) || {}, c));
    return Array.from(byName.values());
  })();

  // Coin's named text styles — a bare text element is an instance of one of
  // these, not an "unlabelled component".
  const TYPESTYLES = (window.__DSI_REGISTRY && window.__DSI_REGISTRY.typography) ||
    (window.__DSI_REGISTRY_LOCAL && window.__DSI_REGISTRY_LOCAL.typography) || [];

  function isTextElement(el) {
    return !el.children.length && !!(el.textContent || '').trim() &&
      el.namespaceURI !== 'http://www.w3.org/2000/svg';
  }

  function typeStyleOf(el) {
    if (!TYPESTYLES.length) return null;
    const cs = getComputedStyle(el);
    const fam = (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    const size = parseFloat(cs.fontSize);
    const weight = parseFloat(cs.fontWeight) || 400;
    const lh = parseFloat(cs.lineHeight) || null;
    if (!size) return null;
    let match = null;
    for (const t of TYPESTYLES) {
      if (Math.abs(t.size - size) > 0.5 || t.weight !== weight) continue;
      if (t.family && fam && fam !== t.family.toLowerCase()) continue;
      if (t.lineHeight && lh && Math.abs(t.lineHeight - lh) > 1) continue;
      match = t; break;
    }
    if (match) return { ...match, actual: { size, weight, lh, fam, color: cs.color } };
    // Nearest by size within the same weight, for the suggestion.
    const near = TYPESTYLES
      .map((t) => ({ t, d: Math.abs(t.size - size) + (t.weight === weight ? 0 : 3) }))
      .sort((a, b) => a.d - b.d)[0];
    return { name: null, nearest: near && near.d <= 5 ? near.t : null, actual: { size, weight, lh, fam, color: cs.color } };
  }

  const TAG_MAP = {
    button: 'Button', a: 'Link', input: 'Input', textarea: 'Textarea', select: 'Select',
    table: 'Table', thead: 'Table / Header', tbody: 'Table / Body', tr: 'Table / Row',
    th: 'Table / Header Cell', td: 'Table / Cell', dialog: 'Modal', img: 'Image',
    svg: 'Icon', h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading',
    h5: 'Heading', h6: 'Heading', p: 'Body text', label: 'Label', ul: 'List', li: 'List item',
  };

  // Ordered — first match wins.
  const CLASS_MAP = [
    [/(^|[-_])(btn|button)([-_]|$)/i, 'Button'],
    [/(badge|chip|pill|tag)/i, 'Badge'],
    [/(avatar)/i, 'Avatar'],
    [/(modal|dialog|drawer|sheet)/i, 'Modal'],
    [/(tooltip|popover)/i, 'Tooltip'],
    [/(toast|snackbar|alert|banner|callout)/i, 'Alert'],
    [/(tab)([-_]|$)/i, 'Tabs'],
    [/(card|tile|panel)/i, 'Card'],
    [/(nav|sidebar|rail|menu)/i, 'Navigation'],
    [/(input|field|textbox|search)/i, 'Input'],
    [/(select|dropdown|combobox)/i, 'Select'],
    [/(checkbox|radio|toggle|switch)/i, 'Control'],
    [/(table|grid|row|cell|column)/i, 'Table'],
    [/(icon|glyph)/i, 'Icon'],
    [/(spinner|loader|loading|skeleton)/i, 'Loader'],
    [/(progress|meter|bar)/i, 'Progress'],
    [/(kpi|stat|metric)/i, 'Stat'],
    [/(header|topbar|appbar)/i, 'Header'],
    [/(footer)/i, 'Footer'],
    [/(divider|separator|rule)/i, 'Divider'],
    [/(link)/i, 'Link'],
    [/(list)/i, 'List'],
  ];

  // Design-system provenance recorded for a registry entry: where the
  // component lives in Figma, which library owns it, where the code is.
  function dsFields(entry) {
    return {
      figma: (entry && entry.figma) || null,
      figmaPath: (entry && entry.figmaPath) || null,
      library: (entry && entry.library) || null,
      story: (entry && entry.story) || null,
      code: (entry && entry.code) || null,
      notes: (entry && entry.notes) || null,
    };
  }

  function identify(el) {
    const classes = Array.from(el.classList || []);
    const tag = el.tagName.toLowerCase();

    // 1. Explicit annotation — the only source that is actually authoritative.
    const declared = el.getAttribute('data-ds') || el.getAttribute('data-component');
    if (declared) {
      const entry = REGISTRY.find((c) => c.name.toLowerCase() === declared.toLowerCase());
      const f = dsFields(entry);
      f.figma = el.getAttribute('data-ds-figma') || f.figma;
      return { name: declared, source: 'data-ds', confidence: 'declared', ...f };
    }
    // 2. Registry selectors, if the prototype's own classes were registered.
    for (const c of REGISTRY) {
      if (!c.match) continue;
      for (const sel of [].concat(c.match)) {
        try { if (el.matches(sel)) return { name: c.name, source: `registry (${sel})`, confidence: 'mapped', ...dsFields(c) }; } catch {}
      }
    }
    // 2b. A block__element class is a PART of a registered component
    // (select__k is the Filter Trigger's label), never a component guess.
    for (const cls of classes) {
      if (!cls.includes('__')) continue;
      const block = cls.split('__')[0];
      if (!block) continue;
      const owner = REGISTRY.find((rc) => [].concat(rc.match || []).some((sel) => {
        const m = /\.([a-zA-Z0-9_-]+)/.exec(String(sel));
        return m && m[1].split(/--|__/)[0] === block;
      }));
      if (owner) {
        if (isTextElement(el)) {
          const tsp = typeStyleOf(el);
          if (tsp) return { name: 'Text', source: `inside ${owner.name} (.${cls})`, confidence: 'text', typeStyle: tsp, partOf: owner.name, figma: null };
        }
        return { name: owner.name, source: `part (.${cls})`, confidence: 'part', partOf: owner.name, part: cls, ...dsFields(owner) };
      }
    }
    // 3. Heuristics — a guess, and labelled as one. If the guessed name is in
    // the registry, its design-system pointers still apply.
    for (const [re, name] of CLASS_MAP) {
      const hit = classes.find((c) => re.test(c));
      if (hit) return { name, source: `class "${hit}"`, confidence: 'inferred', ...dsFields(REGISTRY.find((c) => c.name === name)) };
    }
    if (el.getAttribute('role')) {
      const r = el.getAttribute('role');
      return { name: r.charAt(0).toUpperCase() + r.slice(1), source: `role="${r}"`, confidence: 'inferred', figma: null };
    }
    // 4. A bare text element is a typography instance, not an unlabelled
    // component — identify it by which Coin type style it wears.
    if (isTextElement(el)) {
      const ts = typeStyleOf(el);
      if (ts) return { name: 'Text', source: 'text node', confidence: 'text', typeStyle: ts, figma: null };
    }
    if (TAG_MAP[tag]) return { name: TAG_MAP[tag], source: `<${tag}>`, confidence: 'inferred', figma: null };
    return { name: null, source: null, confidence: 'unmapped', figma: null };
  }

  function variantOf(el) {
    const out = [];
    for (const attr of el.attributes || []) {
      if (/^data-ds-(variant|size|type|kind|tone|state|emphasis)$/.test(attr.name)) {
        out.push({ key: attr.name.replace('data-ds-', ''), value: attr.value, source: 'declared' });
      }
    }
    if (out.length) return out;
    // BEM-ish modifiers and utility conventions, best-effort.
    for (const c of Array.from(el.classList || [])) {
      const bem = c.match(/^[a-z0-9]+(?:[-_][a-z0-9]+)*--([a-z0-9-]+)$/i);
      if (bem) out.push({ key: 'modifier', value: bem[1], source: `class "${c}"` });
      const is = c.match(/^(is|has)-([a-z0-9-]+)$/i);
      if (is) out.push({ key: 'state', value: is[2], source: `class "${c}"` });
      const sized = c.match(/^(size|variant|tone|type)-([a-z0-9-]+)$/i);
      if (sized) out.push({ key: sized[1], value: sized[2], source: `class "${c}"` });
    }
    return out;
  }

  /* ------------------------------------------- composition & spec checking */

  // Which design-system components sit INSIDE this one, and how deeply.
  // A Card made of a Button made of an Icon should read as exactly that.
  function composition(el, limit = 30) {
    const out = [];
    (function walk(node, depth) {
      for (const child of node.children || []) {
        if (out.length >= limit) return;
        if (child.closest && child.closest('[data-dsi-ui]')) continue;
        const c = identify(child);
        const interactive = /^(button|a|input|select|textarea|svg)$/.test(child.tagName.toLowerCase());
        // Declared/registered components always count. Guesses only count when
        // the element is obviously a control, otherwise every wrapper appears.
        const counts = c.name && (c.confidence === 'declared' || c.confidence === 'mapped' || (c.confidence === 'inferred' && interactive));
        if (counts) {
          out.push({
            name: c.name, confidence: c.confidence, depth,
            variant: variantOf(child).map((v) => v.value).join(' · '),
            text: (child.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32),
          });
          walk(child, depth + 1);
        } else walk(child, depth);
      }
    })(el, 0);
    return out;
  }

  // Which components this one sits inside, outermost first.
  function containers(el) {
    const out = [];
    let node = el.parentElement;
    while (node && node !== document.body) {
      const c = identify(node);
      if (c.name && (c.confidence === 'declared' || c.confidence === 'mapped')) {
        out.unshift({ name: c.name, variant: variantOf(node).map((v) => v.value).join(' · ') });
      }
      node = node.parentElement;
    }
    return out;
  }

  // Size and state modifiers are not variants — btn--sm, btn--icon, is-active
  // must never trigger "unknown variant". Only unrecognised VARIANT words do.
  const IGNORED_MODIFIERS = new Set([
    'xs', 'sm', 'md', 'lg', 'xl', 'small', 'medium', 'large', 'icon',
    'active', 'selected', 'open', 'disabled', 'loading', 'hover', 'pressed',
    'block', 'full', 'fullwidth', 'wide',
  ]);

  // Compare the element against the component's recorded spec, if there is one.
  function checkSpec(el, comp, variants) {
    const entry = REGISTRY.find((c) => c.name === (comp && comp.name));
    if (!entry || !entry.variants) return null;

    const keys = Object.keys(entry.variants);
    const declared = variants.map((v) => String(v.value).toLowerCase()).filter((v) => !IGNORED_MODIFIERS.has(v));
    const key = keys.find((k) => declared.includes(k.toLowerCase())) ||
                (keys.includes('*') ? '*'
                  : !declared.length && keys.includes('Default') ? 'Default'
                  : null);
    if (!key) return { variant: null, unknownVariant: declared.join(' · ') || null, diffs: [], checked: 0 };

    const expected = entry.variants[key];
    const cs = getComputedStyle(el);
    const diffs = [];
    let checked = 0;
    for (const [prop, expect] of Object.entries(expected)) {
      const t = Tokens.list.find((x) => x.name === expect);
      const want = t ? t.value : expect;

      // If the stylesheet literally names the expected token, that is a match —
      // no need to round-trip through a computed value that may be unreliable.
      if (expect.startsWith('--') && authoredVar(el, prop, PROP_GROUP[prop]) === expect) { checked++; continue; }

      let got = cs.getPropertyValue(prop).trim();
      if (/depends on user agent/.test(got)) continue; // non-browser CSSOM
      // Some engines hand back an unresolved var() — resolve it before comparing.
      const gv = /^var\(\s*(--[a-zA-Z0-9-]+)/.exec(got);
      if (gv) {
        const gt = Tokens.list.find((x) => x.name === gv[1]);
        got = (gt && gt.value) || getComputedStyle(document.documentElement).getPropertyValue(gv[1]).trim() || got;
      }
      if (!got) continue;
      checked++;
      const isCol = /^(#|rgb|hsl)/i.test(want) || /^(#|rgb|hsl)/i.test(got);
      const same = isCol ? normColor(want) === normColor(got) : normLen(want) === normLen(got);
      if (!same) diffs.push({ prop, got, want, token: t ? t.name : null });
    }
    return { variant: key, diffs, checked };
  }

  /* --------------------------------------- changes on top of the component */
  // A design-system component used in a prototype often gets extra styling
  // layered on: an inline style, a contextual rule (.toolbar .btn), a bolt-on
  // class (.btn.save-special). That layering is exactly what needs to be
  // agreed into the system or dropped before handoff, so it gets its own
  // section. "Base" = rules whose selector only references the component's
  // own classes/tag; everything else that wins a property is a change on top.

  // Which class prefixes belong to the component itself — from the registry
  // match selectors when there are any, else the element's first class block.
  function ownPrefixes(el, entry) {
    const out = new Set([el.tagName.toLowerCase()]);
    if (entry && entry.match) {
      for (const sel of [].concat(entry.match)) {
        for (const m of String(sel).matchAll(/\.([a-zA-Z0-9_-]+)/g)) out.add(m[1].split(/--|__/)[0]);
        const attr = /\[class[*^~|$]?=['"]?([a-zA-Z0-9_-]+)/.exec(String(sel));
        if (attr) out.add(attr[1]);
        const tag = /^[a-z][a-z0-9-]*/i.exec(String(sel).trim());
        if (tag) out.add(tag[0].toLowerCase());
      }
    } else if (el.classList && el.classList.length) {
      out.add(el.classList[0].split(/--|__/)[0]);
    }
    return out;
  }

  function isOwnClass(cls, prefixes) {
    if (/^(is|has)-/.test(cls)) return true; // state classes are part of the component contract
    return prefixes.has(cls) || prefixes.has(cls.split(/--|__/)[0]);
  }

  // Does this selector stay inside the component's own naming? BEM variants
  // (.btn--primary) and elements (.btn__icon) count as the component; ids,
  // foreign classes and contextual ancestors do not.
  function isBaseSelector(selector, prefixes) {
    const base = String(selector).replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').trim();
    for (const compound of base.split(/[\s>+~]+/)) {
      if (!compound) continue;
      if (compound.includes('#')) return false;
      const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(compound);
      if (tag && !prefixes.has(tag[0].toLowerCase()) && !/^(html|body)$/i.test(tag[0])) return false;
      for (const m of compound.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
        if (!isOwnClass(m[1], prefixes)) return false;
      }
    }
    return true;
  }

  // The authored text that sets `prop` on this declaration block, longhand or
  // shorthand — kept as written so var(--token) stays visible.
  function readDecl(style, prop) {
    const direct = style.getPropertyValue(prop);
    if (direct) return { text: direct.trim(), via: prop };
    for (const sh of SHORTHAND[prop] || []) {
      const v = style.getPropertyValue(sh);
      if (v) return { text: v.trim(), via: sh };
    }
    return null;
  }

  const SHORTHAND_LABEL = {
    padding: 'Padding', margin: 'Margin', border: 'Border', 'border-top': 'Border',
    'border-color': 'Border colour', 'border-width': 'Border width', 'border-style': 'Border style',
    font: 'Font', background: 'Background',
  };

  function overridesOf(el, comp, specCheck) {
    if (!comp || !(comp.confidence === 'declared' || comp.confidence === 'mapped')) return [];
    const entry = REGISTRY.find((c) => c.name === comp.name);
    const prefixes = ownPrefixes(el, entry);
    const rules = matchedRules(el).filter((r) => !r.pseudo)
      .map((r) => ({ selector: r.selector, style: r.style, base: isBaseSelector(r.selector, prefixes) }));

    const found = new Map(); // one row per (source, declaration), props merged
    for (const [, prop] of PROPS) {
      // Who wins this property: inline style outright, else the last matching rule.
      let from = null, decl = null;
      if (el.style && declares(el.style, prop)) {
        from = 'inline style'; decl = readDecl(el.style, prop);
      } else {
        for (let i = rules.length - 1; i >= 0; i--) {
          if (!declares(rules[i].style, prop)) continue;
          if (!rules[i].base) { from = rules[i].selector; decl = readDecl(rules[i].style, prop); }
          break; // a base rule winning means no change on top for this prop
        }
      }
      if (!from || !decl) continue;

      // What the component itself says, for the before → after read.
      let base = null;
      for (let i = rules.length - 1; i >= 0; i--) {
        if (rules[i].base && declares(rules[i].style, prop)) { base = readDecl(rules[i].style, prop); break; }
      }
      if (base && normLen(base.text) === normLen(decl.text)) continue; // re-stating the base is not a change
      const diff = specCheck && specCheck.diffs && specCheck.diffs.find((d) => d.prop === prop);
      if (!base && !diff && SKIP_VALUES.has(normLen(decl.text))) continue; // resetting nothing to nothing

      const key = `${from}|${decl.via}|${decl.text}`;
      if (!found.has(key)) {
        found.set(key, {
          props: [], value: decl.text, from,
          label: SHORTHAND_LABEL[decl.via] || plain(decl.via),
          base: base ? base.text : null, want: null,
          color: /color|background|fill|stroke/.test(decl.via),
        });
      }
      const rec = found.get(key);
      rec.props.push(prop);
      if (diff) rec.want = diff.token || diff.want;
    }
    return Array.from(found.values());
  }

  // What the CSS says happens on hover / press / focus / disabled — read
  // statically from the matched pseudo-state rules, so the panel can show
  // interactions without the user having to trigger them.
  function interactionsOf(el) {
    const groups = {};
    const cs = getComputedStyle(el);
    for (const r of matchedRules(el)) {
      if (!r.pseudos || !r.pseudos.length) continue;
      const state = r.pseudos[0];
      for (const [, prop] of PROPS) {
        if (!declares(r.style, prop)) continue;
        const decl = readDecl(r.style, prop);
        if (!decl) continue;
        const m = (groups[state] = groups[state] || new Map());
        const key = `${decl.via}|${decl.text}`;
        if (!m.has(key)) {
          m.set(key, {
            label: SHORTHAND_LABEL[decl.via] || plain(decl.via),
            to: decl.text,
            from: cs.getPropertyValue(prop).trim() || null,
            color: /color|background|fill|stroke/.test(decl.via),
          });
        }
      }
    }
    const ORDER = ['hover', 'active', 'focus', 'focus-visible', 'focus-within', 'disabled', 'checked'];
    return ORDER.filter((s) => groups[s]).map((s) => ({ state: s, changes: Array.from(groups[s].values()) }));
  }

  function statesOf(el) {
    const s = [];
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-expanded') === 'true') s.push('expanded');
    if (el.getAttribute('aria-current')) s.push(`current=${el.getAttribute('aria-current')}`);
    if (el.getAttribute('aria-checked') === 'true' || el.checked) s.push('checked');
    try { if (el.matches(':focus')) s.push('focus'); } catch {}
    if (el === document.activeElement) s.push('active');
    return s;
  }

  /* ------------------------------------------------------- property probes */
  // Which computed properties matter, and which token group each maps to.
  const PROPS = [
    ['Color', 'color', 'color'],
    ['Color', 'background-color', 'color'],
    ['Color', 'border-top-color', 'color'],
    ['Color', 'fill', 'color'],
    ['Color', 'stroke', 'color'],
    ['Typography', 'font-family', 'font-family'],
    ['Typography', 'font-size', 'font-size'],
    ['Typography', 'font-weight', 'font-weight'],
    ['Typography', 'line-height', 'line-height'],
    ['Typography', 'letter-spacing', 'letter-spacing'],
    ['Typography', 'text-transform', null],
    ['Spacing', 'padding-top', 'spacing'],
    ['Spacing', 'padding-right', 'spacing'],
    ['Spacing', 'padding-bottom', 'spacing'],
    ['Spacing', 'padding-left', 'spacing'],
    ['Spacing', 'gap', 'spacing'],
    ['Spacing', 'margin-top', 'spacing'],
    ['Spacing', 'margin-right', 'spacing'],
    ['Spacing', 'margin-bottom', 'spacing'],
    ['Spacing', 'margin-left', 'spacing'],
    ['Border', 'border-top-width', null],
    ['Border', 'border-style', null],
    ['Border', 'border-radius', 'radius'],
    ['Effect', 'box-shadow', 'shadow'],
    ['Effect', 'opacity', null],
  ];
  const PROP_GROUP = {};
  PROPS.forEach(([, prop, group]) => { if (group) PROP_GROUP[prop] = group; });
  const SKIP_VALUES = new Set(['none', 'normal', 'auto', '0px', '0', 'rgba(0, 0, 0, 0)', 'transparent', '1', 'medium']);

  // How each property is described to a human reading the panel.
  const PLAIN = {
    'color': 'Text colour', 'background-color': 'Background', 'border-top-color': 'Border colour',
    'fill': 'Icon fill', 'stroke': 'Icon stroke', 'font-family': 'Font', 'font-size': 'Text size',
    'font-weight': 'Text weight', 'line-height': 'Line height', 'letter-spacing': 'Letter spacing',
    'text-transform': 'Text case', 'padding-top': 'Padding top', 'padding-right': 'Padding right',
    'padding-bottom': 'Padding bottom', 'padding-left': 'Padding left', 'margin-top': 'Margin top',
    'margin-right': 'Margin right', 'margin-bottom': 'Margin bottom', 'margin-left': 'Margin left',
    'gap': 'Gap', 'border-top-width': 'Border width', 'border-style': 'Border style',
    'border-radius': 'Corner radius', 'box-shadow': 'Shadow', 'opacity': 'Opacity',
  };
  const plain = (p) => PLAIN[p] || p;

  // Values shown to a human lead with the token name, not the raw CSS.
  // `var(--sp-m) var(--sp-l)` reads as `--sp-m · --sp-l`; a colour that
  // matches a token reads as the token; anything long gets trimmed.
  function humanVal(v) {
    if (!v) return v;
    const s = String(v).trim();
    const vars = Array.from(s.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)[^)]*\)/g)).map((m) => m[1]);
    if (vars.length && !s.replace(/var\([^)]*\)/g, '').trim()) return vars.join(' · ');
    if (/^(#|rgb|hsl)/i.test(s)) {
      const fig = figmaColorFor(s, '');
      if (fig) return fig;
      const t = Tokens.match(s, 'color');
      if (t) return t.name;
    }
    const fx = effectNameFor(s);
    if (fx) return fx;
    return s.length > 44 ? s.slice(0, 41) + '…' : s;
  }

  function readProps(el) {
    const cs = getComputedStyle(el);
    const isSVG = el.namespaceURI === 'http://www.w3.org/2000/svg';
    const hasBorder = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
    const rows = [];
    for (const [group, prop, tokenGroup] of PROPS) {
      // Don't report properties that aren't actually in play on this element.
      if ((prop === 'fill' || prop === 'stroke') && !isSVG) continue;
      if (prop === 'border-top-color' && !hasBorder) continue;

      let value = cs.getPropertyValue(prop).trim();
      if (/depends on user agent/.test(value)) continue; // non-browser CSSOM
      // Some engines hand back the unresolved custom property; read the name off it.
      const rawVar = value.match(/var\(\s*(--[a-zA-Z0-9-]+)/);
      // A var() written in the author stylesheet is the strongest signal, and
      // it stays meaningful even when the computed value is empty or a default
      // — so resolve it before deciding whether to skip the row.
      const authored = authoredVar(el, prop, tokenGroup) || (rawVar && rawVar[1]) || null;
      if ((!value || SKIP_VALUES.has(value) || rawVar) && !authored) continue;
      if (rawVar) value = '';
      if (prop === 'font-family') value = value.split(',')[0].replace(/["']/g, '').trim();

      const token = Tokens.match(value, tokenGroup);
      const inherited = INHERITED.has(prop) && !declaredHere(el, prop);
      // The Figma name for this value — the vocabulary a dev sees in dev mode.
      let figma = null;
      if (tokenGroup === 'color') figma = figmaColorFor(value, prop);
      else if (prop === 'border-radius') figma = figmaNumberFor(value, 'radius/');
      else if (group === 'Spacing') figma = figmaNumberFor(value, 'spacing/');
      else if (prop === 'box-shadow') figma = effectNameFor(value);
      const row = { group, prop, value, token: null, figma, authoredVar: authored, inherited, offSystem: false, nearest: null };
      if (authored) {
        const t = Tokens.list.find((x) => x.name === authored);
        row.token = { name: authored, label: t ? t.label : authored.replace(/^--/, ''), alias: t ? t.alias : null, origin: t ? t.origin : 'page' };
        // Fall back to the token's own value when the browser gave us nothing.
        if ((!row.value || SKIP_VALUES.has(row.value)) && t) row.value = t.value;
      } else if (token) {
        row.token = { name: token.name, label: token.label, alias: token.alias, origin: token.origin };
      } else if (row.figma) {
        // Known to Figma by name — on-system even without a CSS token.
      } else if (tokenGroup) {
        row.offSystem = true;
        if (tokenGroup === 'color') {
          const near = Tokens.nearestColor(value);
          if (near && near.dist < 40) row.nearest = { name: near.token.name, value: near.token.value, dist: Math.round(near.dist) };
        } else {
          const near = Tokens.list
            .filter((t) => t.group === tokenGroup && /px$/.test(t.value))
            .map((t) => ({ t, d: Math.abs(parseFloat(t.value) - parseFloat(value)) }))
            .sort((a, b) => a.d - b.d)[0];
          if (near && near.d <= 4) row.nearest = { name: near.t.name, value: near.t.value, dist: near.d };
        }
      }
      rows.push(row);
    }
    return rows;
  }

  // Look through matching author rules for `prop: var(--x)`, longhand or shorthand.
  // Longhand -> the shorthands that can set it, narrowest first.
  const SHORTHAND = {
    'padding-top': ['padding'], 'padding-right': ['padding'], 'padding-bottom': ['padding'], 'padding-left': ['padding'],
    'margin-top': ['margin'], 'margin-right': ['margin'], 'margin-bottom': ['margin'], 'margin-left': ['margin'],
    'border-top-color': ['border-top', 'border-color', 'border'],
    'border-top-width': ['border-top', 'border-width', 'border'],
    'border-style': ['border-top', 'border', 'border-style'],
    'font-size': ['font'], 'font-weight': ['font'], 'line-height': ['font'], 'font-family': ['font'],
    'background-color': ['background'],
  };
  const POSITIONAL = new Set(['padding', 'margin', 'border-color', 'border-width', 'border-style']);
  const BOX_SIDES = { top: 0, right: 1, bottom: 2, left: 3 };

  // Split a value on top-level whitespace, keeping var(...) / rgb(...) intact.
  function splitTop(value) {
    const out = []; let depth = 0, cur = '';
    for (const ch of value) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (!depth && /\s/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }
  const varName = (s) => { const m = /^var\(\s*(--[a-zA-Z0-9-]+)/.exec(s || ''); return m ? m[1] : null; };

  const sideIndexOf = (prop) => {
    const m = /-(top|right|bottom|left)(-|$)/.exec(prop);
    return m ? BOX_SIDES[m[1]] : null;
  };
  const pickSide = (parts, i) =>
    parts.length === 1 ? parts[0]
      : parts.length === 2 ? parts[i % 2]
      : parts.length === 3 ? [parts[0], parts[1], parts[2], parts[1]][i]
      : parts[i];

  // Resolve `prop` on this rule to a custom-property name, if the author used one.
  function varFromDecl(style, prop, tokenGroup) {
    const direct = style.getPropertyValue(prop);
    if (direct) { const n = varName(direct.trim()); if (n) return n; }

    for (const sh of SHORTHAND[prop] || []) {
      const shVal = (style.getPropertyValue(sh) || '').trim();
      if (!shVal || !shVal.includes('var(')) continue;
      const parts = splitTop(shVal);

      // padding / margin / border-color are positional — pick this side's part
      // rather than blindly taking the first var() in the declaration.
      const i = sideIndexOf(prop);
      if (POSITIONAL.has(sh) && i !== null) {
        const n = varName(pickSide(parts, i));
        if (n) return n;
        continue;
      }
      if (parts.length === 1) { const n = varName(parts[0]); if (n) return n; continue; }

      // Multi-part shorthand like `border: 1px solid var(--border-1)`: keep the
      // var whose token is the right kind for this longhand, and bail if that
      // is ambiguous rather than guess.
      if (tokenGroup) {
        const candidates = parts.map(varName).filter(Boolean)
          .filter((n) => { const t = Tokens.list.find((x) => x.name === n); return t && t.group === tokenGroup; });
        if (candidates.length === 1) return candidates[0];
      }
    }
    return null;
  }

  const declares = (style, prop) =>
    !!style.getPropertyValue(prop) || (SHORTHAND[prop] || []).some((sh) => !!style.getPropertyValue(sh));

  function authoredVar(el, prop, tokenGroup) {
    // Inline styles win outright.
    if (el.style && declares(el.style, prop)) return varFromDecl(el.style, prop, tokenGroup);
    // Otherwise the LAST matching rule that sets this property is the one in
    // effect. If that one hardcodes a value, there is no authored token —
    // an earlier rule's var() has been overridden and must not be reported.
    const rules = matchedRules(el);
    for (let i = rules.length - 1; i >= 0; i--) {
      if (declares(rules[i].style, prop)) return varFromDecl(rules[i].style, prop, tokenGroup);
    }
    return null;
  }

  // Inherited properties show up on every descendant. Reporting a value as
  // "off-system" is only fair if this element actually declares it.
  const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform']);
  function declaredHere(el, prop) {
    const names = [prop, ...(SHORTHAND[prop] || [])];
    if (el.style) for (const n of names) if (el.style.getPropertyValue(n)) return true;
    for (const r of matchedRules(el)) for (const n of names) if (r.style.getPropertyValue(n)) return true;
    return false;
  }

  const ruleCache = new WeakMap();
  function matchedRules(el) {
    if (ruleCache.has(el)) return ruleCache.get(el);
    const out = [];
    forEachRule((rule, media) => {
      if (!rule.selectorText || !rule.style) return;
      for (const sel of rule.selectorText.split(',')) {
        const clean = sel.trim();
        if (!clean || clean.startsWith('@')) continue;
        // Strip pseudo-states so :hover/:focus rules still surface as relevant.
        const base = clean.replace(/::?(hover|focus|active|visited|focus-visible|focus-within|disabled|checked|first-child|last-child|nth-child\([^)]*\)|before|after|placeholder|selection)/g, '');
        if (!base || base === '*') continue;
        let hit = false;
        try { hit = el.matches(base); } catch { continue; }
        if (hit) {
          const pseudos = (clean.match(/:(hover|active|focus-visible|focus-within|focus|disabled|checked)/g) || []).map((p) => p.slice(1));
          out.push({ selector: clean, style: rule.style, cssText: rule.cssText, media, pseudo: clean !== base, pseudos });
          break;
        }
      }
    });
    ruleCache.set(el, out);
    return out;
  }

  /* -------------------------------------------------------- spec assembly */
  function domPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let s = node.tagName.toLowerCase();
      if (node.id) s += `#${node.id}`;
      else if (node.classList.length) s += `.${Array.from(node.classList).slice(0, 2).join('.')}`;
      const ds = node.getAttribute && node.getAttribute('data-ds');
      if (ds) s = `${ds}⟨${s}⟩`;
      parts.unshift(s);
      node = node.parentElement;
    }
    return parts;
  }

  function buildSpec(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const comp = identify(el);
    const variants = variantOf(el);
    const specCheck = checkSpec(el, comp, variants);
    const rules = matchedRules(el).map((m) => ({
      selector: m.selector,
      media: m.media,
      pseudo: m.pseudo,
      decls: m.cssText.replace(/^[^{]*\{/, '').replace(/\}\s*$/, '').split(';').map((s) => s.trim()).filter(Boolean),
    }));
    return {
      frame: IS_TOP ? 'main' : (frameLabel() || 'iframe'),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList || []),
      attrs: Array.from(el.attributes || []).filter((a) => a.name.startsWith('data-') || a.name.startsWith('aria-') || a.name === 'role').map((a) => `${a.name}="${a.value}"`),
      component: comp,
      variant: variants,
      spec: specCheck,
      overrides: overridesOf(el, comp, specCheck),
      interactions: interactionsOf(el),
      madeOf: composition(el),
      insideOf: containers(el),
      states: statesOf(el),
      text: (el.textContent || '').trim().slice(0, 120),
      childCount: el.children.length,
      box: {
        w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
        padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`.replace(/(\b0px\b)/g, '0'),
        margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`.replace(/(\b0px\b)/g, '0'),
      },
      layout: {
        display: cs.display,
        direction: cs.flexDirection !== 'row' || cs.display.includes('flex') ? cs.flexDirection : null,
        gap: cs.gap !== 'normal' ? cs.gap : null,
        align: cs.alignItems, justify: cs.justifyContent,
        grid: cs.display.includes('grid') ? cs.gridTemplateColumns : null,
        position: cs.position !== 'static' ? cs.position : null,
      },
      props: readProps(el),
      rules,
      path: domPath(el),
    };
  }

  function frameLabel() {
    try { return window.frameElement && (window.frameElement.id || window.frameElement.name || window.frameElement.getAttribute('data-ds-frame') || 'iframe'); }
    catch { return 'iframe'; }
  }

  /* ------------------------------------------------------- page-wide audit */
  function auditPage() {
    const offColors = new Map(), offSizes = new Map(), unmapped = new Map();
    let total = 0, clean = 0;
    // Elements behind each finding, kept frame-locally so a finding in the
    // panel can be clicked to scroll to and select the actual offender.
    const els = (window.__DSI_AUDIT_ELS = []);
    const occurrence = (el, comp) => ({
      i: els.push(el) - 1,
      comp: (comp && comp.name) || (el.classList[0] ? `.${el.classList[0]}` : `<${el.tagName.toLowerCase()}>`),
      path: domPath(el).slice(-2).join(' › '),
    });
    const all = document.querySelectorAll('body *:not(script):not(style):not(link):not(meta):not(title)');
    for (const el of all) {
      if (el.closest('[data-dsi-ui]')) continue;
      // Shapes inside an icon aren't components — the <svg> itself is.
      if (el.namespaceURI === 'http://www.w3.org/2000/svg' && el.tagName.toLowerCase() !== 'svg') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      total++;
      const rows = readProps(el);
      const bad = rows.filter((x) => x.offSystem && !x.inherited);
      if (!bad.length) clean++;
      const c = identify(el);
      for (const b of bad) {
        const bucket = b.group === 'Color' ? offColors : offSizes;
        const key = `${b.value}`;
        if (!bucket.has(key)) bucket.set(key, { value: b.value, count: 0, props: new Set(), nearest: b.nearest, occ: [] });
        const rec = bucket.get(key);
        rec.count++; rec.props.add(b.prop);
        if (rec.occ.length < 6 && !rec.occ.some((o) => o.comp === (c.name || '') && els[o.i] === el)) rec.occ.push(occurrence(el, c));
      }
      // Only worth listing things that look like components: a class of their
      // own, or an interactive role. Bare layout <div>/<span> just add noise.
      const worthNaming = el.classList.length > 0 || el.getAttribute('role') ||
        /^(button|a|input|select|textarea|table|dialog)$/.test(el.tagName.toLowerCase());
      if (worthNaming && (c.confidence === 'unmapped' || c.confidence === 'inferred')) {
        const key = Array.from(el.classList).slice(0, 2).join('.') || el.tagName.toLowerCase();
        if (!unmapped.has(key)) unmapped.set(key, { key, count: 0, guess: c.name, confidence: c.confidence, occ: [] });
        const u = unmapped.get(key);
        u.count++;
        if (u.occ.length < 3) u.occ.push(occurrence(el, c));
      }
    }
    const ser = (m) => Array.from(m.values()).map((v) => ({ ...v, props: Array.from(v.props || []) })).sort((a, b) => b.count - a.count);
    return {
      frame: IS_TOP ? 'main' : frameLabel(),
      total, clean,
      coverage: total ? Math.round((clean / total) * 100) : 0,
      offColors: ser(offColors).slice(0, 40),
      offSizes: ser(offSizes).slice(0, 40),
      unmapped: ser(unmapped).slice(0, 40),
    };
  }

  /* ------------------------------------------------------------- overlays */
  let overlay, overlayLabel;
  function ensureOverlay() {
    if (overlay) return;
    overlay = $('div', { 'data-dsi-ui': 'highlight' });
    Object.assign(overlay.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: 2147483646,
      border: '1px solid #34A290', background: 'rgba(52,162,144,0.14)',
      borderRadius: '2px', transition: 'all .05s linear', display: 'none',
    });
    overlayLabel = $('div', { 'data-dsi-ui': 'label' });
    Object.assign(overlayLabel.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: 2147483647,
      background: '#0F1E24', color: '#fff', font: '500 11px/1.5 ui-monospace,monospace',
      padding: '2px 6px', borderRadius: '3px', display: 'none', whiteSpace: 'nowrap',
    });
    document.documentElement.append(overlay, overlayLabel);
  }
  function highlight(el, locked) {
    ensureOverlay();
    if (!el) { overlay.style.display = 'none'; overlayLabel.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: 'block', top: `${r.top}px`, left: `${r.left}px`,
      width: `${r.width}px`, height: `${r.height}px`,
      borderStyle: locked ? 'solid' : 'dashed',
      borderWidth: locked ? '2px' : '1px',
    });
    const c = identify(el);
    overlayLabel.textContent = `${c.name || el.tagName.toLowerCase()} · ${Math.round(r.width)}×${Math.round(r.height)}`;
    const above = r.top > 22;
    Object.assign(overlayLabel.style, {
      display: 'block',
      top: `${above ? r.top - 20 : r.bottom + 4}px`,
      left: `${Math.max(2, r.left)}px`,
      background: c.confidence === 'declared' ? '#34A290' : '#0F1E24',
    });
  }

  /* --------------------------------------------------------- frame wiring */
  const state = { on: true, selected: null };
  const post = (msg) => { try { window.top.postMessage({ __dsi: true, ...msg }, '*'); } catch {} };

  function elementFrom(e) {
    const el = e.target;
    if (!el || el.nodeType !== 1) return null;
    if (el.closest && el.closest('[data-dsi-ui]')) return null;
    return el;
  }

  function onMove(e) {
    if (!state.on) return;
    const el = elementFrom(e);
    if (el) highlight(el, false);
  }
  function onLeave() { if (state.on && !state.selected) highlight(null); }

  function select(el) {
    state.selected = el;
    highlight(el, true);
    const spec = buildSpec(el);
    if (IS_TOP) Panel.render(spec); else post({ type: 'select', spec });
  }

  function onClick(e) {
    if (!state.on && !e.altKey) return;
    const el = elementFrom(e);
    if (!el) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    select(el);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      // Consume the Esc that pauses inspecting — otherwise the prototype
      // also sees it and closes the very menu being inspected.
      if (state.on) { e.preventDefault(); e.stopPropagation(); }
      setMode(false); return;
    }
    if ((e.key === 'i' || e.key === 'I') && (e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); setMode(!state.on); return; }
    if (!state.on || !state.selected) return;
    const el = state.selected;
    let next = null;
    if (e.key === 'ArrowUp') next = el.parentElement;
    if (e.key === 'ArrowDown') next = el.children[0];
    if (e.key === 'ArrowLeft') next = el.previousElementSibling;
    if (e.key === 'ArrowRight') next = el.nextElementSibling;
    if (next && !next.closest('[data-dsi-ui]')) { e.preventDefault(); select(next); }
  }

  function setMode(on) {
    state.on = on;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) { highlight(null); state.selected = null; }
    if (IS_TOP) Panel.setMode(on); else return;
    broadcast({ type: 'mode', on });
  }

  // While inspecting, clicks never reach the page. While PAUSED, holding Alt
  // shields the page too — so Alt+click can select transient UI (an open
  // menu, a toast) without the page's own click-outside handler closing it.
  ['mousedown', 'mouseup', 'click', 'dblclick'].forEach((t) =>
    document.addEventListener(t, (e) => {
      if (e.target.closest && e.target.closest('[data-dsi-ui]')) return;
      if (t === 'click') return onClick(e);
      if (state.on || e.altKey) { e.preventDefault(); e.stopPropagation(); }
    }, true)
  );
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseleave', onLeave, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', () => state.selected && highlight(state.selected, true), true);
  window.addEventListener('resize', () => state.selected && highlight(state.selected, true));

  /* --------------------------------------------- inject into child frames */
  function injectFrames() {
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      let doc;
      try { doc = f.contentDocument; } catch { continue; }
      if (!doc || !doc.documentElement) continue;
      if (doc.__dsiInjected) continue;
      doc.__dsiInjected = true;
      try {
        if (window.__DSI_TOKENS) {
          const s0 = doc.createElement('script');
          s0.textContent = `window.__DSI_TOKENS=${JSON.stringify(window.__DSI_TOKENS)};window.__DSI_REGISTRY=${JSON.stringify(window.__DSI_REGISTRY || {})};`;
          (doc.head || doc.documentElement).append(s0);
        }
        const s = doc.createElement('script');
        s.src = SELF_SRC || `${BASE}/inspect.js`;
        (doc.head || doc.documentElement).append(s);
      } catch {}
    }
  }
  function watchFrames() {
    injectFrames();
    new MutationObserver(() => injectFrames()).observe(document.documentElement, { childList: true, subtree: true });
    document.querySelectorAll('iframe').forEach((f) => f.addEventListener('load', () => { try { f.contentDocument.__dsiInjected = false; } catch {} injectFrames(); }));
    setInterval(injectFrames, 1500);
  }

  function broadcast(msg) {
    document.querySelectorAll('iframe').forEach((f) => { try { f.contentWindow.postMessage({ __dsi: true, ...msg }, '*'); } catch {} });
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__dsi !== true) return;
    if (d.type === 'select' && IS_TOP) { Panel.activeFrame = e.source; Panel.render(d.spec); highlight(null); state.selected = null; }
    if (d.type === 'mode') { state.on = d.on; document.documentElement.style.cursor = d.on ? 'crosshair' : ''; if (!d.on) { highlight(null); state.selected = null; } }
    if (d.type === 'audit-request' && !IS_TOP) post({ type: 'audit-result', audit: auditPage() });
    if (d.type === 'audit-result' && IS_TOP) Panel.addAudit(d.audit);
    if (d.type === 'audit-locate' && !IS_TOP && (frameLabel() || 'iframe') === d.frame) {
      const el = (window.__DSI_AUDIT_ELS || [])[d.index];
      if (el && el.isConnected) {
        try { el.scrollIntoView({ block: 'center' }); } catch {}
        select(el);
      }
    }
  });

  /* ----------------------------------------------------------------- panel */
  const Panel = {
    host: null, root: null, activeFrame: null, spec: null, audits: [],

    mount() {
      this.host = $('div', { 'data-dsi-ui': 'panel' });
      Object.assign(this.host.style, { position: 'fixed', inset: '0 0 auto auto', zIndex: 2147483647 });
      // Interacting with the panel must never count as a page click — a
      // prototype's click-outside handler would close the very menu being
      // inspected. Stop panel events before they bubble to the document.
      ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup'].forEach((t) =>
        this.host.addEventListener(t, (e) => e.stopPropagation()));
      document.documentElement.append(this.host);
      this.root = this.host.attachShadow({ mode: 'open' });
      this.root.append($('style', { text: PANEL_CSS }));
      this.wrap = $('div', { class: 'wrap' });
      this.root.append(this.wrap);
      this.renderEmpty();
    },

    setMode(on) { if (this.wrap) this.wrap.classList.toggle('paused', !on); this.renderChrome(); },

    collapse(on) {
      this.collapsed = on;
      this.wrap.style.display = on ? 'none' : '';
      if (on) {
        this.tab = $('button', { class: 'reopen', text: '«', title: 'Show DS Inspector', onclick: () => this.collapse(false) });
        this.root.append(this.tab);
      } else if (this.tab) { this.tab.remove(); this.tab = null; }
    },

    // Drag the panel by its header; double-click the header to dock it back
    // to the right edge.
    makeDraggable(header) {
      header.addEventListener('mousedown', (e) => {
        if (e.target.closest && e.target.closest('button, a')) return;
        const wrap = this.wrap;
        const r = wrap.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        const move = (ev) => {
          wrap.classList.add('floating');
          wrap.style.left = `${Math.max(8 - r.width + 60, Math.min(window.innerWidth - 60, ev.clientX - dx))}px`;
          wrap.style.top = `${Math.max(0, Math.min(window.innerHeight - 44, ev.clientY - dy))}px`;
          wrap.style.right = 'auto';
        };
        // Capture phase: the inspector's own click-shield stops mouseup at the
        // document, so a bubble-phase listener would never fire and the panel
        // would stay glued to the cursor.
        const up = () => {
          window.removeEventListener('mousemove', move, true);
          window.removeEventListener('mouseup', up, true);
          window.removeEventListener('blur', up);
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
        window.addEventListener('blur', up);
        e.preventDefault();
      });
      header.addEventListener('dblclick', (e) => {
        if (e.target.closest && e.target.closest('button, a')) return;
        this.wrap.classList.remove('floating');
        this.wrap.style.left = this.wrap.style.top = this.wrap.style.right = '';
      });
    },

    chrome(bodyNodes) {
      this.wrap.innerHTML = '';
      const header = $('div', { class: 'hd', title: 'Drag to move · double-click to dock right' }, [
        $('div', { class: 'ttl' }, [$('span', { class: 'dot' }), $('span', { text: 'DS Inspector' })]),
        $('div', { class: 'hdbtns' }, [
          $('button', { class: 'gh', text: state.on ? 'Inspecting' : 'Paused', title: 'Toggle inspect mode (⌘⇧I / Esc)', onclick: () => setMode(!state.on) }),
          $('button', { class: 'gh', text: 'Audit', title: 'Scan the whole page for off-system values', onclick: () => this.runAudit() }),
          $('button', { class: 'gh', text: '⤓', title: 'Copy spec as markdown', onclick: () => this.copySpec() }),
          $('button', { class: 'gh', text: '»', title: 'Collapse the panel', onclick: () => this.collapse(true) }),
        ]),
      ]);
      const body = $('div', { class: 'bd' }, bodyNodes);
      this.wrap.append(header, body);
      this.makeDraggable(header);
    },
    renderChrome() { if (this.spec) this.render(this.spec); else if (this.audits.length) this.renderAudit(); else this.renderEmpty(); },

    renderEmpty() {
      this.chrome([
        $('div', { class: 'empty' }, [
          $('p', { text: 'Click any element in the prototype.' }),
          $('p', { class: 'dim', html: 'Arrow keys walk the tree · <b>Esc</b> pauses so you can use the prototype · <b>⌘⇧I</b> resumes.' }),
          $('p', { class: 'dim', html: 'For menus, dropdowns and other transient UI: pause, open it, then <b>Alt+click</b> it — the click is shielded from the prototype, so it stays open while you inspect it.' }),
          $('p', { class: 'dim', html: `<b>${Tokens.list.length}</b> tokens loaded${window.__DSI_TOKENS ? '' : ' <i>(page-derived only)</i>'}.` }),
        ]),
      ]);
    },

    render(spec) {
      this.spec = spec; this.audits = [];
      const c = spec.component;
      // Content is organised into tabs; every pane is rendered (hidden panes
      // use display:none) so searching/copying still sees everything.
      const over = [], styles = [], struct = [], css = [];
      const nodes = over;

      /* 1 — IDENTITY CARD. What it is, its status, and where it lives —
         everything a reader scans first, in one place, top to bottom:
         name · variant → status chips → jump links → provenance lines. */
      const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
      const ts = c.typeStyle || null;
      const origin = {
        declared: 'From the design system',
        mapped: 'From the design system',
        inferred: 'Best guess — not labelled',
        unmapped: 'Not a design-system component',
        text: ts && ts.name ? 'Typography instance' : 'Text — no matching type style',
        part: `Part of ${c.partOf || 'a component'}`,
      }[c.confidence];
      const strongId = c.confidence === 'declared' || c.confidence === 'mapped';
      const bucket = c.story ? ['ok', 'In code — use the real component']
        : c.figma ? ['warn', 'In design, not in code yet']
        : strongId ? ['bad', 'Not in Coin or code yet'] : null;
      const heroName = c.confidence === 'text' ? (ts && ts.name) || 'Text' : c.name || 'Unlabelled element';
      nodes.push($('div', { class: 'sect hero' }, [
        $('div', { class: 'comprow' }, [
          $('span', { class: 'compname', text: heroName }),
        ]),
        c.confidence === 'text' && ts && ts.name ? $('div', { class: 'libline' }, [$('span', { class: 'libdot' }), $('span', { text: 'Coin typography' })]) : null,
        c.library ? $('div', { class: 'libline' }, [$('span', { class: 'libdot' }), $('span', { text: c.library })]) : null,
        $('div', { class: 'chips' }, [
          $('span', { class: `chip ${strongId || c.confidence === 'part' || (c.confidence === 'text' && ts && ts.name) ? 'quiet' : c.confidence === 'text' ? 'warn' : c.confidence}`, text: origin }),
          c.confidence === 'text' && c.partOf ? $('span', { class: 'chip quiet', text: `Inside ${c.partOf}` }) : null,
          bucket ? $('span', { class: `chip ${bucket[0]}`, text: bucket[1] }) : null,
        ]),
        c.confidence === 'part' && c.part ? $('div', { class: 'fprops' }, [this.propWell('Part', `.${c.part}`)]) : null,
        ts ? $('div', { class: 'fprops' }, [
          this.propWell('Type style', (ts.name || 'Off-system') + (ts.nearest ? ` — closest: ${ts.nearest.name}` : '')),
          this.propWell('Size / Line', `${ts.actual.size}${ts.actual.lh ? ` / ${ts.actual.lh}` : ''}`),
          this.propWell('Font', `${cap(ts.actual.fam || '—')} · ${ts.actual.weight}`),
          ts.actual.color ? this.propWell('Fill', figmaColorFor(ts.actual.color, 'color') || humanVal(ts.actual.color)) : null,
        ]) : null,
        spec.variant.length ? $('div', { class: 'fprops' },
          spec.variant.map((v) => this.propWell(v.key === 'modifier' ? 'Variant' : cap(v.key), cap(v.value)))) : null,
        spec.states.length ? $('div', { class: 'fprops' }, [this.propWell('Live state', spec.states.join(', '))]) : null,
        (c.story || c.figma) ? $('div', { class: 'links' }, [
          c.story ? $('a', { class: 'lbtn', href: c.story, target: '_blank', text: 'Storybook ↗' }) : null,
          c.figma ? $('a', { class: 'lbtn', href: c.figma, target: '_blank', text: 'Figma ↗' }) : null,
        ]) : null,
        c.code ? $('div', { class: 'crumb', text: c.code }) : null,
        c.notes ? $('div', { class: 'note', text: c.notes }) : null,
      ]));

      /* 2 — DOES IT MATCH. One block, one answer. */
      nodes.push(this.assessment(spec));

      /* 2b — INTERACTIONS. What the CSS says happens on hover / press / focus. */
      if (spec.interactions && spec.interactions.length) {
        const LBL = { hover: 'On hover', active: 'On press', focus: 'On focus', 'focus-visible': 'On focus', 'focus-within': 'On focus within', disabled: 'When disabled', checked: 'When checked' };
        const kids = [];
        for (const g of spec.interactions) {
          kids.push($('div', { class: 'grouphd', text: LBL[g.state] || g.state }));
          for (const ch of g.changes) {
            kids.push($('div', { class: 'diff tight' }, [
              $('div', { class: 'dvals' }, [
                $('span', { class: 'dprop inline', text: ch.label }),
                ch.from ? $('span', { class: 'dgot' }, [ch.color ? $('span', { class: 'sw', style: `background:${ch.from}` }) : null, $('span', { text: humanVal(ch.from) })]) : null,
                ch.from ? $('span', { class: 'darrow', text: '→' }) : null,
                $('span', { class: 'dwant' }, [ch.color ? $('span', { class: 'sw', style: `background:${ch.to}` }) : null, $('span', { text: humanVal(ch.to) })]),
              ]),
            ]));
          }
        }
        nodes.push(this.section('Interactions', kids));
      }

      /* 3 — WHAT IT IS MADE OF. */
      if (spec.madeOf.length) {
        struct.push(this.section(`Made of ${spec.madeOf.length} component${spec.madeOf.length > 1 ? 's' : ''}`,
          spec.madeOf.map((m) => $('div', { class: 'made', style: `padding-left:${m.depth * 14}px` }, [
            $('span', { class: `mname ${m.confidence}`, text: m.name }),
            m.variant ? $('span', { class: 'mvar', text: m.variant }) : null,
            m.text ? $('span', { class: 'mtext', text: `“${m.text}”` }) : null,
          ]))));
      }
      if (spec.insideOf.length) {
        struct.push(this.section('Sits inside', [
          $('div', { class: 'path', text: spec.insideOf.map((x) => x.name + (x.variant ? ` (${x.variant})` : '')).join('  ›  ') }),
        ]));
      }

      /* 4 — DETAIL, collapsed. For the developer, not for the review. */
      const byGroup = {};
      spec.props.forEach((p) => (byGroup[p.group] = byGroup[p.group] || []).push(p));
      const detail = [];
      for (const [g, rows] of Object.entries(byGroup)) {
        detail.push($('div', { class: 'grouphd', text: g }));
        rows.forEach((r) => detail.push(this.propRow(r)));
      }
      styles.push(this.section('All styles', detail));

      const L = spec.layout;
      styles.push(this.section('Size & layout', [
        this.kv('Size', `${spec.box.w} × ${spec.box.h}`),
        this.kv('Arrangement', L.display + (L.display.includes('flex') && L.direction ? ` · ${L.direction}` : '')),
        L.grid ? this.kv('Columns', L.grid) : null,
        L.gap ? this.kv('Gap', L.gap) : null,
        this.kv('Padding', spec.box.padding),
      ]));

      struct.push(this.section('Markup', [$('div', { class: 'code', text: `<${spec.tag}${spec.classes.length ? ` class="${spec.classes.join(' ')}"` : ''}${spec.attrs.length ? '\n  ' + spec.attrs.join('\n  ') : ''}>` })]));

      if (spec.rules.length) {
        css.push(this.section(`Matched rules (${spec.rules.length})`, spec.rules.map((r) =>
          $('details', { class: 'rule', open: '' }, [
            $('summary', { html: `<code>${esc(r.selector)}</code>${r.media ? `<span class="media">@${esc(r.media)}</span>` : ''}` }),
            $('div', { class: 'code', text: r.decls.join(';\n') + ';' }),
          ])
        )));
      } else {
        css.push($('div', { class: 'sect' }, [$('div', { class: 'sub dim', text: 'No stylesheet rules match this element.' })]));
      }

      this.activeTab = this.activeTab || 'Overview';
      const TABS = [['Overview', over], ['Styles', styles], ['Structure', struct], ['CSS rules', css]];
      const bar = $('div', { class: 'ptabs' }, TABS.map(([name]) =>
        $('button', {
          class: 'ptab' + (name === this.activeTab ? ' on' : ''), text: name,
          onclick: () => { this.activeTab = name; this.render(spec); },
        })));
      const panes = TABS.map(([name, kids]) =>
        $('div', { class: 'pane', style: name === this.activeTab ? '' : 'display:none' }, kids.filter(Boolean)));
      this.chrome([bar, ...panes]);
    },

    // The one thing the panel exists to say — a single block, plain words.
    assessment(spec) {
      const c = spec.component;
      const sp = spec.spec;
      const ov = spec.overrides || [];
      const strong = c.confidence === 'declared' || c.confidence === 'mapped';
      const off = spec.props.filter((p) => p.offSystem && !p.inherited);

      // A text element is judged as a typography instance, not a component.
      if (c.confidence === 'text') {
        const ts = c.typeStyle;
        if (ts && ts.name) {
          // The style match already vouches for the type properties — only
          // non-typography values (colour, spacing) can still be off.
          const offNonType = off.filter((p) => !/^(font-|line-height|letter-spacing|text-)/.test(p.prop));
          return $('div', { class: 'sect verdict good' }, [
            $('div', { class: 'vhead', text: `Matches the ${ts.name} type style` }),
            $('div', { class: 'sub dim', text: `${ts.size}/${ts.lineHeight} ${ts.family} ${ts.weight} — Coin typography.` }),
            ...(offNonType.length ? [$('div', { class: 'sub dim', text: `Separately, ${offNonType.length} value${offNonType.length > 1 ? 's are' : ' is'} not from the design system:` }),
            ...offNonType.slice(0, 4).map((p) => this.looseDiff(p))] : []),
          ]);
        }
        return $('div', { class: 'sect verdict warn' }, [
          $('div', { class: 'vhead', text: 'Not a Coin type style' }),
          $('div', { class: 'sub dim', text: `${ts.actual.size}px at weight ${ts.actual.weight} doesn't match any Coin text style${ts.nearest ? ` — closest is ${ts.nearest.name} (${ts.nearest.size}/${ts.nearest.lineHeight}, ${ts.nearest.weight})` : ''}.` }),
          ...off.slice(0, 4).map((p) => this.looseDiff(p)),
        ]);
      }

      // A part of a registered component is checked loosely — its identity is
      // its owner's business, only its token usage is its own.
      if (c.confidence === 'part') {
        if (!off.length) {
          return $('div', { class: 'sect verdict good' }, [
            $('div', { class: 'vhead', text: `Part of ${c.partOf} — on-system` }),
            $('div', { class: 'sub dim', text: 'Every value this part uses comes from the design system.' }),
          ]);
        }
        return $('div', { class: 'sect verdict warn' }, [
          $('div', { class: 'vhead', text: `Part of ${c.partOf} — ${off.length} value${off.length > 1 ? 's' : ''} off-system` }),
          ...off.slice(0, 4).map((p) => this.looseDiff(p)),
        ]);
      }

      // A guess never gets judged against a spec — that reads as confident
      // nonsense. It gets one nudge: label it, then it can be checked.
      if (!strong) {
        return $('div', { class: 'sect verdict warn' }, [
          $('div', { class: 'vhead', text: c.name ? `Looks like a ${c.name}, but isn't labelled` : 'Not labelled as a component' }),
          $('div', { class: 'sub dim', html: `Add <code>data-ds="${esc(c.name || 'Name')}"</code> to the element${c.name ? ', or register its class in <code>registry.json</code>,' : ''} to check it against the design system.` }),
          ...(off.length ? [$('div', { class: 'sub dim', text: `Separately, ${off.length} value${off.length > 1 ? 's are' : ' is'} not from the design system:` }),
          ...off.slice(0, 4).map((p) => this.looseDiff(p))] : []),
        ]);
      }

      const diffs = (sp && sp.diffs) || [];

      // When one prototype class supplies most of the styling, this isn't a
      // broken instance — it's the prototype's own component built on top.
      // Say that once, instead of listing every property it defines.
      const blockOf = (sel) => { const m = /\.([a-zA-Z0-9_-]+)/.exec(sel || ''); return m ? m[1].split(/--|__/)[0] : null; };
      const counts = {};
      ov.forEach((o) => { const b = blockOf(o.from); if (b) counts[b] = (counts[b] || 0) + 1; });
      const [topBlock, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [null, 0];
      if (topCount >= 4 && topCount >= ov.length - 1) {
        return $('div', { class: 'sect verdict warn' }, [
          $('div', { class: 'vhead', text: `This is its own component — “${topBlock}”, built on ${c.name}` }),
          $('div', { class: 'sub dim', html: `Most of its styling comes from <code>.${esc(topBlock)}</code>, not from ${esc(c.name)}. If it's meant to be a real component, register <code>.${esc(topBlock)}</code> in <code>registry.json</code> (or build it in Coin). If it's meant to just be a ${esc(c.name)}, remove the extra styling.` }),
          ...(diffs.length ? [
            $('div', { class: 'subhead', text: `Where it departs from ${c.name}` }),
            ...diffs.slice(0, 4).map((d) => this.diffRow(d)),
          ] : []),
        ]);
      }

      if (sp && sp.checked && !diffs.length && !ov.length) {
        return $('div', { class: 'sect verdict good' }, [
          $('div', { class: 'vhead', text: `Matches the ${c.name} spec` }),
          $('div', { class: 'sub dim', text: `${sp.checked} propert${sp.checked === 1 ? 'y' : 'ies'} checked against ${sp.variant === '*' ? 'the component' : sp.variant}. Nothing added on top.` }),
        ]);
      }

      if (diffs.length || ov.length) {
        const kids = [];
        if (diffs.length) {
          kids.push($('div', { class: 'vhead', text: `Deviates from the ${c.name} spec` }));
          kids.push($('div', { class: 'sub dim', text: `${diffs.length} of ${sp.checked} checked properties differ from ${sp.variant === '*' ? 'the component' : sp.variant}.` }));
          kids.push(...diffs.map((d) => this.diffRow(d)));
        }
        if (ov.length) {
          kids.push($('div', { class: diffs.length ? 'subhead' : 'vhead', text: `${ov.length} change${ov.length > 1 ? 's' : ''} on top of ${c.name}` }));
          if (!diffs.length) kids.push($('div', { class: 'sub dim', text: 'Styling this prototype adds over the base component — agree it into the system, or drop it.' }));
          kids.push(...ov.slice(0, 4).map((o) => this.overrideRow(o)));
          if (ov.length > 4) kids.push($('details', { class: 'more' }, [
            $('summary', { text: `Show ${ov.length - 4} more` }),
            ...ov.slice(4).map((o) => this.overrideRow(o)),
          ]));
        }
        return $('div', { class: `sect verdict ${diffs.length ? 'bad' : 'warn'}` }, kids);
      }

      if (sp && sp.unknownVariant) {
        return $('div', { class: 'sect verdict warn' }, [
          $('div', { class: 'vhead', text: `Unknown ${c.name} variant` }),
          $('div', { class: 'sub dim', text: `“${sp.unknownVariant}” is not a variant recorded for ${c.name}. Either it is a new one worth adding, or a mistake.` }),
        ]);
      }

      // No recorded spec — fall back to loose token checking.
      if (!off.length) {
        return $('div', { class: 'sect verdict good' }, [
          $('div', { class: 'vhead', text: 'Every value comes from the design system' }),
          $('div', { class: 'sub dim', html: `No spec recorded for ${esc(c.name)} yet, so this is a token check only. Add a <code>variants</code> block to <code>registry.json</code> to check it properly.` }),
        ]);
      }
      return $('div', { class: 'sect verdict bad' }, [
        $('div', { class: 'vhead', text: `${off.length} value${off.length > 1 ? 's are' : ' is'} not from the design system` }),
        ...off.map((p) => this.looseDiff(p)),
      ]);
    },

    // One spec difference: what it is, what it should be. Colours keep their
    // swatch; every value is shown as a token name when one matches.
    diffRow(d) {
      const isCol = /colour|Background|fill|stroke/i.test(plain(d.prop));
      return $('div', { class: 'diff' }, [
        $('div', { class: 'dprop', text: plain(d.prop) }),
        $('div', { class: 'dvals' }, [
          $('span', { class: 'dgot' }, [isCol ? $('span', { class: 'sw', style: `background:${d.got}` }) : null, $('span', { text: humanVal(d.got) })]),
          $('span', { class: 'darrow', text: 'should be' }),
          $('span', { class: 'dwant' }, [isCol ? $('span', { class: 'sw', style: `background:${d.want}` }) : null, d.token ? $('code', { text: d.token }) : $('span', { text: humanVal(d.want) })]),
        ]),
      ]);
    },

    // One added/overridden property: value, where it came from, what the base says.
    overrideRow(o) {
      return $('div', { class: 'diff' }, [
        $('div', { class: 'dprop' }, [$('span', { text: o.label }), $('code', { class: 'srctag', text: o.from })]),
        $('div', { class: 'dvals' }, [
          $('span', { class: 'dgot' }, [o.color ? $('span', { class: 'sw', style: `background:${o.value}` }) : null, $('span', { text: humanVal(o.value) })]),
          o.base ? $('span', { class: 'darrow', text: 'base is' }) : null,
          o.base ? $('span', { class: 'dwant', text: humanVal(o.base) }) : null,
          o.want && !o.base ? $('span', { class: 'darrow', text: 'spec says' }) : null,
          o.want && !o.base ? $('span', { class: 'dwant' }, [$('code', { text: o.want })]) : null,
        ]),
      ]);
    },

    looseDiff(p) {
      const isCol = /colour|Background|fill|stroke/i.test(plain(p.prop));
      return $('div', { class: 'diff' }, [
        $('div', { class: 'dprop', text: plain(p.prop) }),
        $('div', { class: 'dvals' }, [
          $('span', { class: 'dgot' }, [isCol ? $('span', { class: 'sw', style: `background:${p.value}` }) : null, $('span', { text: p.value })]),
          p.nearest ? $('span', { class: 'darrow', text: 'closest' }) : null,
          p.nearest ? $('span', { class: 'dwant' }, [isCol ? $('span', { class: 'sw', style: `background:${p.nearest.value}` }) : null, $('span', { text: p.nearest.value }), $('code', { text: p.nearest.name })]) : $('span', { class: 'darrow', text: 'nothing close in the system' }),
        ]),
      ]);
    },

    section(title, kids, collapsed) {
      const filtered = (kids || []).filter(Boolean);
      if (!filtered.length) return null;
      const d = $('details', { class: 'sect' }, [$('summary', { text: title }), $('div', { class: 'sectbody' }, filtered)]);
      if (!collapsed) d.setAttribute('open', '');
      return d;
    },

    // Figma-style property row: muted label on the left, value in a well.
    propWell(k, v) {
      return $('div', { class: 'frow' }, [
        $('div', { class: 'flabel', text: k }),
        $('div', { class: 'fwell', text: v }),
      ]);
    },

    kv(k, v, note) {
      return $('div', { class: 'frow' }, [
        $('div', { class: 'flabel', text: k }),
        $('div', { class: 'fwell' }, [$('span', { text: v }), note ? $('span', { class: 'dim src', text: ` ${note}` }) : null]),
      ]);
    },

    propRow(r) {
      const swatch = /color|fill|stroke/.test(r.prop) ? $('span', { class: 'sw', style: `background:${r.value}` }) : null;
      const val = $('div', { class: 'v' }, [swatch, $('span', { text: r.value })]);
      r = { ...r, prop: plain(r.prop) };
      let tokenNode;
      if (r.token) {
        tokenNode = $('div', { class: 'tok ok' }, [
          r.figma ? $('code', { class: 'figvar', text: r.figma }) : null,
          $('code', { text: r.token.name }),
          r.token.alias ? $('span', { class: 'dim', text: `→ ${r.token.alias}` }) : null,
          r.authoredVar ? $('span', { class: 'tag', text: 'in CSS' }) : null,
          r.token.origin === 'page' ? $('span', { class: 'tag warnt', text: 'page-local' }) : null,
        ]);
      } else if (r.figma) {
        tokenNode = $('div', { class: 'tok ok' }, [$('code', { class: 'figvar', text: r.figma })]);
      } else if (r.offSystem && r.inherited) {
        tokenNode = $('div', { class: 'tok' }, [$('span', { class: 'tag', text: 'inherited' })]);
      } else if (r.offSystem) {
        tokenNode = $('div', { class: 'tok bad' }, [
          $('span', { text: 'off-system' }),
          r.nearest ? $('span', { class: 'dim', html: `nearest <code>${esc(r.nearest.name)}</code> ${esc(r.nearest.value)}` }) : null,
        ]);
      } else tokenNode = null;
      return $('div', { class: 'row prop' }, [$('div', { class: 'k', text: r.prop }), $('div', { class: 'vv' }, [val, tokenNode])]);
    },

    runAudit() {
      this.audits = []; this.spec = null;
      this.audits.push(auditPage());
      broadcast({ type: 'audit-request' });
      setTimeout(() => this.renderAudit(), 250);
    },
    addAudit(a) { this.audits.push(a); this.renderAudit(); },

    // Jump from an audit finding to the actual element: scroll it into view
    // and select it, in whichever frame it lives.
    locate(o) {
      if (!o) return;
      if (o.frame === 'main') {
        const el = (window.__DSI_AUDIT_ELS || [])[o.i];
        if (el && el.isConnected) {
          try { el.scrollIntoView({ block: 'center' }); } catch {}
          select(el);
        }
        return;
      }
      broadcast({ type: 'audit-locate', frame: o.frame, index: o.i });
    },

    renderAudit() {
      const tot = this.audits.reduce((s, a) => s + a.total, 0);
      const clean = this.audits.reduce((s, a) => s + a.clean, 0);
      const cov = tot ? Math.round((clean / tot) * 100) : 0;
      const merge = (key) => {
        const m = new Map();
        this.audits.forEach((a) => a[key].forEach((r) => {
          const k = r.value || r.key;
          if (!m.has(k)) m.set(k, { ...r, occ: [] });
          else m.get(k).count += r.count;
          const rec = m.get(k);
          for (const o of r.occ || []) if (rec.occ.length < 6) rec.occ.push({ ...o, frame: a.frame });
        }));
        return Array.from(m.values()).sort((x, y) => y.count - x.count);
      };
      // Where each finding lives: one clickable chip per occurrence — click
      // scrolls to the element and selects it.
      const occRow = (r) => (r.occ && r.occ.length) ? $('div', { class: 'occ' }, r.occ.map((o) =>
        $('button', { class: 'occbtn', title: o.path, text: o.comp, onclick: () => this.locate(o) }))) : null;
      const colors = merge('offColors'), sizes = merge('offSizes'), unmapped = merge('unmapped');
      const nodes = [
        $('div', { class: 'sect' }, [
          $('div', { class: 'compname' }, [$('span', { text: 'Handoff audit' }), $('span', { class: `pill ${cov > 85 ? 'ok' : cov > 60 ? 'warn' : 'bad'}`, text: `${cov}% on-system` })]),
          $('div', { class: 'sub dim', text: `${clean} of ${tot} visible elements use only design-system values · ${this.audits.length} frame(s)` }),
        ]),
        this.section(`Off-system colours (${colors.length})`, colors.map((c) =>
          $('div', { class: 'row' }, [
            $('div', { class: 'k' }, [$('span', { class: 'sw', style: `background:${c.value}` })]),
            $('div', { class: 'vv' }, [
              $('div', { class: 'v', text: `${c.value}  ×${c.count}` }),
              $('div', { class: 'tok ' + (c.nearest ? 'warn' : 'bad') , html: c.nearest ? `use <code>${esc(c.nearest.name)}</code> (${esc(c.nearest.value)})` : `no close token — ${esc(c.props.join(', '))}` }),
              occRow(c),
            ]),
          ])
        )),
        this.section(`Off-system sizes (${sizes.length})`, sizes.map((c) =>
          $('div', { class: 'row' }, [
            $('div', { class: 'k', text: c.props.join(', ') }),
            $('div', { class: 'vv' }, [
              $('div', { class: 'v', text: `${c.value}  ×${c.count}` }),
              c.nearest ? $('div', { class: 'tok warn', html: `use <code>${esc(c.nearest.name)}</code> (${esc(c.nearest.value)})` }) : null,
              occRow(c),
            ]),
          ])
        )),
        this.section(`Undeclared components (${unmapped.length})`, unmapped.map((u) =>
          $('div', { class: 'row' }, [
            $('div', { class: 'k', text: `×${u.count}` }),
            $('div', { class: 'vv' }, [
              $('div', { class: 'v' }, [$('code', { text: u.key })]),
              $('div', { class: 'tok ' + (u.guess ? 'warn' : 'bad'), html: u.guess ? `guessed <b>${esc(u.guess)}</b> — declare with <code>data-ds</code>` : 'no component mapping' }),
              occRow(u),
            ]),
          ])
        ), true),
      ];
      this.chrome(nodes);
    },

    copySpec() {
      const text = this.spec ? specToMarkdown(this.spec) : this.audits.length ? auditToMarkdown(this.audits) : '';
      if (!text) return;
      navigator.clipboard.writeText(text).then(
        () => this.toast('Copied to clipboard'),
        () => this.toast('Copy blocked — see console'),
      );
      console.log(text);
    },
    toast(msg) {
      const t = $('div', { class: 'toast', text: msg });
      this.wrap.append(t);
      setTimeout(() => t.remove(), 1600);
    },
  };

  function specToMarkdown(s) {
    const L = [];
    L.push(`### ${s.component.name || s.tag} ${s.component.confidence === 'declared' ? '' : `_(${s.component.confidence})_`}`);
    L.push(`\`<${s.tag}${s.classes.length ? ` class="${s.classes.join(' ')}"` : ''}>\``);
    if (s.variant.length) L.push(`\n**Variant:** ` + s.variant.map((v) => `${v.key}=${v.value}`).join(', '));
    if (s.states.length) L.push(`**State:** ${s.states.join(', ')}`);
    if (s.component.library || s.component.figma || s.component.story) {
      const bucket = s.component.story ? 'in code — use the real component' : s.component.figma ? 'in design, not in code yet' : 'not in the system yet';
      L.push(`**Design system:** ${bucket}${s.component.figmaPath ? ` · ${s.component.figmaPath}` : ''}`);
      if (s.component.story) L.push(`**Storybook:** ${s.component.story}`);
      if (s.component.figma) L.push(`**Figma:** ${s.component.figma}`);
    }
    if (s.overrides && s.overrides.length) {
      L.push(`\n**Changes on top of ${s.component.name}:**`);
      s.overrides.forEach((o) => L.push(`- ${o.label}: \`${o.value}\`${o.base ? ` (base \`${o.base}\`)` : ''}${o.want ? ` (spec \`${o.want}\`)` : ''} — from \`${o.from}\``));
    }
    L.push(`\n| Property | Value | Token |`, `| --- | --- | --- |`);
    s.props.forEach((p) => L.push(`| ${p.prop} | \`${p.value}\` | ${p.token ? `\`${p.token.name}\`` : p.offSystem ? `⚠️ off-system${p.nearest ? ` (nearest \`${p.nearest.name}\`)` : ''}` : '—'} |`));
    L.push(`\n**Box:** ${s.box.w}×${s.box.h} · padding ${s.box.padding} · ${s.layout.display}${s.layout.gap ? ` · gap ${s.layout.gap}` : ''}`);
    L.push(`**Path:** \`${s.path.join(' > ')}\``);
    if (s.rules.length) {
      L.push(`\n<details><summary>Matched CSS</summary>\n`);
      s.rules.forEach((r) => L.push('```css\n' + r.selector + ' {\n  ' + r.decls.join(';\n  ') + ';\n}\n```'));
      L.push(`</details>`);
    }
    return L.join('\n');
  }

  function auditToMarkdown(audits) {
    const tot = audits.reduce((s, a) => s + a.total, 0), clean = audits.reduce((s, a) => s + a.clean, 0);
    const L = [`## Design-system handoff audit`, `${Math.round((clean / tot) * 100)}% of ${tot} visible elements use only design-system values.\n`];
    const all = (k) => audits.flatMap((a) => a[k]);
    L.push(`### Off-system colours\n`, `| Value | Uses | Suggested token |`, `| --- | --- | --- |`);
    all('offColors').forEach((c) => L.push(`| \`${c.value}\` | ${c.count} | ${c.nearest ? `\`${c.nearest.name}\` (${c.nearest.value})` : '—'} |`));
    L.push(`\n### Off-system sizes\n`, `| Value | Props | Uses | Suggested |`, `| --- | --- | --- | --- |`);
    all('offSizes').forEach((c) => L.push(`| \`${c.value}\` | ${c.props.join(', ')} | ${c.count} | ${c.nearest ? `\`${c.nearest.name}\`` : '—'} |`));
    L.push(`\n### Undeclared components\n`, `| Selector | Uses | Guess |`, `| --- | --- | --- |`);
    all('unmapped').forEach((u) => L.push(`| \`${u.key}\` | ${u.count} | ${u.guess || '—'} |`));
    return L.join('\n');
  }

  const PANEL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap {
    position: fixed; top: 0; right: 0; width: 390px; height: 100vh;
    background: #0F1E24; color: #E1E5E4; display: flex; flex-direction: column;
    font: 400 12px/1.55 ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif;
    box-shadow: -8px 0 32px rgba(0,0,0,.28); border-left: 1px solid #26383f;
  }
  .wrap.paused { opacity: .92; }
  .wrap.floating { height: min(85vh, 760px); border-radius: 10px; border: 1px solid #2b444c;
                   box-shadow: 0 16px 56px rgba(0,0,0,.5); overflow: hidden; }
  .hd { cursor: grab; user-select: none; }
  .hd:active { cursor: grabbing; }
  .wrap, .wrap * { cursor: default; }
  .gh, summary, a { cursor: pointer !important; }
  .reopen { position: fixed; top: 10px; right: 10px; z-index: 2147483647;
            background: #0F1E24; color: #5ED0BB; border: 1px solid #2f474f;
            border-radius: 6px; padding: 6px 9px; font: 600 12px/1 ui-sans-serif, system-ui;
            cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.3); }
  .hd { display:flex; align-items:center; justify-content:space-between; gap:8px;
        padding:10px 12px; border-bottom:1px solid #26383f; background:#132830; flex:0 0 auto; }
  .ttl { display:flex; align-items:center; gap:7px; font-weight:600; font-size:12px; letter-spacing:.01em; }
  .dot { width:8px; height:8px; border-radius:50%; background:#34A290; box-shadow:0 0 0 3px rgba(52,162,144,.2); }
  .hdbtns { display:flex; gap:5px; }
  .gh { background:#1c333b; border:1px solid #2f474f; color:#CDD3D3; font:500 11px/1 inherit;
        padding:5px 8px; border-radius:5px; cursor:pointer; }
  .gh:hover { background:#25424b; color:#fff; }
  .bd { overflow-y:auto; flex:1 1 auto; padding-bottom:24px; }
  .ptabs { display:flex; gap:2px; padding:8px 10px; border-bottom:1px solid #1d3138;
           position:sticky; top:0; background:#0F1E24; z-index:2; }
  .ptab { background:none; border:0; color:#7F8885; font:600 11.5px/1 inherit;
          padding:7px 11px; border-radius:6px; cursor:pointer !important; }
  .ptab:hover { color:#CDD3D3; background:#16292f; }
  .ptab.on { background:#1c333b; color:#fff; }
  .bd::-webkit-scrollbar { width:9px; } .bd::-webkit-scrollbar-thumb { background:#2b444c; border-radius:9px; }
  .sect { border-bottom:1px solid #1d3138; padding:12px 14px; }
  details.sect { padding:0; }
  .pane { padding:4px 0 14px; }
  .pane > .sect, .pane > details.sect { margin:8px 10px 0; border:1px solid #223740;
        border-radius:8px; background:#111f26; overflow:hidden; }
  .pane > .hero { background:transparent; border-color:transparent; margin-top:2px; }
  .pane > .verdict.good { border-color:rgba(52,162,144,.35); }
  .pane > .verdict.bad { border-color:rgba(228,79,64,.35); }
  .pane > .verdict.warn { border-color:rgba(207,169,1,.35); }
  details.sect > summary { padding:11px 14px; cursor:pointer; font-weight:600; font-size:12px;
        color:#CDD3D3; list-style:none; display:flex; align-items:center; gap:6px; }
  details.sect > summary:hover { color:#fff; }
  details.sect > summary::-webkit-details-marker { display:none; }
  details.sect > summary::before { content:'▸'; color:#4F6564; font-size:10px; }
  details.sect[open] > summary::before { content:'▾'; }
  .sectbody { padding:2px 14px 14px; }
  .sectbody .frow + .frow { margin-top:6px; }
  .hero { padding:16px 14px; }
  .comprow { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .compname { font-size:17px; font-weight:660; color:#fff; letter-spacing:-.01em; }
  .variant { font-size:13px; color:#8FB3AE; font-weight:500; }
  .libline { margin-top:5px; display:flex; align-items:center; gap:7px; font-size:11.5px; color:#8FB3AE; }
  .libdot { width:7px; height:7px; border:1.5px solid #5ED0BB; transform:rotate(45deg);
            border-radius:1px; flex:0 0 auto; }
  .fprops { margin-top:12px; display:flex; flex-direction:column; gap:6px; }
  .frow { display:flex; align-items:center; gap:10px; min-width:0; }
  .flabel { flex:0 0 92px; font-size:11.5px; color:#7F8885; }
  .fwell { flex:1 1 auto; background:#16292f; border:1px solid #26383f; border-radius:6px;
           padding:6px 10px; font-size:12px; color:#E1E5E4; min-width:0;
           overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
  .chip { font-size:10.5px; font-weight:600; padding:3px 8px; border-radius:99px; letter-spacing:.01em; }
  .chip.quiet { background:#1c333b; color:#9AA7A6; }
  .chip.ok { background:rgba(52,162,144,.16); color:#5ED0BB; }
  .chip.warn, .chip.inferred { background:rgba(207,169,1,.15); color:#E8C93F; }
  .chip.bad, .chip.unmapped { background:rgba(228,79,64,.14); color:#F08076; }
  .links { display:flex; gap:8px; margin-top:12px; }
  .lbtn { display:inline-flex; align-items:center; padding:5px 11px; border:1px solid #2f474f;
          border-radius:6px; color:#5ED0BB; font-size:11px; font-weight:600;
          text-decoration:none; background:#14262d; }
  .lbtn:hover { background:#1c333b; border-color:#3d5a63; }
  .crumb { margin-top:6px; font:400 10.5px/1.5 ui-monospace,monospace; color:#67716E; word-break:break-word; }
  .links + .crumb { margin-top:12px; }
  .diff.tight { margin-top:5px; }
  .dprop.inline { display:inline-block; min-width:96px; margin-bottom:0; }

  .verdict { padding:12px; }
  .verdict .vhead { font-size:13px; font-weight:640; margin-bottom:3px; }
  .verdict.good { background:rgba(52,162,144,.07); border-left:3px solid #34A290; }
  .verdict.good .vhead { color:#5ED0BB; }
  .verdict.bad { background:rgba(228,79,64,.07); border-left:3px solid #E44F40; }
  .verdict.bad .vhead { color:#F08076; }
  .verdict.warn { background:rgba(207,169,1,.07); border-left:3px solid #CFA901; }
  .verdict.warn .vhead { color:#E8C93F; }
  .diff { margin-top:9px; }
  .dprop { font-size:11px; color:#9AA7A6; margin-bottom:2px; }
  .subhead { margin-top:14px; font-size:12.5px; font-weight:640; color:#E8C93F; }
  .srctag { margin-left:6px; font-size:9.5px; color:#67716E; background:#17282e;
            padding:1px 4px; border-radius:3px; }
  details.more { margin-top:8px; }
  details.more > summary { cursor:pointer; font-size:10.5px; color:#67716E; list-style:none; }
  details.more > summary::before { content:'▸ '; }
  details.more[open] > summary::before { content:'▾ '; }
  .dvals { display:flex; flex-wrap:wrap; align-items:center; gap:6px;
           font:400 11px/1.5 ui-monospace,monospace; }
  .dgot, .dwant { display:inline-flex; align-items:center; gap:4px; }
  .dgot { color:#F5A79F; }
  .dwant { color:#5ED0BB; }
  .dwant code { background:rgba(52,162,144,.16); color:#5ED0BB; padding:1px 4px; border-radius:3px; }
  .darrow { font-family:inherit; font-size:10px; color:#67716E; }

  .made { padding:4px 0; border-top:1px solid #17282e; display:flex; align-items:baseline;
          gap:7px; flex-wrap:wrap; font-size:11.5px; }
  .made:first-child { border-top:0; }
  .mname { font-weight:600; color:#CDD3D3; }
  .mname.inferred { color:#E8C93F; font-weight:500; }
  .mvar { font-size:10.5px; color:#8FB3AE; }
  .mtext { font-size:10.5px; color:#67716E; }
  .grouphd { margin:12px 0 4px; font-size:11px; color:#7F8885; font-weight:600; }
  .grouphd:first-child { margin-top:2px; }
  .pill { display:inline-block; font:600 9px/1 inherit; text-transform:uppercase; letter-spacing:.06em;
          padding:3px 6px; border-radius:99px; margin-bottom:4px; }
  .pill.ok { background:rgba(52,162,144,.18); color:#5ED0BB; }
  .pill.warn { background:rgba(207,169,1,.18); color:#E8C93F; }
  .pill.bad { background:rgba(228,79,64,.16); color:#F08076; }
  .sub { margin-top:4px; font-size:11px; color:#9AA7A6; word-break:break-word; }
  .dim { color:#67716E; }
  .hint { margin-top:8px; padding:7px 8px; background:rgba(207,169,1,.09);
          border:1px solid rgba(207,169,1,.22); border-radius:5px; font-size:11px; color:#E8C93F; }
  .note { margin-top:6px; font-size:11px; color:#9AA7A6; font-style:italic; }
  .link { display:inline-block; margin-top:8px; color:#5ED0BB; font-size:11px; text-decoration:none; }
  .link:hover { text-decoration:underline; }
  .row { display:flex; gap:10px; padding:5px 0; border-top:1px solid #17282e; align-items:flex-start; }
  .row:first-child { border-top:0; }
  .k { flex:0 0 108px; color:#7F8885; font:400 10.5px/1.5 ui-monospace,monospace; word-break:break-word; }
  .v, .vv { flex:1 1 auto; min-width:0; }
  .v { display:flex; align-items:center; gap:6px; font:400 11px/1.5 ui-monospace,monospace; color:#E1E5E4; word-break:break-word; }
  .sw { width:11px; height:11px; border-radius:3px; border:1px solid rgba(255,255,255,.25); flex:0 0 auto; }
  .src { font-size:10px; }
  .tok { margin-top:2px; display:flex; flex-wrap:wrap; align-items:center; gap:5px; font-size:10.5px; }
  .tok code { font:500 10.5px/1.5 ui-monospace,monospace; padding:1px 4px; border-radius:3px; }
  .tok.ok code { background:rgba(52,162,144,.16); color:#5ED0BB; }
  code.figvar, .tok.ok code.figvar { background:rgba(142,125,245,.16); color:#B8AEFA; }
  .tok.bad { color:#F08076; } .tok.bad code { background:rgba(228,79,64,.14); color:#F5A79F; }
  .tok.warn { color:#E8C93F; } .tok.warn code { background:rgba(207,169,1,.14); color:#F0DA7C; }
  .tag { font-size:9px; text-transform:uppercase; letter-spacing:.05em; padding:1px 4px;
         border-radius:3px; background:#223d45; color:#8FB3AE; }
  .tag.warnt { background:rgba(207,169,1,.14); color:#E8C93F; }
  .frametag { font-size:9.5px; padding:1px 5px; border-radius:3px; background:#223d45; color:#8FB3AE; }
  code { font-family: ui-monospace, "JetBrains Mono", monospace; font-size:10.5px; }
  .code { background:#0a161a; border:1px solid #1d3138; border-radius:5px; padding:7px 8px;
          font:400 10.5px/1.6 ui-monospace,monospace; color:#B3BDBC; white-space:pre-wrap;
          word-break:break-word; margin-top:4px; }
  details.rule { margin:4px 0; }
  details.rule > summary { cursor:pointer; font-size:11px; color:#9AA7A6; list-style:none; }
  details.rule > summary::-webkit-details-marker { display:none; }
  details.rule > summary::before { content:'▸ '; color:#4F6564; }
  details.rule[open] > summary::before { content:'▾ '; }
  .media { margin-left:6px; font-size:9.5px; color:#CFA901; }
  .path { font:400 10.5px/1.7 ui-monospace,monospace; color:#8FB3AE; word-break:break-word; }
  .empty { padding:18px 14px; }
  .empty p { margin:0 0 10px; font-size:12px; color:#9AA7A6; }
  .occ { display:flex; flex-wrap:wrap; gap:4px; margin-top:5px; }
  .occbtn { background:#1c333b; border:1px solid #2f474f; color:#8FB3AE;
            font:600 10px/1 inherit; padding:3px 8px; border-radius:99px; cursor:pointer !important; }
  .occbtn:hover { background:#25424b; color:#5ED0BB; border-color:#3d5a63; }
  .toast { position:absolute; bottom:14px; left:50%; transform:translateX(-50%);
           background:#34A290; color:#04201c; font-weight:600; font-size:11px;
           padding:6px 12px; border-radius:99px; }
  `;

  /* ------------------------------------------------------------- bootstrap */
  function start() {
    buildTokenIndex();
    buildFigmaIndex();
    if (IS_TOP) { Panel.mount(); watchFrames(); }
    document.documentElement.style.cursor = 'crosshair';
    // Test seam / console escape hatch: inspect any element without clicking.
    window.__DSI = { buildSpec, identify, readProps, matchedRules, auditPage, Tokens, Panel, select, setMode, specToMarkdown };
    console.log(`[DS Inspector] ready — ${Tokens.list.length} tokens${IS_TOP ? '' : ' (frame probe)'}`);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
