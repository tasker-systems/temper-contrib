//! Bundled ACP adapters: the JS shims the desktop ships for harnesses that do
//! not speak ACP natively (Claude via the Agent SDK, Codex, Antigravity).
//!
//! The adapter packages are pinned dependencies of `apps/desktop/package.json`
//! — bun.lock holds the only version pin — and `scripts/build-adapters.sh`
//! stages each package with its dependency closure into the app bundle as
//! Tauri resources. At launch the roster's bundled rows (`{{adapter:<key>}}`
//! placeholders in `agents-roster.toml`) render through [`adapter_launch`]
//! into an `AcpAgentConfig`: the interpreter (`node` by default — bun's
//! node-pty delivers nothing, so a PTY-driven adapter wedges silently under
//! bun — with `TEMPER_ACP_INTERPRETER=bun` opting in where an adapter is
//! pure stdio), the adapter's entry file, and the env var that points the
//! adapter at the person's own harness CLI on `$PATH` — the desktop never
//! ships harness binaries.
//!
//! What this module deliberately routes around: Tauri's `resource_dir()`
//! answers the exe dir for a cargo-run binary and `../Resources` inside a
//! bundle (tauri-utils `platform.rs::resource_dir_from`), so the resolution
//! order below checks the dev tree first and the bundle layout second, both
//! relative to the exe — one code path for tests, dev, and production.

use std::path::PathBuf;

use agent_client_protocol::AcpAgentConfig;

use crate::roster::effective_path;

/// The marker a roster command carries when its launch is a bundled adapter:
/// `command = "bun {{adapter:claude}}"`. The value after the colon is the key
/// [`adapter_launch`] resolves.
pub const ADAPTER_MARKER: &str = "{{adapter:";

/// What one roster key's bundled adapter is: the staged package directory,
/// its entry file within it, and the harness CLI resolution it declares.
struct AdapterSpec {
    /// The directory the staging script ships, as it lands under
    /// `acp-adapters/` in the bundle (and under `acp-adapter-staging/…` in dev).
    package_dir: &'static str,
    /// The adapter's executable script, relative to `package_dir`.
    entry: &'static str,
    /// The binary the roster probes (the harness CLI the person installed).
    harness_binary: &'static str,
    /// The env var the adapter reads for the harness CLI's path
    /// (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`, `AGY_BIN` — each verified
    /// against the adapter's own resolution code).
    cli_env: &'static str,
}

/// The roster's bundled adapters. A key absent here is not a bundled adapter
/// — native-ACP rows (`opencode acp`, …) and custom agents never reach the
/// render.
fn adapter_spec(key: &str) -> Option<AdapterSpec> {
    match key {
        "claude" => Some(AdapterSpec {
            package_dir: "claude-agent-acp",
            entry: "dist/index.js",
            harness_binary: "claude",
            cli_env: "CLAUDE_CODE_EXECUTABLE",
        }),
        "codex" => Some(AdapterSpec {
            package_dir: "codex-acp",
            entry: "dist/index.js",
            harness_binary: "codex",
            cli_env: "CODEX_PATH",
        }),
        "antigravity" => Some(AdapterSpec {
            package_dir: "agy-acp",
            entry: "dist/main.js",
            harness_binary: "agy",
            cli_env: "AGY_BIN",
        }),
        _ => None,
    }
}

/// True when a launch command is a bundled-adapter row awaiting render.
pub fn is_bundled_row(command: &str) -> bool {
    command.contains(ADAPTER_MARKER)
}

/// Parses the adapter key out of a bundled row's marker. A row with the
/// opener but no well-formed close is not a bundled row — it parses as its
/// own launch string and fails there, honestly.
fn marker_key(command: &str) -> Option<String> {
    let start = command.find(ADAPTER_MARKER)? + ADAPTER_MARKER.len();
    let end = command[start..].find("}}")? + start;
    let key = command[start..end].trim();
    (!key.is_empty()).then(|| key.to_string())
}

