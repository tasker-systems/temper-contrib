# temper-contrib — agent fundamentals

Contrib home for temper packages: self-contained bundles of agent skills
(`skills/<pkg>/SKILL.md`), JSON Schema vocabularies (`schemas/`), and bash
scripts (`scripts/`) that compose with the temper CLI. This repo ships no
temper code; it depends on temper only through its public CLI surface.
temper itself lives in the sibling `tasker-systems/temper`.

## Layout

```
skills/<pkg>/SKILL.md   # agent-facing create/compile flows
schemas/*.json          # JSON Schema draft 2020-12 vocabularies — source of truth
scripts/*.sh            # bash + temper CLI; environment-specific, CI-able
tests/fixtures/         # conforming/ + broken/ open_meta payloads
.github/workflows/      # schema validity, lint self-checks, shellcheck
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
- Verify before pushing: `bash -n`, shellcheck, and `scripts/lint.sh
  --self-check` (a conforming payload passes, a hand-broken one fails). CI is
  the final gate, not the first.
