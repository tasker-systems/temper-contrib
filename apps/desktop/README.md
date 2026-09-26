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

## Development

```bash
npm install
npm run tauri dev   # builds the Rust core and opens the app window
```

## Verification

```bash
npm run check               # svelte-check
npm run build               # static frontend build
cargo check                 # in src-tauri/
cargo test -- --ignored     # witnesses needing credentials or an agent binary:
                            # temper profile round-trip, ACP initialize handshake
```