/// Resolves `name` against the entries of a `$PATH`-style string, first hit
/// wins — the same order a shell would give. Separated from the roster's
/// probe so the launch can ask "which interpreter" without probing the whole
/// roster.
fn which_in_path(name: &str, path_var: &str) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

/// The interpreter that runs the adapter: `node` when it resolves on the
/// effective PATH, else `bun`. node is the default because adapters drive
/// harness CLIs through node-pty, and bun's node-pty delivers nothing (no
/// data events, no error, verified 2026-10-01 against agy-acp and a bare
/// `/bin/echo` PTY) — a bun-preferred default silently wedges every
/// PTY-driven adapter. `TEMPER_ACP_INTERPRETER=bun|node` pins one — the
/// parity witnesses drive both, and a pinned interpreter that is absent is
/// an error, never a silent fallback that would make a witness's interpreter
/// label a lie.
fn interpreter(path_var: &str) -> Result<PathBuf, String> {
    if let Ok(pin) = std::env::var("TEMPER_ACP_INTERPRETER") {
        let pin = pin.trim().to_string();
        return which_in_path(&pin, path_var)
            .ok_or_else(|| format!("TEMPER_ACP_INTERPRETER pins `{pin}`, which is not on PATH"));
    }
    which_in_path("node", path_var)
        .or_else(|| which_in_path("bun", path_var))
        .ok_or_else(|| {
            "the agent's adapter needs node or bun on PATH; neither was found".to_string()
        })
}

/// The desktop app's root in a checkout (`{CARGO_MANIFEST_DIR}/..`).
fn desktop_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// The staged adapter tree, in whichever layout this process is: the dev
/// staging dir beside the frontend, or the bundle's `Resources/acp-adapters`
/// next to the exe. A present dir whose entry file is missing is a broken
/// build, named as one.
fn adapter_root(spec: &AdapterSpec) -> Result<PathBuf, String> {
    let dev = desktop_root()
        .join("acp-adapter-staging")
        .join(spec.package_dir);
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let bundled = exe_dir
        .join("../Resources/acp-adapters")
        .join(spec.package_dir);
    let root = if dev.is_dir() {
        dev
    } else if bundled.is_dir() {
        bundled
    } else {
        return Err(format!(
            "the {} adapter is not staged with the app (looked in {} and {}) — \
             run `bun run build:adapters` before launching agents",
            spec.package_dir,
            dev.display(),
            bundled.display(),
        ));
    };
    let entry = root.join(spec.entry);
    if !entry.is_file() {
        return Err(format!(
            "the {} adapter is staged without its entry {}; the staging build is incomplete",
            spec.package_dir,
            entry.display(),
        ));
    }
    Ok(root)
}

/// The launch spec for one bundled adapter: interpreter + entry + the env
/// var pointing at the person's harness CLI. The harness CLI is the one the
/// roster's probe resolved — probe and launch never disagree about which
/// binary is in play.
pub fn adapter_launch(key: &str) -> Result<AcpAgentConfig, String> {
    let spec = adapter_spec(key).ok_or_else(|| format!("`{key}` is not a bundled adapter"))?;
    let path_var = effective_path();
    let runtime = interpreter(&path_var)?;
    let harness = which_in_path(spec.harness_binary, &path_var).ok_or_else(|| {
        format!(
            "the {} adapter needs `{}` on PATH; the roster probe should have gated this",
            spec.package_dir, spec.harness_binary,
        )
    })?;
    let entry = adapter_root(&spec)?.join(spec.entry);
    let mut config = AcpAgentConfig::new(runtime);
    config = config.arg(entry.to_string_lossy().to_string());
    config = config.env(spec.cli_env, harness.to_string_lossy().to_string());
    Ok(config)
}

