# temper-contrib

**Self-contained contrib packages for [Temper](https://github.com/tasker-systems/temper) — agent skills, JSON Schema vocabularies, and operational scripts**

---

## What's Here

temper-contrib ships packages that compose with the temper CLI. Each package
is self-contained: it depends on temper only through its public CLI surface,
and nothing in this repository is required to run temper itself.

```
temper-contrib/
├── skills/writing-templates/    # writing package: create/compile flows (SKILL.md)
├── schemas/                     # JSON Schema draft 2020-12 vocabularies — source of truth
├── scripts/                     # install.sh, lint.sh (bash + temper CLI)
├── tests/fixtures/              # conforming + hand-broken open_meta payloads
└── .github/workflows/           # schema validity, lint self-checks, shellcheck
```

## The Writing Package

Temper-backed writing for five doc types — `journal`, `poem`, `story`,
`reflection`, `spec` — plus `collection` compilation. A document is a temper
resource: body is the writing, `open_meta` is the metadata. The vocabularies
in `schemas/` define what metadata each type carries; `scripts/lint.sh`
enforces them at write time.

```bash
# Validate an open_meta payload against a vocabulary
scripts/lint.sh story payload.json

# Full self-check (schemas, fixtures both directions, dependency hygiene)
scripts/lint.sh --self-check

# Install into your environment
scripts/install.sh --context @me/writing --author "Your Name" --targets agents,opencode
```

Personal identity enters at install time and never ships in this repository.

## CI

| Workflow | Purpose |
|----------|---------|
| **CI** (`ci.yml`) | Validate schemas, run lint self-check in both directions, shellcheck scripts |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Repository conventions for agents live
in [AGENTS.md](AGENTS.md).

## License

MIT License — see [LICENSE](LICENSE) for details.
