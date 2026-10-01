# temper-desktop

Tauri app: a SvelteKit 2 + Svelte 5 UI (SPA mode, adapter-static) over a Rust
core in `src-tauri/`.

## What the core holds

- **temper client** — `temperkb-client` at semver from crates.io, built through
  `config::build_client` so it reuses the machine's existing temper
  credentials. The OAuth login flow is later work.
- **ACP host** — an Agent Client Protocol client (`agent-client-protocol`)
  that spawns agent subprocesses over stdio and speaks the protocol.
  Harnesses that speak ACP natively launch directly (`opencode acp`,
  `agent acp`, `gemini --acp`). Those that do not launch through a bundled
  adapter — the JS shim ships with the app (pinned in `package.json`,
  versioned by `bun.lock`, staged by `scripts/build-adapters.sh` into
  `acp-adapter-staging/`, which `tauri.conf.json` bundles as resources and
  `src-tauri/src/adapters.rs` resolves at spawn time) — running the person's
  own harness CLI: `claude` wraps `claude`, `codex` wraps `codex`,
  `antigravity` wraps `agy`, each pointed at the probed binary by env var
  (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`, `AGY_BIN`). Adapters run under
  node by default; bun is opt-in via `TEMPER_ACP_INTERPRETER=bun` (bun's
  node-pty delivers no PTY data, so PTY-driving adapters wedge silently
  under it). No harness binaries or runtimes ship with the app.

## What the UI holds

- **Theme roles** — `src/app.css` imports the repository's `themes/` contract and
  every theme in place (never copied). Components read `--tp-*` roles or `tp-`
  utilities only; `bun run guard:colours` fails on a literal colour. Fonts are
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
  resolve reads as unresolved, never as the title a spec suggested, and only a
  resolved reference is a link.
- **The shell** — `src/lib/shell/` is the whole window: a masthead, tabs, a room
  strip and the agent panel. A tab is a subject (a resource, a query, a place)
  seen through a lens, with its own back-trail; every open tab stays mounted and
  hidden while inactive, so switching tabs re-reads nothing. The tab model
  (`tabs.svelte.ts`) is the one door every move goes through, and open tabs
  persist per device. Links stay `<a href>` (`/r/<ref>`, `/q?context=…`,
  `/settings`); the shell reads a followed link back into a subject, opening it
  in place, or in a new tab on ⌘/Ctrl or middle click. Lenses are data
  (`lenses.ts`, `contributions/`): resolved from the lens asked for, then a
  plugin lens declaring the doc type, then core's default. A lens not built yet
  says so and what lands it. SvelteKit's router moves nobody between rooms.
  - **Ways in** — the left panel groups entries by the plugin that contributed
    them: core's contexts and recent work, temper-workflows' active goals, tasks
    in progress and recent sessions (`temper_list_resources`, one bounded read
    each, cached with its age). It closes and reopens without reading again.
  - **The tab bound** — twelve tabs beside home. A thirteenth sets the
    least-recently-used tab aside (never one whose lens declines to leave) and
    says which; set-aside tabs reopen from the strip with their trails.
  - **The palette** — ⌘K / Ctrl K. It filters what the desktop already holds
    (tabs, recent work, contexts, the workflow entries), switches lens and opens
    settings or setup; it does not search temper, and says so.
  - **The room in view** — a resource tab is shared with the agent as an ACP
    `resource_link` (`temper:<ref>`) on the first prompt and whenever it
    changes; the transcript records what went with each prompt.
- **The document room** — the core document lens opens a document body first:
  what temper calls it, its properties (`src/lib/properties.ts`, ported from
  temper-ui) and the rendered body. Its tab reads the body once, on opening.
  Connections, related resources one step away, history and recorded sources sit
  in an "about this document" panel, closed by default, each tab read only when
  first opened and failing on its own. The core commands are
  `src-tauri/src/document*.rs`.

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
  webview through `tauri-driver` (`scripts/csp-witness.py`): the shell is driven — a document
  in a tab, a second tab, a switch back that keeps the room, a lens switch, settings and setup
  as tabs, the palette (a lens switched from it), the ways-in panel closed and reopened — with
  no violations; injected scripts, eval, inline handlers and style attributes, remote images and
  remote fetches are all refused; the `__TAURI__` global is absent and a command outside the
  capability is refused. Verify against a production build, never the dev server.

## Development

```bash
bun install
bun run build:adapters   # stages the bundled ACP adapters (tauri build runs it first via beforeBuildCommand)
bun run tauri dev        # builds the Rust core and opens the app window (bun installs; node runs the toolchain)
```

Running an agent needs its harness on your machine: `opencode`/`agent`/`gemini`
run themselves; `claude`, `codex` and `antigravity` need their CLIs (`claude`,
`codex`, `agy`) on PATH, plus node (or bun for the stdio adapters) to run the
bundled adapters.

## Verification

`cargo make check` and `cargo make test` at the repository root run all of these.

```bash
bun run lint                # biome: lint + format + import order (lint:fix writes)
bun run check               # svelte-check
bun run test                # unit (node) + component (jsdom) witnesses
bun run guard:colours       # no literal colours under src/
bun run build               # static frontend build
cargo clippy --all-targets -- -D warnings   # in src-tauri/ (cargo fmt, cargo test too)
cargo test -- --ignored     # witnesses needing credentials or an agent binary:
                            # temper profile round-trip, live ACP agents
                            # (claude and agy; claude again under bun via
                            # TEMPER_ACP_INTERPRETER=bun), ref resolution
                            # (TEMPER_WITNESS_REF=<a readable id>)
```
