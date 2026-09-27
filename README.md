# temper-contrib

**Contrib home for [Temper](https://github.com/tasker-systems/temper) — plugins and desktop apps that compose with the temper CLI**

---

## What's Here

temper-contrib ships three kinds of artifacts:

- **Plugins** (`plugins/`) — self-contained packages that depend on temper only
  through its public CLI surface: agent skills, JSON Schema vocabularies, and
  operational scripts. Nothing here is required to run temper itself.
- **Themes** (`themes/`) — data-only visual themes over one role contract, so the
  desktop, its component primitives, and anything rendered from a plugin or agent
  spec restyle together. See [themes/README.md](themes/README.md).
- **Apps** (`apps/`) — desktop applications. `apps/desktop` is temper-desktop,
  a Tauri app that makes temper a native surface.

```
temper-contrib/
├── plugins/author-tools/          # author-tools plugin: writing create/compile flows
│   ├── skills/writing-templates/  # agent-facing flows (SKILL.md)
│   ├── schemas/                   # JSON Schema draft 2020-12 vocabularies — source of truth
│   ├── scripts/                   # install.sh, lint.sh, compile.sh, manifest.sh
│   └── tests/fixtures/            # conforming + hand-broken open_meta payloads
├── themes/                        # theme contract + themes (data) — see themes/README.md
│   ├── contract/                  # theme.schema.json, Tailwind + shadcn bridges, base recipes
│   └── quiet-instrument[-paper]/  # the house theme, dark and light
├── apps/desktop/                  # temper-desktop — Tauri app
│   ├── src/                       # SvelteKit 2 + Svelte 5 UI (SPA)
│   └── src-tauri/                 # Rust core: temper client + ACP host
└── .github/workflows/             # plugin checks + desktop cargo check
```

## The Author Tools Plugin

Temper-backed writing for five doc types — `journal`, `poem`, `story`,
`reflection`, `spec` — plus `collection` compilation. A document is a temper
resource: body is the writing, `open_meta` is the metadata. The vocabularies
in `plugins/author-tools/schemas/` define what metadata each type carries;
`scripts/lint.sh` enforces them at write time.

```bash
cd plugins/author-tools

# Validate an open_meta payload against a vocabulary
scripts/lint.sh story payload.json

# Full self-check (schemas, fixtures both directions, dependency hygiene)
scripts/lint.sh --self-check

# Install into your environment
scripts/install.sh --context @me/writing --author "Your Name" --targets agents,opencode
```

Personal identity enters at install time and never ships in this repository.

## temper-desktop

`apps/desktop` is a Tauri app: a SvelteKit 2 + Svelte 5 UI (SPA mode,
adapter-static) over a Rust core in `src-tauri/`. The core consumes
[`temperkb-client`](https://crates.io/crates/temperkb-client) from crates.io at
semver, reusing the machine's existing temper credentials, and hosts an
Agent Client Protocol (ACP) client that spawns agent subprocesses such as
`opencode acp`.

From a fresh clone:

```bash
cd apps/desktop
npm install
npm run tauri dev   # builds the Rust core and opens the app window
```

Verification is repository-wide; see [Development](#development). The desktop's
live witnesses need credentials or an agent on PATH and run by hand:
`cargo test -- --ignored` in `apps/desktop/src-tauri`.

## Development

One entry point runs every package's gates, the same ones CI runs
([cargo-make](https://github.com/sagiegurari/cargo-make)):

```bash
cargo make setup    # npm ci, uv sync, and point git at githooks/
cargo make check    # rustfmt, clippy, rustdoc, biome, svelte-check, literal colours,
                    # ruff, shellcheck, plugin + theme self-checks, actionlint, gitleaks
cargo make test     # cargo test + vitest (unit and component)
cargo make fix      # rustfmt, clippy --fix, biome --write, ruff
```

`githooks/pre-commit` runs only the batteries a staged change can affect (plus a
gitleaks scan of the staged change); `githooks/pre-push` runs the test suites for
the trees a branch changed. Missing tools skip loudly; CI runs everything.

## CI

| Job | Purpose |
|-----|---------|
| Plugin checks | Plugin schemas, lint self-check in both directions, shellcheck |
| Theme checks | Themes against the contract, contrast floors, generated CSS in sync |
| Desktop | Biome, svelte-check, vitest, literal colours, frontend build; rustfmt, clippy, cargo test, rustdoc |
| Repo hygiene | gitleaks, ruff, shellcheck over every script and hook, actionlint |
| Desktop CSP witness | A production build in WebKitGTK: routes render with no CSP violations; injection probes are refused |
| CI Success | Fans every job in — the one context the branch ruleset needs to require |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Repository conventions for agents live
in [AGENTS.md](AGENTS.md).

## License

MIT License — see [LICENSE](LICENSE) for details.
