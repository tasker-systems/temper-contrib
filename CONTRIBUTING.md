# Contributing to temper-contrib

Thanks for contributing. This repository ships self-contained packages for
temper — keep your contribution inside one package's boundaries.

## Workflow

1. Branch off `main` as `<initials>/<scope>`.
2. Make your change.
3. Run the verification suite (below) locally.
4. Open a PR against `main`. CI must be green before merge.

## Verification

Run before every push — CI runs the same suite and is the final gate, not
the first:

```bash
bash -n plugins/author-tools/scripts/*.sh   # parse check
shellcheck plugins/author-tools/scripts/*.sh  # lint (apt/brew install shellcheck)
plugins/author-tools/scripts/lint.sh --self-check  # schemas valid, fixtures pass in both
                                          # directions, no private dependencies
```

`--self-check` is the contract: every schema validates as JSON Schema
draft 2020-12, every fixture in `plugins/author-tools/tests/fixtures/conforming/`
passes its vocabulary, every fixture in `plugins/author-tools/tests/fixtures/broken/`
fails its vocabulary, and no tracked file references a private vault or
prototype path.

If you change a schema, change its fixtures with it: a new field needs a
conforming example, and a rejected shape deserves a broken fixture that
bites on exactly that shape.

## Adding a package

A plugin package is `plugins/<name>/` — typically `skills/<skill>/SKILL.md`
plus whatever `schemas/`, `scripts/`, and fixtures it needs. Skills teach
agent-facing flows; schemas are the source of truth for metadata vocabularies;
scripts are bash + temper CLI and must stay shellcheck-clean with explicit
arguments, no ambient assumptions. Desktop apps live under `apps/<name>/`;
the Rust side of a Tauri app verifies with `cargo check` in its `src-tauri/`.

## Ground rules

- Draft 2020-12 schemas, `additionalProperties: false` — vocabularies are
  closed by intent.
- Personal identity (author names, vault paths, prototype repositories)
  never ships; it enters at install time.
- Commit messages and PR descriptions state what the change does — they do
  not narrate weaknesses it closes.

## PR guidelines

- One package or one cross-cutting concern per PR.
- The PR description states what changed and how it was verified.
- A schema change is a contract change: say so explicitly in the PR.
