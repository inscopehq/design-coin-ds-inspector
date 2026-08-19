# What you need to do

Four things. Nothing else matters.

---

## 1. Add one line to every prototype

```html
<script src="ds-inspector.js"></script>
```

Copy `dist/ds-inspector.js` into your prototypes folder once. Any prototype with
that line is inspectable — by you, by a developer, by anyone you send the file
to. No server, no install, works by double-clicking the HTML.

That's what makes it "usable by other developers, opening any prototype".

---

## 2. Label your components

On the outermost element of a component, say what it is:

```html
<button class="btn" data-ds="Button" data-ds-variant="Primary">Save</button>
```

Only the outer element. Not the icon and the label inside it — those belong to
the Button.

This is the one thing only you can do. Without it, the tool is guessing from
class names. With it, the panel can say "this is a Button, Primary" and check it.

If a prototype already exists and you don't want to edit it, add its class to
`registry.json` instead and every instance is recognised at once:

```json
{ "name": "Stat", "match": [".kpi", ".metric"] }
```

---

## 3. Write down what each component should look like

This is what lets the tool say **"this deviates"** instead of just describing
what's there. In `registry.json`:

```json
{
  "name": "Button",
  "match": [".btn"],
  "variants": {
    "Primary": {
      "background-color": "--teal-primary",
      "color": "--white",
      "border-radius": "--radius-sm",
      "font-size": "--fs-body",
      "font-weight": "--fw-semibold"
    }
  }
}
```

Now clicking any Primary button gives you one of two answers:

> **Matches the Button spec** — 5 properties checked against Primary.

or

> **Deviates from the Button spec** — 2 of 5 checked properties differ.
> Background — `#2E9184` should be `#34A290` `--teal-primary`
> Corner radius — `9px` should be `5px` `--radius-sm`

You write each component's spec once. It is the same information that lives in
the Figma component — you're just recording it somewhere a machine can read.

Start with the five components you use most. A component with no spec still
gets checked loosely (are these values from the system at all?), so partial
coverage is genuinely useful — you don't have to finish before it pays off.

---

## 4. Use `var(--token)` instead of pasting values

```css
/* the tool can check this */
.card { background: var(--bg-1); border-radius: var(--radius-md); padding: var(--sp-m); }

/* the tool has to guess about this */
.card { background: #FFFFFF; border-radius: 12px; padding: 16px; }
```

Both look identical on screen. The first one survives a token change and reads
as a decision; the second is a magic number a developer will have to ask you
about.

---

## What you get from the panel

Click anything. Six things, in this order:

1. **What it is** — "Button", "Primary · Medium", and whether that came from
   your label or from the tool guessing.
2. **Does it match** — the green or red answer, in words, with the exact values
   that are wrong and what they should be.
3. **Changes on top of the design system** — when a DS component is used but
   this prototype layers extra styling over it (an inline style, a contextual
   rule like `.toolbar .btn`, a bolt-on class like `.btn.save-special`), each
   change is listed as *value → what the base component says*, with the exact
   selector it came from. These are the things to either agree into the system
   or drop before handoff. Detection uses the `match` selectors in
   `registry.json`: any matched rule whose selector stays inside the
   component's own naming (`.btn`, `.btn--primary`, `.btn__icon`, `is-*`
   states) is the component; anything else that wins a property is a change
   on top.
4. **In the design system** — which library owns the component, where it sits
   (breadcrumb), a jump link to Figma, and the code path. Filled from
   `figma` / `figmaPath` / `library` / `code` in `registry.json`; a file-level
   Figma URL works, and pasting the component's node URL (right-click the
   component in Figma → Copy link) upgrades it to a deep link.
5. **What it's made of** — the components nested inside it, indented. A Card
   shows you it contains two Buttons, and that one of them contains an Icon.
   This is the composition question you raised: components built from other
   components, captured as a tree.
6. **Everything else** — collapsed. Full styles, sizes, CSS. There when the
   developer wants it, out of the way when you're reviewing.

Press **Audit** for the same judgement across the whole page at once.

---

## For the developer receiving this

Send them the HTML file. They open it, click any element, and read the
component name, variant, what it's made of, and any deviation — without asking
you a single question.

The **⤓** button copies the current element (or the whole-page audit) as
markdown, if a written spec is needed for a ticket.
