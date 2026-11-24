# Temper — an Orca plugin

The person's temper in view from Orca, on the person's own grant and nothing else. Home mirrors
temper-ui's home for the same person, list by list: resume, the latest handoff with its Next
section, the standing ways in (goals, tasks, sessions) with Show more, the places the
person works in, and recently updated — every list with its omission sentence and its order.
Goals toggle between active and completed, and Tasks between backlog, in progress and done; the
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
  the latest-handoff card on Home **Resume task** or **Continue from handoff**. The card names
  the tasks its session advanced (the session's outgoing `advances` edges), each with its title
  and `task · <stage>`, the stage read from temper (`temper.handoff.tasks`,
  `src/handoff-card.tsx`), never from the plugin's links or records. The card's press reads the
  stages again, and its prompt branches on that read: one task in progress is that task's
  resume, with this session as its handoff, and the new workspace is linked to the task; one
  task done or cancelled says so and quotes the Next section as follow-ups to check against
  temper, reopening and claiming nothing; several tasks are each named with their stage, and
  the agent asks the person which to continue; no task is the session start. A stage read that
  fails is said in the sheet, and the session-start prompt then tells the agent to check the
  task's state first. Only one in-progress task is labelled Resume task. Each opens a sheet where the press happened
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
  terminal it started in. The launch holds itself as a pending link first — the launch hook's
  answer while the create is out — and when the press's item names no context, the worker reads
  the record's `context_ref` itself before it is held, so the pending link carries the context
  the item could not; a read that fails or is refused blocks nothing. When the item is already
  linked to a workspace, the sheet names it before the confirm. No press writes to temper (Rulings
  Q3). Consents gate per Q9's table — a lit action needs every consent it uses, a missing one is
  named and never attempted — and a refused launch shows what Orca said.
- **Reopen agent** (`src/links.ts`) is Orca's resume: the same agent session, back in its
  workspace, through `agent.resume { workspaceId, agent, sessionId }`, with no temper prompt.
  A link learns its session only from Orca naming the launch's own terminal — an
  `agent.status.changed` event or an `agents.list` row for the linked workspace — never by
  guessing; a link without one offers no Reopen. It is offered on a task's detail, one per
  linked workspace carrying a session, labelled with the workspace's name. A link whose
  workspace is removed (`workspace.removed`, or missing from a complete `workspace.list` in
  both of Orca's id forms, once it is more than ten minutes old) is dropped. Every write to the
  stored links is one read-modify-write, and the worker runs them one at a time, so no writer
  puts back a stale copy over a link another just stored. No launch goes through
  `agent.launch`: every one makes a new workspace.
- **This workspace** (`src/serves.ts`, `src/serves-strip.tsx`). Home's strip names the focused
  workspace (`workspace.readContext`, followed through `workspace.changed`), the temper task its
  stored link names — title, stage, ref and context, read on the grant through
  `temper.serves` — and its agents with their status words (`agents.list`, read again on
  `agent.status.changed`). An unlinked workspace says it serves no temper task; a link to a goal
  or a handoff's session says the same and names what the workspace was started from. Without
  `workspace:read` and `storage:own` the strip names the consent and reads nothing; without
  `agent:read` its agents line does. The `agent.launch.before` hook gives every agent Orca starts
  in a workspace linked to a task `TEMPER_TASK` (the task's ref) and `TEMPER_CONTEXT`, beside its
  first prompt; elsewhere it adds nothing and never refuses a launch. Hooks get 2 s and no
  network, so it reads the stored link only — matched by the id `workspace.list` gives or by
  Orca's own worktree id (`<project>::<path>`, the id the hook hears) — and a launch still out
  to `workspace.create` answers from memory, since Orca starts its agent before the create
  returns. With no stored link, the hook and the strip fall back to the workspace's serves
  marker. `orca_agent_knows_the_task_it_serves` in `src/serves-witness.test.ts` is its witness.
- **Work in Orca** (`src/work.ts`, `src/work-region.tsx`, `src/claim-line.tsx`). A linked run is
  learned to have finished only from Orca: `agent.status.changed` (or an `agents.list` row) for
  the launch's own terminal reporting the agent done, with Orca's outcome word. That writes
  nothing to temper; it lights **Record this work — <workspace>** on the task's detail. One press
  commits one `orca-work` data artifact on the task through `temper data-artifact commit`, as the
  person acting through the plugin's UI (the Save persona `orca-temper-ui`, a confidence band,
  no model). The record holds the agent kind, the workspace's name and branch, the Orca session
  and host, when the run started and finished, and Orca's outcome word — no transcript, no
  terminal output, no filesystem path, and no field that reads as task state
  (`schemas/orca-work.schema.json`). A second press for the same run — its session and finish
  time — writes nothing: presses still out are joined, and the task's records are read before
  every commit. The detail reads the task's records back on the grant, newest first, and
  offers **Reopen agent — run of <date>** for each run whose `orca_host` is this Orca host
  (an opaque digest of the machine; never its name), even when plugin storage holds no link:
  the record's workspace is found by name in `workspace.list` and its session resumed through
  `agent.resume`. It is offered whatever the task's stage. A run on another host says it
  reopens only there. Before Start agent or Resume task the sheet reads the task's
  `claim_id`, `claimed_at` and `heartbeat_at` from temper and names a held claim with its
  heartbeat; the launch stays possible. Nothing the plugin stores or records — the link, the
  marker, an `orca-work` record — is ever read as a task's stage, claim or work in flight.
  `orca_work_is_findable_from_its_task` in `src/work-witness.test.ts` is its witness.

  **The shape.** A shape governs one home: temper applies the live shape for the artifact's
  family (its kind owner and kind) in the home of the resource it is committed on, and the kind
  owner only namespaces the family — it never reaches another context. A commit defaults its
  kind owner from the task's home, so a task in a team's context and one in the person's own
  context hold different families. So no single declaration governs `orca-work` on every task
  of the person's; each context whose tasks carry records declares it once, with
  `scripts/declare-orca-work-shape.sh <context-ref>`, which compares the live shape first
  (declaring is not idempotent) and declares only when its `$id` or enforcement differs. A
  record committed where no shape is declared is `never_declared`, which temper treats as a
  first-class state.
- **Going to an agent** (`src/focus-agent.tsx`). Each agent row in the strip is a press, and
  Reopen agent's and the launch sheet's outcomes offer the same press. The worker's
  `temper.agent.focus` focuses the agent's terminal (`terminal.focus`) when one is known, and
  otherwise opens its workspace (`workspace.open`): Orca has no plugin call that focuses a chat
  tab (stablyai/orca#42069), so a chat's row says it opens the workspace. When Orca answers
  `focused: false` the rail says "Orca did not move to it.", muted, not as an error. Without
  `workspace:write` the press is dark and the consent is named. The press only moves Orca's view:
  it writes nothing and is never read as task state.
- **The serves marker** (`src/serves-marker.ts`). Orca runs `agent.launch.before` only for agent
  CLIs it starts in a terminal, so a chat agent, another harness, or an agent started outside
  Orca gets no env. Each launch for a task therefore also writes
  `.temper-views/serves.json` in the new workspace's folder — the folder Open body uses, kept
  out of git by the same `info/exclude` entry, which the write makes sure of first:

  ```json
  {
    "task_ref": "<the task's ref>",
    "task_id": "<the task's bare UUID>",
    "context_ref": "<its context's ref, e.g. +team/context, or null when cogmap-homed>",
    "title": "<the task's title, or null>",
    "written_at": "<ISO-8601 time of the launch>"
  }
  ```

  It names which task the workspace was started for, and nothing else: no stage, claim or work
  in flight — read those from temper. A launch for a goal or a session writes none, and removes
  one left there. A marker that cannot be written (no folder on this machine, a folder without
  git, tracked files under `.temper-views/`) never stops the launch; the sheet says why. An
  agent learning its task checks `TEMPER_TASK` first, then this file at the workspace root.
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
  agent (the desktop's refused-save prompt, `vendor/desktop-handoff.ts`). The agent starts in a
  new workspace of the view workspace's project, through `temper.launch.go`'s
  `workspace.create`; `temper.body.handoff-place` names that project and the view file's
  absolute path from `workspace.list`, and the prompt names the file by that path, so the
  agent's proposal lands in the view's difference. Witnesses: `orca_only_a_save_reaches_temper` and
  `orca_stale_save_writes_nothing` in `editor/save.test.ts`.
- **Agent skill** on Home (`src/skill-readiness/`): one line per agent `orca agent installed`
  names — ready, missing, out of date or unknown, in words. The worker runs `temper skill check
  --target <t> --format json` once per install target those agents need (`agents` for codex,
  gemini, cursor, copilot, opencode and kimi; `claude` for Claude Code) and reads each agent from
  its own target's check. An agent no target reaches is unknown with why, and so is one whose
  check did not look in its target's directory (the CLI's check reads its `skill.output`
  setting whatever `--target` says) — never ready by guess. A target not ready gets an
  **Install** press with the paths `temper skill install --target <t>` writes stated beside it;
  only that press installs, and its answer names the directory the CLI wrote. The launcher
  sheet names a skill that is not ready for the agent picked without blocking the confirm. No
  capability from Orca is needed.
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
