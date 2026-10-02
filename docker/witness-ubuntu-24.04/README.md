# docker/witness-ubuntu-24.04

The `csp-witness` CI job as a local environment: ubuntu 24.04, the same apt packages, the
same rust/node/bun/uv toolchains, `tauri-driver` compiled in. It exists so a desktop
witness that behaves differently here than on a Mac can be driven on this machine, where
the app's own output is on the screen.

## Build the image

From the repository root:

```sh
docker build -t temper-witness:24.04 docker/witness-ubuntu-24.04
```

## Run the shipped witness in it

`node_modules` and the cargo `target/` directory hold platform binaries, so they live in
named volumes rather than in the mounted tree:

```sh
docker volume create witness-node-modules
docker volume create witness-target
docker run --rm \
  -v "$PWD:/work" \
  -v witness-node-modules:/work/apps/desktop/node_modules \
  -v witness-target:/work/apps/desktop/src-tauri/target \
  temper-witness:24.04 \
  bash -lc "cd /work/apps/desktop \
    && bun install --frozen-lockfile \
    && bun run tauri build --debug --no-bundle \
    && xvfb-run -a uv run -q --with 'selenium>=4.20,<5' scripts/csp-witness.py"
```

The image carries `dbus` as well, so a session-bus experiment is one flag away:

```sh
  && xvfb-run -a dbus-run-session -- uv run -q --with 'selenium>=4.20,<5' scripts/csp-witness.py
```

Artifacts the container writes into the mounted tree (`.svelte-kit/`, `build/`,
`acp-adapter-staging/`) are gitignored; anything that matters is in the two volumes.
