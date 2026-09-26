# temper-desktop

Tauri app: a SvelteKit 2 + Svelte 5 UI (SPA mode, adapter-static) over a Rust
core in `src-tauri/`.

## What the core holds

- **temper client** — `temperkb-client` at semver from crates.io, built through
  `config::build_client` so it reuses the machine's existing temper
  credentials. The OAuth login flow is later work.
- **ACP host** — an Agent Client Protocol client (`agent-client-protocol`)
  that spawns agent subprocesses over stdio and speaks the protocol.
  Witnessed against `opencode acp`; `claude-agent-acp` is configured the same
  way.

## What the UI holds

- **Theme roles** — `src/app.css` imports the repository's `themes/` contract and
  every theme in place (never copied). Components read `--tp-*` roles or `tp-`
  utilities only; `npm run guard:colours` fails on a literal colour. Fonts are
  bundled (`@fontsource-variable/*`), never fetched. `data-theme` on `<html>`
  selects the theme; "follow system" switches between a theme and its
  `counterpart` with the OS appearance (`src/lib/theme.ts`).
- **The `temper` catalog** — `src/lib/catalog/temper.catalog.json` is the one
  source for what a json-render spec may name: closed JSON Schema props per
  component, loaded into zod with `z.fromJSONSchema`. `checkSpec` is the gate
  (json-render's own `validate` checks structure and names but not per-component
  props); `TemperView` renders a spec only once it passes, and otherwise shows
  every reason it was refused. `/catalog` renders sample specs through it.
- **Reference resolution** — `ResourceRef` shows what temper says a resource is:
  the `temper_resolve_refs` command resolves ids through `temperkb-client`,
  batched and cached per session (`src/lib/refs.ts`). An id that does not
  resolve reads as unresolved, never as the title a spec suggested.

## Development

```bash
npm install
npm run tauri dev   # builds the Rust core and opens the app window
```

## Verification

```bash
npm run check               # svelte-check
npm test                    # catalog witnesses, theme selection, ref resolution
npm run guard:colours       # no literal colours under src/
npm run build               # static frontend build
cargo check                 # in src-tauri/
cargo test -- --ignored     # witnesses needing credentials or an agent binary:
                            # temper profile round-trip, ACP initialize handshake,
                            # ref resolution (TEMPER_WITNESS_REF=<a readable id>)
```
