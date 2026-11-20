# vendored temper-ts

`temper-ts.mjs` is a bundled copy of `@tasker-systems/temper-ts` (currently 0.6.5, pinned in
`../package.json`) plus its one runtime dependency, `openapi-fetch`. Orca loads the plugin's
worker as-is and a bare npm import cannot ship with the plugin (`node_modules` is never
committed), so the client is bundled once and committed here.

Regenerate after bumping the pin:

```sh
bun install
bun run build
```

`temper-ts.d.mts` is not generated: it re-exports the package's own declarations so `tsc`
type-checks the worker against the package while Orca runs the bundle. `temper-ts.entry.mjs` is
the bundler's entry.
