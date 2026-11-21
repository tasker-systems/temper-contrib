# vendored temper-ts and temper-design

`temper-ts.mjs` is a bundled copy of `@tasker-systems/temper-ts` (currently 0.6.5, pinned in
`../package.json`) plus its one runtime dependency, `openapi-fetch`, and `temper-design.mjs` the
same for `@tasker-systems/temper-design` (the rail's ruled imports — pure modules only; nothing
that reaches for a DOM, such as `sanitize`, may enter either bundle). `temper-design-frame.mjs`
is the custom editor's own bundle of the same package: the markdown parse, the sanitizer, and
the contract's stylesheets and house themes as text. It needs a DOM and is imported from
`editor/` only — the frame has a window; the worker and the components panel do not. Orca loads
the plugin's worker and panels as-is and bare npm imports cannot ship with the plugin
(`node_modules` is never committed), so the packages are bundled once and committed here.

Regenerate after bumping the pin:

```sh
bun install
bun run build
```

`temper-ts.d.mts` is not generated: it re-exports the package's own declarations so `tsc`
type-checks the worker against the package while Orca runs the bundle. `temper-ts.entry.mjs` is
the bundler's entry.

`desktop-handoff.ts` is a byte copy of `apps/desktop/src/lib/handoff.ts`, the desktop's
refused-save handoff prompt, made by the same `bun run build`: the body view's "Hand to an agent"
composes the same prompt, and a plugin cannot import from outside its own folder. The gate's
`git diff --exit-code vendor/` refuses a copy that drifts from the desktop's file.
