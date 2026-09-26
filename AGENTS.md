# temper-contrib — agent fundamentals

Contrib home for temper: plugin packages (`plugins/<pkg>/`) and desktop apps
(`apps/<app>/`) that compose with the temper CLI. Plugins depend on temper
only through its public CLI surface; the desktop app depends on temper through
crates.io (`temperkb-client`). This repo ships no temper code. temper itself
lives in the sibling `tasker-systems/temper`.

## Layout

```
plugins/<pkg>/               # self-contained plugin packages
  skills/<skill>/SKILL.md    # agent-facing create/compile flows
  schemas/*.json             # JSON Schema draft 2020-12 vocabularies — source of truth
  scripts/*.sh               # bash + temper CLI; environment-specific, CI-able
  tests/fixtures/            # conforming/ + broken/ open_meta payloads
themes/                      # theme contract (contract/theme.schema.json) + data-only themes
  <theme>/theme.json         # source of truth; theme.css beside it is generated
apps/desktop/                # temper-desktop — Tauri app (SvelteKit UI in src/, Rust core in src-tauri/)
.github/workflows/           # plugin checks + desktop frontend/cargo checks
```

## Conventions

- Schemas: draft 2020-12, `additionalProperties: false` — the vocabulary
  contract only bites closed.
- Themes: components read `--tp-*` roles (or `tp-` Tailwind utilities), never
  literal colours; a missing colour is a contract change, not a theme-local name.
  Plugins bind vocabulary to `cat-1`…`cat-8`, never to colours.
- Scripts: bash, shellcheck-clean; explicit targets/context args, no ambient
  assumptions.
- Personal identity (author names, vault paths) never enters the repo
  through agent or tooling action — it belongs to install time.
  Accountability is recorded deliberately, not leaked: `AUTHORS.md` carries
  the project's authors.
- Public repo — a change must not narrate the gap it closes in commits, PR
  text, or doc diffs; in-progress reasoning lives in the temper vault.
- Branch `<initials>/<scope>`; commit messages carry no temper resource ids.
- Verify before pushing — plugins: `bash -n`, shellcheck, and
  `<pkg>/scripts/lint.sh --self-check` (a conforming payload passes, a
  hand-broken one fails); themes: `themes/scripts/themes.sh build` after any
  `theme.json` or contract change, then `--self-check`; desktop app: `npm run check`, `npm test`, `npm run guard:colours` and `cargo check`
  in `apps/desktop` (+ `cargo test -- --ignored` for the witnesses that
  need credentials or an agent binary). CI is the final gate, not the first.
