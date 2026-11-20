# vendored temper-ts and temper-design

`temper-ts.mjs` is a bundled copy of `@tasker-systems/temper-ts` (currently 0.6.5, pinned in
`../package.json`) plus its one runtime dependency, `openapi-fetch`, and `temper-design.mjs` the
same for `@tasker-systems/temper-design` (the rail's ruled imports — pure modules only; nothing
that reaches for a DOM, such as `sanitize`, may enter either bundle). Orca loads the plugin's
worker and panels as-is and bare npm imports cannot ship with the plugin (`node_modules` is never
committed), so the packages are bundled once and committed here.

Regenerate after bumping the pin:

```sh
bun install
bun run build
```

`temper-ts.d.mts` is not generated: it re-exports the package's own declarations so `tsc`
type-checks the worker against the package while Orca runs the bundle. `temper-ts.entry.mjs` is
the bundler's entry.
