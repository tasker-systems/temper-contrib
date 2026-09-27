# Contributing to temper-contrib

Thanks for contributing. This repository ships self-contained packages for
temper — keep your contribution inside one package's boundaries.

## Workflow

1. Branch off `main` as `<initials>/<scope>`.
2. Make your change.
3. Run the verification suite (below) locally.
4. Open a PR against `main`. CI must be green before merge.

## Setup

```bash
cargo install cargo-make           # or: brew install cargo-make
brew install shellcheck gitleaks actionlint ruff uv
cargo make setup                   # bun install, uv sync, git config core.hooksPath githooks
```

`githooks/pre-commit` runs only the checks a staged change can affect and scans
the staged change for secrets; `githooks/pre-push` runs the test suites for the
trees your branch changed. A hook whose tool is missing says so and skips; it
never passes silently. Cloud agent sessions run `tools/setup-claude-web.sh`
(the SessionStart hook in `.claude/settings.json`), which installs the same
toolchain.

## Verification

Run before every push — CI runs the same suite and is the final gate, not
the first:

```bash
cargo make check    # every quality gate, every package
cargo make test     # every test suite
cargo make fix      # apply rustfmt, clippy --fix, biome, ruff
```

Formatting is not a matter of taste here: rustfmt (Rust), Biome (TypeScript,
`apps/desktop/biome.json`) and Ruff (Python, `ruff.toml`) own it, and CI
fails on drift. Clippy and rustdoc run with warnings as errors.

The plugin package's contract, individually:

```bash
plugins/author-tools/scripts/lint.sh --self-check  # schemas valid, fixtures pass in both
                                          # directions, no private dependencies
```

`--self-check` is the contract: every schema validates as JSON Schema
draft 2020-12, every fixture in `plugins/author-tools/tests/fixtures/conforming/`
passes its vocabulary, every fixture in `plugins/author-tools/tests/fixtures/broken/`
fails its vocabulary, and no tracked file references a private vault or
prototype path.

Themes verify on their own:

```bash
cd themes && uv sync && cd ..
themes/scripts/themes.sh build        # regenerate theme.css + contract/tailwind.css
themes/scripts/themes.sh --self-check # contract, contrast floors, distinctness,
                                      # generated files in sync, broken fixtures refused
```

If you change a schema, change its fixtures with it: a new field needs a
conforming example, and a rejected shape deserves a broken fixture that
bites on exactly that shape.

## Adding a package

A plugin package is `plugins/<name>/` — typically `skills/<skill>/SKILL.md`
plus whatever `schemas/`, `scripts/`, and fixtures it needs. Skills teach
agent-facing flows; schemas are the source of truth for metadata vocabularies;
scripts are bash + temper CLI and must stay shellcheck-clean with explicit
arguments, no ambient assumptions. A theme is `themes/<name>/theme.json` — values for every role in
`themes/contract/theme.schema.json`, nothing more (see `themes/README.md`).
Desktop apps live under `apps/<name>/`;
add a new app's gates to `Makefile.toml` and the CI workflow together.

## Ground rules

- Draft 2020-12 schemas, `additionalProperties: false` — vocabularies are
  closed by intent.
- Personal identity (author names, vault paths, prototype repositories)
  never enters through agent or tooling action; it belongs to install time.
  Accountability is recorded deliberately, not leaked: `AUTHORS.md` carries
  the project's authors.
- Commit messages and PR descriptions state what the change does — they do
  not narrate weaknesses it closes.

## PR guidelines

`.github/pull_request_template.md` carries the sections: What, Why, Approach
(optional), Verification, Contract changes.

- One package or one cross-cutting concern per PR.
- The PR description states what changed and how it was verified.
- A schema, theme-contract or catalog change is a contract change: say so in
  the Contract changes section.
- The code carries the detail; the description carries no session narrative
  and, since this repository is public, no specs, plans or vault ids.
