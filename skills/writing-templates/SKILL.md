# Writing Templates

Temper-backed writing flows for journals, poems, stories, reflections, and
specs — the first contrib package for [temper](https://github.com/tasker-systems/temper).

## Status

Scaffold. The vocabularies (`schemas/`), the metadata linter
(`scripts/lint.sh`), and the installer (`scripts/install.sh`) work. The
create/compile flows that this skill will teach land in a follow-up task.

## What a document is

A document is a temper resource: its body is the writing, its `open_meta`
carries the metadata. The five vocabularies in `schemas/` are the source of
truth for what metadata each doc type carries; `scripts/lint.sh` checks an
`open_meta` payload against them:

```bash
scripts/lint.sh story payload.json
echo '{"date": "2026-09-21", "tags": ["morning-pages"]}' | scripts/lint.sh journal -
```

Metadata lives on the resource — never duplicated into the body.

## Compilation

A `collection` resource owns a `compilation-manifest` data artifact (declared
enforcing on your context by the installer). The manifest — members by ref
plus order, with pandoc metadata — is the build authority for the epub;
compilation stays external to temper via pandoc. Manifest and compile scripts
land with the follow-up task.

## Install

```bash
scripts/install.sh --context @me/writing --author "Your Name" --targets agents,opencode
```

The installer probes your temper CLI (needs `data-artifact schema declare`,
present from 0.5.2), declares the enforcing compilation-manifest shape on your
context, copies the skill into your agent skill dirs, and writes your author
name to `~/.config/temper-contrib/writing.conf`. Personal identity enters at
install time — it never ships in this repository.

## License

MIT — see [LICENSE](LICENSE).
