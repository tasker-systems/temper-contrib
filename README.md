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

Verification:

```bash
npm run check               # svelte-check, in apps/desktop
npm test                    # catalog witnesses, theme selection, ref resolution
npm run guard:colours       # components read theme roles, never literal colours
npm run build               # static frontend build
cargo check                 # in apps/desktop/src-tauri
cargo test -- --ignored     # witnesses: temper profile round-trip, ACP initialize
                            # handshake with opencode acp — need credentials/agent on PATH
```

## CI

| Workflow | Purpose |
|----------|---------|
| **CI** (`ci.yml`) | Validate plugin schemas, run lint self-check in both directions, shellcheck scripts, `cargo check` the desktop app; validate themes against the contract, contrast floors, and generated CSS |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Repository conventions for agents live
in [AGENTS.md](AGENTS.md).

## License

MIT License — see [LICENSE](LICENSE) for details.
