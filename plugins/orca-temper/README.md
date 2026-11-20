# Temper — an Orca plugin

The person's temper in view from Orca, on the person's own grant and nothing else.

- `src/worker.ts` is a `trusted-worker`: when the panel asks (`temper.goals.active`,
  `temper.tasks.in-progress`, `temper.handoff.latest`, `src/protocol.ts`), the worker's one
  credential strategy (`src/credentials.ts`, created at `activate`, cached across reads)
  supplies a token minted by `temper auth export-token` — stdout trusted only on exit 0, expiry
  from the JWT's `exp` — and the read goes through `@tasker-systems/temper-ts` (`src/reads.ts`,
  vendored to `vendor/temper-ts.mjs` so no `node_modules` ships). An explicit limit rides every
  list call; the latest handoff also reads the newest session note's body and shows its Next
  steps. The API origin is the one the temper CLI itself names (`src/origin.ts`: the top-level
  `api_url` in `temper auth status --format json`, through the same CLI seam as the mint), so the
  token and the API come from the same deployment; the plugin setting can override it. A CLI too
  old to report the origin, or one answering none, refuses — the worker never guesses an instance,
  and the plugin never reads the CLI's config or auth store.
- Losing the grant mid-read (a 401, or a re-mint that finds the CLI signed out) is the same
  refusal as never having it: "temper is not connected" and no group data.
- Signed out, every request refuses — "temper is not connected" and no group data, neither
  partial nor cached. `orca_worker_refuses_without_the_persons_grant` in `src/worker.test.ts`
  is the executable witness for that.
- `src/panel.tsx` is a components panel: three groups — active goals, tasks in progress and the
  latest handoff, each with a count — or the refusal text.
- Each group reads its own comma-separated context list (Settings → Temper: goals contexts for
  active goals, work contexts for tasks and the handoff); a group whose list is unset reads the
  "Temper context" setting, and the API origin follows the CLI unless the setting overrides it.

## Develop

```sh
bun install
bun run build            # rebuild vendor/temper-ts.mjs (after bumping the temper-ts pin)
orca plugin dev watch .  # loads this folder into Orca; Ctrl-C unloads it
```

## Gates

`cargo make check` and `cargo make test` at the repository root run this package's gates: the
vendor build, `orca plugin types` + `tsc -p .`, and `orca plugin test .`
(`scripts/gates.sh --check|--test`). Steps that need the `orca` CLI skip loudly when it is
absent.
