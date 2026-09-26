# Themes

A theme is **data**: a `theme.json` that gives a value to every role in the contract.
Components consume roles, never values, so any theme that satisfies the contract restyles
everything — the desktop's own chrome, shadcn-svelte primitives, and anything rendered
from a json-render spec — with no per-theme code.

Themes sit beside `plugins/` and follow the same conventions: a closed JSON Schema is
the source of truth, the files are validated by a self-check, and a hand-broken fixture
must be refused for the check to count.

```
themes/
├── contract/
│   ├── theme.schema.json    # the contract — every role, closed (draft 2020-12)
│   ├── tailwind.css         # roles → Tailwind v4 utilities (generated from the schema)
│   ├── shadcn-bridge.css    # shadcn-svelte's variable names answered from roles
│   └── base.css             # base styles + t-*/ed-* recipes, roles only
├── quiet-instrument/        # dark — temper's house theme
│   ├── theme.json           # source of truth
│   └── theme.css            # generated — never edit
├── quiet-instrument-paper/  # light counterpart
├── brand/                   # the threaded-t mark and wordmark, in currentColor
├── preview/index.html       # every role and the foundational components, both themes
├── scripts/themes.sh        # build · check · contrast · --self-check
└── tests/fixtures/broken/   # themes the check must refuse
```

## The contract

`contract/theme.schema.json` names every role a component may read. A theme must supply
all of them and may not invent more (`additionalProperties: false`): a component that
needs a colour the contract lacks is a change to the contract, reviewed as one, not a
theme quietly growing a private name.

| Group | Roles | Used for |
|---|---|---|
| Ground | `ground` `surface` `surface-raised` `overlay` | window, panels, popovers, modal scrim |
| Text | `text` `text-muted` `text-subtle` `text-faint` | reading, secondary, labels, disabled-only |
| Rule | `rule` `rule-strong` | hairlines, input outlines |
| Accent | `accent` `accent-muted` `accent-line` `accent-line-soft` `accent-wash` `accent-hover` `on-accent` `focus` | the single accent and its tints; the rail; keyboard focus |
| Conditions | `notice` `success` `danger` `pending` (+ `-wash` each) | attention, confirmation, destructive, awaiting-you |
| Region states | `region-arriving` `region-empty` `region-gave-up` `region-failed` (+ `-wash` each) | the four states a read can present as |
| Authorship | `author-human` `author-agent` | gutter and attribution marks |
| Doc types | `doctype-research` `-task` `-session` `-concept` `-goal` `-decision` `-memory` | temper's core vocabulary |
| Categorical | `cat-1` … `cat-8` | plugin vocabulary (see below) |
| Code | `code-key` `code-string` `code-number` `code-comment` | syntax highlighting |
| Font | `reading` `doing` `ui` | serif prose, mono technical, dense UI |
| Radius, motion, tracking | `chip` `panel` · `quick` `settle` `easing` · `label` `strip` `eyebrow` `ui` `mark` | shape and rhythm |

Every role becomes a CSS custom property `--tp-<role>` (`--tp-text-muted`,
`--tp-font-reading`, `--tp-motion-quick`) and a Tailwind utility with a `tp-` prefix
(`bg-tp-ground`, `text-tp-text-muted`, `border-tp-rule`, `font-tp-doing`). The prefix keeps
temper's roles apart from shadcn's names, where `accent` and `muted` mean other things.

### What the check enforces

`scripts/themes.sh --self-check` runs in CI. For every theme it checks:

- **The contract.** Every role present, none invented, every value `#rrggbb` or `rgba()`.
- **Legibility floors.** Contrast is measured on the colours as they paint — alpha
  composited over `ground`, washes composited before the text on them is measured.
  `text` 7:1; secondary and label text, the accent, doc types, conditions, region states
  and code 4.5:1; focus rings, authorship marks and categorical slots 3:1; `text-faint`
  2.5:1, which is why it is reserved for disabled and decorative marks and never carries
  information. `themes.sh contrast <theme.json>` prints every pair.
- **Distinctness.** The four region states, the eight categorical slots, the two
  authorship marks and the conditions must stay apart (CIE76 ΔE on the painted colour).
  Colour is only one of the channels that separates a failed read from a refused one, but
  a theme that collapses two of them has removed a channel, and that is checkable.
- **Generated files agree.** `theme.css` matches its `theme.json`; `contract/tailwind.css`
  covers every role in the schema.
- **Counterparts pair.** A theme's `counterpart` exists, points back, and has the
  opposite `appearance`.

And across the tree: the contract CSS carries no literal colour and references no role the
contract lacks; the brand marks paint in `currentColor`; every fixture in
`tests/fixtures/broken/` is refused.

## Using a theme

```css
@import "tailwindcss";
@import "<themes>/contract/tailwind.css";      /* roles as utilities; default palette reset */
@import "<themes>/contract/shadcn-bridge.css"; /* optional: shadcn-svelte components in-theme */
@import "<themes>/quiet-instrument/theme.css";
@import "<themes>/quiet-instrument-paper/theme.css";
@import "<themes>/contract/base.css";
```

Then choose the theme with one attribute: `<html data-theme="quiet-instrument">`.

`contract/tailwind.css` resets Tailwind's default palette. A component cannot reach for
`zinc-800` or `white`; if it needs a colour, it names a role.

A theme can also be applied without a build: the desktop can read a `theme.json` and set
each `--tp-*` property on the root element. That is how a theme installed after the app
was built — or one shipped by a plugin — takes effect.

## Plugin vocabulary and categorical slots

Plugins never name colours. A plugin that wants its own vocabulary tinted — author-tools'
`story`, `poem`, `journal` — binds each term to a categorical slot, and every theme
guarantees its eight slots are legible and mutually distinct:

```json
{ "vocabulary": { "story": { "tint": "cat-1" }, "poem": { "tint": "cat-2" } } }
```

The binding is part of the plugin's package, so the same term keeps the same slot in every
theme and on every surface that honours it.

## Adding a theme

1. Copy a theme directory and rename it; set `name` to the directory name.
2. Change values in `theme.json` — only values; the roles are fixed.
3. `scripts/themes.sh build` to regenerate `theme.css`.
4. `scripts/themes.sh check <name>/theme.json`, and `contrast` to see where you stand.
5. If it has a light/dark partner, set `counterpart` on both.

## The house theme

**Quiet Instrument** carries temper's visual voice to the desktop: obsidian ground,
parchment text, one steel-blue accent; Source Serif 4 for reading, JetBrains Mono for
doing, Inter only for dense UI. Semantic colour is a whisper — the conditions, doc types
and categorical slots exist for meaning, not decoration. Hover shifts colour and nothing
else; there is no bounce, no shadow, no gradient. The rail — a 2px accent-soft left
border — is the markdown blockquote marker made structural.

**Quiet Instrument — Paper** keeps the same restraint on a warm paper ground with ink
text and a deepened accent; every colour was re-chosen to clear the floors, not inverted.

Fonts are bundled by the app (`@fontsource-variable/*`), never fetched: the desktop must
render offline. `preview/index.html` loads them from Google Fonts for convenience only.

## Setup

```bash
cd themes
uv sync
scripts/themes.sh --self-check
```
