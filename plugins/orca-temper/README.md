# Temper — an Orca plugin

The person's temper in view from Orca, on the person's own grant and nothing else. Home mirrors
temper-ui's home for the same person, list by list: resume, the latest handoff with its Next
section, the standing ways in (goals, tasks, sessions) with Show more, the places the
person works in, and recently updated — every list with its omission sentence and its order.
Goals toggle between active and done, and Tasks between backlog, in progress and done; the
defaults are the statuses temper-ui's home reads, and the pick is held on this device.

- `src/worker.ts` is a `trusted-worker`: when the panel asks (`temper.home.*`,
  `temper.capabilities`, `src/protocol.ts`), the worker's one credential strategy
  (`src/credentials.ts`, created at `activate`, cached across reads) supplies a token minted by
  `temper auth export-token` — stdout trusted only on exit 0, expiry from the JWT's `exp` — and
  the read goes through `@tasker-systems/temper-ts` (`src/reads.ts`, vendored to
  `vendor/temper-ts.mjs` so no `node_modules` ships). The ways-in filters, bounds, order,
  omission sentences, handoff label and Next-section parser come from
  `@tasker-systems/temper-design` (vendored to `vendor/temper-design.mjs` — imports, never
  copies, and nothing that reaches for a DOM). An explicit limit rides every list call; the
  latest handoff also reads the newest session's body and quotes its Next section. The API
  origin is named in the same mint that borrows the grant (`src/credentials.ts`): the plugin
  setting answers it when set, otherwise the top-level `api_url` of the worker's
  `temper auth status --format json` run does, and the token and its origin are cached as one
  pair from that one CLI conversation — two panel reads cost one mint and one status run. A CLI
  too old to report the origin, or one answering none, refuses — the worker never guesses an
  instance, and the plugin never reads the CLI's config or auth store.
- Losing the grant mid-read (a 401, or a re-mint that finds the CLI signed out) is the same
  refusal as never having it: "temper is not connected" and no region data.
- Signed out, every request refuses — "temper is not connected", nothing partial or cached.
  `orca_worker_refuses_without_the_persons_grant` in `src/worker.test.ts` is the executable
  witness for that. A read that fails any other way is that region's failure beside the regions
  that answered — it names what failed and never shows as empty.
- `src/panel.tsx` is a components panel: Home / Explore / Search sub-tabs over the regions, an
  in-panel detail stack with Back, and actions lit only by granted consent. Show more grows a
  way in in place by 8, up to 200. A pressed item's detail shows its meta in temper-ui's order
  (the read asks no `sections`, so no body crosses it), a goal's linked tasks with their
  omission sentence — labelled "linked tasks", the `advances` edges, never "all tasks" — and
  the way out: "Open in temper" lights only on the person's https:// `webUrl` setting and opens
  `<webUrl>/vault/r/<id>` with `shell.openExternal`, never derived from the API origin.
- The look is Orca's own controls (`src/look.ts`): a row wears its doc-type icon beside the
  doc-type word and says its state in words ("task · in progress"); a region's count is a badge
  on its heading; the latest handoff is a card, its Resume sheet opening below the card; a
  detail's header is the doc-type word, the state as a badge holding its word, then the title;
  one solid accent act per view, the others outlined; the meta sits collapsed, without the
  repeated `doc_type` row and with `updated` as a time. No icon or colour carries meaning alone.
  The `look-*` scenarios in `src/panel.check.ts` render Home, a task's detail and a goal's
  detail from fixtures, for `orca plugin shot . --scenario <name> --theme light|dark`.
- The launcher (`src/launcher.tsx`, prompts in `src/prompts.ts`): a backlog task's detail gets
  **Start agent**, an in-progress one **Resume task**, an active goal **Work this goal**, and
  the latest-handoff card on Home **Resume task**. Each opens a sheet where the press happened
  with the project (picked from `project.list` — the last pick remembered per context in local
  view state), the agent (what `orca agent installed` says the host can launch), and the first
  prompt in full before it is sent: harness-agnostic text naming the temper skill and CLI, the
  item's full ref and context, and — for a task — the task's own latest linked session's Next
  section (design record, Rulings Q4/Q4a; Review 1: never the person's newest session, which
  belongs to other work; a task with no linked session gets "no handoff yet", quoted nothing).
  Resume task is temper's resume — a fresh agent oriented to the latest handoff — so it is
  Start's act with the resume prompt. Every launch goes into a new workspace: confirm sends
  `temper.launch.go` to the worker, `workspace.create { projectId, agent, prompt }`, then the
  workspace ↔ item link in the plugin's own storage (`launch-links`) with the agent and the
  terminal it started in. When the item is already linked to a workspace, the sheet names it
  before the confirm. No press writes to temper (Rulings Q3). Consents gate per Q9's table — a
  lit action needs every consent it uses, a missing one is named and never attempted — and a
  refused launch shows what Orca said.
