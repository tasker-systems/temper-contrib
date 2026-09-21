# Writing Templates

Temper-backed writing flows for journals, poems, stories, reflections, and
specs — the first contrib package for [temper](https://github.com/tasker-systems/temper).

## What a document is

A document is a temper resource: its body is the writing, its `open_meta`
carries the metadata. The vocabularies in `schemas/` are the source of truth
for what metadata each doc type carries, and `scripts/lint.sh` validates a
payload against them. Metadata lives on the resource — never duplicated into
the body, never echoed in footers.

## Configuration

`scripts/install.sh` writes `~/.config/temper-contrib/writing.conf`:

- `WRITING_AUTHOR` — the author name (poem, story, reflection, spec require it)
- `WRITING_CONTEXT` — the default context new documents are created in
- `WRITING_REPO` — the temper-contrib clone holding `scripts/` and `schemas/`

Source the file at the start of a writing session. The scripts' Python
tooling comes from the repo's uv project — run `uv sync` once in
`$WRITING_REPO`; lint finds `.venv/bin/python3` on its own.

## Naming

- Every type except journal: `YYYY-MM-DD title-slug` — the date is the
  write/start date, the slug is lowercase hyphenated words with punctuation
  stripped (`2026-09-21 the-long-orbit`).
- Journal: the date alone (`2026-09-21`) — one entry per day, no slug.

## The create flow

For a document of type T (`journal` `poem` `story` `reflection` `spec`):

1. **Metadata first.** Ask the author for the vocabulary's required fields —
   `date`, `tags`, plus `author` (poem/story/reflection/spec), `status`
   (story/spec), `version` (spec) — and offer, without forcing, the optional
   fields the type carries. Defaults: date = today, author = `$WRITING_AUTHOR`,
   status = `draft`.
2. **Duplicate check.** Before writing anything:

   ```bash
   temper resource list --type T --context "$WRITING_CONTEXT" --title-contains "<the date>"
   ```

   A hit with the same title-slug (or, for journal, the same date) means stop
   and ask the author rather than create a near-duplicate.

3. **Create.** Body on stdin, metadata as a JSON object string — the open_meta
   object carries ONLY vocabulary fields (the schemas are
   `additionalProperties: false`; an unknown key fails lint):

   ```bash
   cat <<'EOF' | temper resource create --type T --context "$WRITING_CONTEXT" \
     --title "YYYY-MM-DD title-slug" --open-meta '{"date":"2026-09-21","tags":["x"]}'
   The writing itself — the body.
   EOF
   ```

4. **Lint the created resource.** Fetch the open_meta back from temper and
   validate that — the round-trip is the check, not the local JSON built in
   step 3:

   ```bash
   temper resource show <ref> --format json | jq '.open_meta' > /tmp/meta.json
   "$WRITING_REPO/scripts/lint.sh" T /tmp/meta.json
   ```

   A lint failure means the metadata needs fixing (see below) and linting
   again. Lint passing on the fetched resource is what closes the flow.

5. **No body footers.** Never append metadata echoes to the body.

### Revising metadata later

`temper resource update` treats implicit stdin as a full-body rewrite — a
bare metadata-only update inside a script or loop clobbers the body. To
change metadata, fetch the body and pass both explicitly:

```bash
temper resource show <ref> --format json | jq -r '.content' > /tmp/body.md
temper resource update <ref> --open-meta '<json>' --body @/tmp/body.md </dev/null
```

`--open-meta` REPLACES each key it names and leaves every other key untouched
— it merges, it does not swap the whole object, and a `null` value is
silently ignored (not stored, not deleted). There is currently no way to
DELETE an open_meta key through the CLI: removing a key means recreating the
document (delete, then create again through the flow). Get the metadata right
at creation; re-lint after any change.

## Collections and compilation

A `collection` resource owns a compiled work. Its members are ordinary
documents carrying the collection's full ref in `open_meta.collection`
(any doc type can be a member). The flow:

1. Create the collection (`--type collection`) and the member documents per
   the create flow above, each with `"collection": "<the collection's ref>"`.
   Optional integer `order` (story, poem) overrides date ordering.
2. Reconcile the manifest from the query alone:

   ```bash
   "$WRITING_REPO/scripts/manifest.sh" --collection <ref> --apply
   ```

   Members = every document whose `open_meta.collection` matches, ordered by
   `order` where present, else by `date`. The result is a
   `compilation-manifest` data artifact — the enforcing shape was declared on
   your context at install — and it, not the query, is the build authority.
   The script validates the payload against
   `schemas/compilation-manifest.json` before committing: after a passing
   validation, a cloud error is a temper fault, not a metadata mistake.

3. Compile:

   ```bash
   "$WRITING_REPO/scripts/compile.sh" --collection <ref>
   ```

   Fetches member bodies per the manifest, reports word counts as build
   output, and runs pandoc → epub with the manifest's metadata.

## Word counts are not stored

A word count is derived from the body and a stored copy drifts on the first
edit that bypasses whoever stored it. Counts are computed at compilation or
publish time if/when needed and never written to open_meta — do not add a
`word_count` field to any vocabulary or document.

## Install

```bash
scripts/install.sh --context @me/writing --author "Your Name" --targets agents,opencode
```

The installer probes your temper CLI (needs `data-artifact schema declare`,
present from 0.5.2), declares the enforcing compilation-manifest shape on your
context, copies the skill into your agent skill dirs, and writes author,
context, and repo path to `~/.config/temper-contrib/writing.conf`. Personal
identity enters at install time — it never ships in this repository.

## License

MIT — see [LICENSE](LICENSE).
