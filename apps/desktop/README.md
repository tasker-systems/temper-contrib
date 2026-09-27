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
  every reason it was refused. The catalog is held for plugin rendering surfaces;
  no route renders it (`themes/preview/` is where the components are previewed).
- **Rendered markdown** — `src/lib/markdown/` is temper-ui's pipeline, ported by
  copy-with-citation: a bounded parse that refuses rather than throws, core
  highlight.js where an unknown fence language is plaintext, and a client-only
  DOMPurify pass that `MarkdownRenderer` gates `{@html}` on. Remote images are
  withheld and say so. The chat transcript renders agent replies through it.
- **Reference resolution** — `ResourceRef` shows what temper says a resource is:
  the `temper_resolve_refs` command resolves ids through `temperkb-client`,
  batched and cached per session (`src/lib/refs.ts`). An id that does not
  resolve reads as unresolved, never as the title a spec suggested.

## Content-Security-Policy

- **Shipped** — `app.security.csp` in `src-tauri/tauri.conf.json`: `default-src 'none'`;
  scripts, styles and fonts from the app's own origin (Tauri adds hashes for the inline
  scripts it and SvelteKit emit); images from the app or `data:`; `connect-src` for Tauri IPC
  only. No inline style attributes (styling through the CSSOM, as Svelte's `style:` does, is
  unaffected). Fonts are never inlined as `data:` (`vite.config.ts`).
- **Dev** — `tauri dev` loads the Vite server directly and Tauri applies no policy there, so
  `vite.config.ts` sends the dev policy itself: the shipped one plus the inline scripts and
  styles Vite's runtime injects and the HMR websocket.
- **Capabilities** — `src-tauri/capabilities/default.json` grants `core:event:default` and
  nothing else; the UI's own commands need no permission. No plugins beyond Tauri's core, and
  `withGlobalTauri` is off (the UI imports `@tauri-apps/api`). Widening either is a reviewed
  change.
- **Witness** — `cargo make desktop-csp-witness` builds for production and drives the real
  webview through `tauri-driver` (`scripts/csp-witness.py`): every route renders with no
  violations; injected scripts, eval, inline handlers and style attributes, remote images and
  remote fetches are all refused; the `__TAURI__` global is absent and a command outside the
  capability is refused. Verify against a production build, never the dev server.

## Development

```bash
npm install
npm run tauri dev   # builds the Rust core and opens the app window
```

## Verification

`cargo make check` and `cargo make test` at the repository root run all of these.

```bash
npm run lint                # biome: lint + format + import order (lint:fix writes)
npm run check               # svelte-check
npm test                    # unit (node) + component (jsdom) witnesses
npm run guard:colours       # no literal colours under src/
npm run build               # static frontend build
cargo clippy --all-targets -- -D warnings   # in src-tauri/ (cargo fmt, cargo test too)
cargo test -- --ignored     # witnesses needing credentials or an agent binary:
                            # temper profile round-trip, ACP initialize handshake,
                            # ref resolution (TEMPER_WITNESS_REF=<a readable id>)
```