/// Renders a launch command: a bundled-adapter row becomes its resolved
/// `AcpAgentConfig`; anything else parses as-is, exactly as the store always
/// launched it.
pub fn render_launch(command: &str) -> Result<AcpAgentConfig, String> {
    if is_bundled_row(command) {
        let key = marker_key(command).ok_or_else(|| {
            format!("the launch command's adapter marker is malformed: {command}")
        })?;
        return adapter_launch(&key);
    }
    command
        .parse::<agent_client_protocol::AcpAgent>()
        .map(|a| a.into_config())
        .map_err(|e| format!("the launch command does not parse as an ACP agent: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The roster's bundled rows are the keys this module resolves — a key
    /// present in one and absent from the other is a row the launch cannot
    /// render, caught at unit-test time rather than first launch.
    #[test]
    fn every_bundled_roster_row_resolves_an_adapter_spec() {
        for entry in crate::roster::roster() {
            if is_bundled_row(&entry.command) {
                let key = marker_key(&entry.command).expect("the row's marker parses");
                assert!(
                    adapter_spec(&key).is_some(),
                    "roster row `{}` marks a bundled adapter `{key}` this module does not resolve",
                    entry.key,
                );
            }
        }
    }

    /// A malformed marker is not silently reparsed as a shell command.
    #[test]
    fn a_malformed_marker_refuses() {
        assert!(marker_key("bun {{adapter:}}").is_none());
        assert!(marker_key("bun {{adapter:claude").is_none());
        assert!(is_bundled_row("bun {{adapter:claude}}"));
        assert!(marker_key("bun {{adapter:claude}}") == Some("claude".to_string()));
        // A row without the marker is never a bundled row.
        assert!(!is_bundled_row("opencode acp"));
        assert!(!is_bundled_row("npx -y @agentclientprotocol/codex-acp"));
    }

    /// A bundled row renders only when this machine can run it: the dev
    /// staging tree is present, the harness CLI is installed, and an
    /// interpreter exists. On a machine missing any of those the render
    /// declines by name — the error text is the contract the probe relies on.
    #[test]
    fn a_bundled_row_renders_or_says_why() {
        for key in ["claude", "codex", "antigravity"] {
            match adapter_launch(key) {
                Ok(config) => {
                    let exe = config.command().to_string_lossy().to_string();
                    assert!(
                        exe.ends_with("bun") || exe.ends_with("node"),
                        "the interpreter is bun or node: {exe}"
                    );
                    assert!(
                        config
                            .arguments()
                            .iter()
                            .any(|a| a.ends_with("dist/index.js") || a.ends_with("dist/main.js")),
                        "the entry file is an argument: {:?}",
                        config.arguments()
                    );
                    let spec = adapter_spec(key).unwrap();
                    let env = config.environment();
                    assert!(
                        env.contains_key(spec.cli_env),
                        "the harness CLI env {} is set: {:?}",
                        spec.cli_env,
                        env.keys().collect::<Vec<_>>()
                    );
                }
                Err(e) => {
                    // A declined render names its reason; an indecipherable
                    // error is itself the defect.
                    assert!(
                        e.contains("PATH")
                            || e.contains("not staged")
                            || e.contains("staged without"),
                        "the refusal names the missing piece: {e}"
                    );
                }
            }
        }
    }

    /// The interpreter pin is hard, never a soft preference: a witness that
    /// asks for node and gets bun is a witness that proved nothing.
    #[test]
    fn a_pinned_interpreter_is_the_one_used() {
        let path_var = effective_path();
        // Each runtime present interprets a pinned render.
        for pin in ["bun", "node"] {
            if which_in_path(pin, &path_var).is_none() {
                continue;
            }
            std::env::set_var("TEMPER_ACP_INTERPRETER", pin);
            let resolved = interpreter(&path_var).expect("the pinned interpreter resolves");
            std::env::remove_var("TEMPER_ACP_INTERPRETER");
            assert!(
                resolved.ends_with(pin),
                "pinned to {pin}, got {}",
                resolved.display()
            );
        }
        // A pin that resolves nowhere refuses by name.
        std::env::set_var("TEMPER_ACP_INTERPRETER", "no-such-runtime-019f");
        let err = interpreter(&path_var).expect_err("an absent pinned interpreter refuses");
        std::env::remove_var("TEMPER_ACP_INTERPRETER");
        assert!(
            err.contains("no-such-runtime-019f"),
            "the refusal names the pin: {err}"
        );
    }
}