- **Reopen agent** (`src/links.ts`) is Orca's resume: the same agent session, back in its
  workspace, through `agent.resume { workspaceId, agent, sessionId }`, with no temper prompt.
  A link learns its session only from Orca naming the launch's own terminal — an
  `agent.status.changed` event or an `agents.list` row for the linked workspace — never by
  guessing; a link without one offers no Reopen. It is offered on a task's detail, one per
  linked workspace carrying a session, labelled with the workspace's name. A link whose
  workspace is removed (`workspace.removed`, or missing from a complete `workspace.list`) is
  dropped. `agent.launch` (into the named workspace) is used only by the editor room's "Hand
  to an agent", whose agent works on the view file in that workspace.
- **Open body** on a record's detail (lit by `workspace:read`, `workspace:write` and
  `storage:own`) opens the record's body in an Orca editor tab of the focused workspace, beside
  the person's view (`src/editor-room/`). The worker reads the record with its body and
  `body_token`, writes `.temper-views/<ref>.temper.md` (meta as frontmatter, the body below),
  adds `.temper-views/` once to `info/exclude` in the repository's common git dir (so every
  linked worktree is covered and `git status` stays clean), holds the base
  `{id, body_token, base, read_at, path}` in plugin storage, and calls `editor.open` — never
  `workspace.open`. No focused workspace, one on another host, a folder without git, a tracked
  file under `.temper-views/`, a body not stored verbatim, or a view already changed on disk
  refuses in the panel, naming why, and writes nothing. The `temper-body` custom editor
  (`editor/`, `priority: default`) draws the view: a header naming the record, when its base
  was read and whether temper has moved past it, the difference from the base, then the body
  rendered. Editing happens in Orca's own editor of the same file, or on disk by an agent.
  `orca_body_opens_in_an_editor_tab` in `src/editor-room/open-body.test.ts` is its witness.
- **Save** in the body view is the one act that writes a body to temper
  (`src/editor-room/save.ts`): the worker runs `temper resource update <id> --body @<file>
  --expect-body <held token>` as the person acting through the plugin's UI (persona
  `orca-temper-ui`, a confidence band, no model), sending the body without the view's
  frontmatter. No held token refuses before the CLI runs. A local file save, closing or
  reopening never write to temper, and the view says when the file on disk holds a local save
  temper does not have. A save temper refuses as stale writes nothing and shows the base, the
  person's version and temper's current, with carry-over, discard, or handing the three to an
  agent in the workspace (the desktop's refused-save prompt, `vendor/desktop-handoff.ts`, sent
  through `temper.launch.go`'s `agent.launch`). Witnesses: `orca_only_a_save_reaches_temper` and
  `orca_stale_save_writes_nothing` in `editor/save.test.ts`.
- The settings are the API origin override and the "Temper web address" (`webUrl`); the
  context-scoped settings and reads were retired when Home became person-scoped (the design
  record's Rulings, Q1).

## Develop

```sh
bun install
bun run build            # rebuild vendor/*.mjs (after bumping a pinned package)
orca plugin dev watch .  # loads this folder into Orca as local.temper; Ctrl-C unloads it
```

The plugin's id is `temper`. Orca names an install `<publisher>.<id>`: `local.temper` from a
development folder, `tasker-systems.temper` from this repository's catalog. Ids starting `orca-`
install only from Orca's official catalog, so the id carries no prefix; the folder keeps its name.

## Release and install

The plugin is published through [`orca-catalog.json`](../../orca-catalog.json) at the repository
root: one entry, `tasker-systems.temper`, whose `source` is this repository at `main` with
`path: plugins/orca-temper` (Orca's direct Git install reads only a repository root). Each
release in the entry pins a full commit and the content hash of this folder at that commit.

To release:

1. Bump `version` in `orca-plugin.json` (semver; raise `engines.orca` if a field needs it) and
   commit.
2. From the repository root, on that commit: `orca plugin release-entry plugins/orca-temper --json`.
   It hashes the committed files of `HEAD`, never the working tree.
3. Put the printed release first in the entry's `releases` (newest first; keep older releases,
   at most 32) and commit. `cargo make check` validates the catalog and refuses an entry whose
   newest release is not the manifest's version.
4. Merge with a merge commit, so the pinned commit lands on `main` unchanged. A rebase or squash
   rewrites it: run `release-entry` again on the rewritten commit.
5. Tag the pinned commit `orca-temper-v<version>` and push the tag. The tag marks the release for
   people; Orca follows the pinned commit. Not a bare `v<version>`: that is the version tag Orca's
   direct install looks for, and this repository's root is not a plugin.

To install, in Orca's Settings → Plugins (add the catalog, then install Temper), or:

```sh
orca plugin catalog add tasker-systems/temper-contrib   # asks once to approve the catalog
orca plugin install tasker-systems.temper               # asks to approve what it is granted
orca plugin update tasker-systems.temper                # moves to the catalog's newest release
```

Both approvals are the person's: the catalog decides which repositories Orca installs from, and
the install lists the access the plugin asks for.

## Gates

`cargo make check` and `cargo make test` at the repository root run this package's gates: the
vendor build, `orca plugin types` + `tsc -p .`, and `orca plugin test .`
(`scripts/gates.sh --check|--test`). Steps that need the `orca` CLI skip loudly when it is
absent.
