# Temper — an Orca plugin

The person's temper in view from Orca, on the person's own grant and nothing else.

- `src/worker.ts` is a `trusted-worker`: when the panel asks (`temper.goals.active`,
  `src/protocol.ts`), the worker's one credential strategy (`src/credentials.ts`, created at
  `activate`, cached across reads) supplies a token minted by `temper auth export-token` —
  stdout trusted only on exit 0, expiry from the JWT's `exp` — and the read goes through
  `@tasker-systems/temper-ts` (`src/goals.ts`, vendored to `vendor/temper-ts.mjs` so no
  `node_modules` ships). The API origin is the one the CLI is configured for
  (`src/origin.ts`: `TEMPER_API_URL`, else `[cloud] api_url` in its config), so the token and
  the API come from the same deployment; the plugin setting can override it.
- Losing the grant mid-read (a 401, or a re-mint that finds the CLI signed out) is the same
  refusal as never having it: "temper is not connected" and no goal data.
- Signed out, the same request refuses — "temper is not connected" and no goal data, neither
  partial nor cached. `orca_worker_refuses_without_the_persons_grant` in `src/worker.test.ts`
  is the executable witness for that.
- `src/panel.tsx` is a components panel: the goals, or the refusal text.
- The context ref is a plugin setting (Settings → Temper); the API origin follows the CLI
  unless the setting overrides it.

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
