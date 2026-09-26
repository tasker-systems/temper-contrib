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
apps/desktop/                # temper-desktop — Tauri app (SvelteKit UI in src/, Rust core in src-tauri/)
.github/workflows/           # plugin checks + desktop frontend/cargo checks
```

## Conventions

- Schemas: draft 2020-12, `additionalProperties: false` — the vocabulary
  contract only bites closed.
- Scripts: bash, shellcheck-clean; explicit targets/context args, no ambient
  assumptions.
- Personal identity never ships: author names and vault paths enter at
  install time, never in the repo.
- Public repo — a change must not narrate the gap it closes in commits, PR
  text, or doc diffs; in-progress reasoning lives in the temper vault.
- Branch `<initials>/<scope>`; commit messages carry no temper resource ids.
- Verify before pushing — plugins: `bash -n`, shellcheck, and
  `<pkg>/scripts/lint.sh --self-check` (a conforming payload passes, a
  hand-broken one fails); desktop app: `npm run check` and `cargo check`
  in `apps/desktop` (+ `cargo test -- --ignored` for the witnesses that
  need credentials or an agent binary). CI is the final gate, not the first.
