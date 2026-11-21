# Temper — an Orca plugin

The person's temper in view from Orca, on the person's own grant and nothing else. Home mirrors
temper-ui's home for the same person, list by list: resume, the latest handoff with its Next
section, the standing ways in (goals, in progress, sessions) with Show more, the places the
person works in, and recently updated — every list with its omission sentence and its order.

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
- The launcher (`src/launcher.tsx`, prompts in `src/prompts.ts`): a backlog task's detail gets
  **Start agent**, an in-progress one **Resume agent**, an active goal **Work this goal**, and
  the latest-handoff card on Home **Resume**. Each opens a sheet where the press happened with
  the destination (a new workspace in a project picked from `project.list` — the last pick
  remembered per context in local view state — or this workspace), the agent (what
  `orca agent installed` says the host can launch), and the first prompt in full before it is
  sent: harness-agnostic text naming the temper skill and CLI, the item's full ref and context,
  and — for a task — the task's own latest linked session's Next section (design record,
  Rulings Q4/Q4a; Review 1: never the person's newest session, which belongs to other work; a
  task with no linked session gets "no handoff yet", quoted nothing). Confirm
  sends `temper.launch.go` to the worker: `workspace.create { projectId, agent, prompt }` or
  `agent.launch { workspaceId, agent, prompt }`, then the workspace ↔ item link in the plugin's
  own storage (`launch-links`, for the launch hook a later item adds). No press writes to temper
  (Rulings Q3). Consents gate per Q9's table — a lit action needs every consent it uses, a
  missing one is named and never attempted — and a refused launch shows what Orca said.
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
  through the launcher's `agent.launch`). Witnesses: `orca_only_a_save_reaches_temper` and
  `orca_stale_save_writes_nothing` in `editor/save.test.ts`.
- The settings are the API origin override and the "Temper web address" (`webUrl`); the
  context-scoped settings and reads were retired when Home became person-scoped (the design
  record's Rulings, Q1).

## Develop

```sh
bun install
bun run build            # rebuild vendor/*.mjs (after bumping a pinned package)
orca plugin dev watch .  # loads this folder into Orca; Ctrl-C unloads it
```

## Gates

`cargo make check` and `cargo make test` at the repository root run this package's gates: the
vendor build, `orca plugin types` + `tsc -p .`, and `orca plugin test .`
(`scripts/gates.sh --check|--test`). Steps that need the `orca` CLI skip loudly when it is
absent.
