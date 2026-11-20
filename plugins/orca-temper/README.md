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
  way in in place by 8, up to 200.
- The only setting is the API origin override; the context-scoped settings and reads were
  retired when Home became person-scoped (the design record's Rulings, Q1).

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
