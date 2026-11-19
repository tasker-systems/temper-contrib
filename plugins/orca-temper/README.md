# Temper — an Orca plugin

The person's temper in view from Orca, on the person's own grant and nothing else.

- `src/worker.ts` is a `trusted-worker`: when the panel asks (`temper.goals.active`,
  `src/protocol.ts`), it mints a credential by running `temper auth export-token`
  (`src/credentials.ts`, trusting stdout only on exit 0, taking expiry from the JWT's `exp`)
  and reads the person's active goals from the temper API through `@tasker-systems/temper-ts`
  (`src/goals.ts`, vendored to `vendor/temper-ts.mjs` so no `node_modules` ships).
- Signed out, the same request refuses — "temper is not connected" and no goal data, neither
  partial nor cached. `orca_worker_refuses_without_the_persons_grant` in `src/worker.test.ts`
  is the executable witness for that.
- `src/panel.tsx` is a components panel: the goals, or the refusal text.
- The context ref and API origin are plugin settings (Settings → Temper).

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
