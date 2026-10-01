//! The ACP agent roster: launch presets for the most common agents, as data.
//!
//! The roster is a toml file shipped with the desktop (parsed at compile time via
//! `include_str!`), cited to the ACP site's agent list — never a hardcoded scan of the
//! machine. What the desktop does verify is only the one fact that makes an entry
//! selectable: the entry's probed binary resolves on `$PATH`. Whether the agent speaks
//! ACP is not verified — launching is the proof; the roster only proposes what is common.

use serde::Serialize;
use std::path::PathBuf;

/// One entry of the bundled roster, exactly as the toml holds it.
#[derive(serde::Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
    /// The word the device store keys it by — also the picker's default when
    /// a label is absent, which a bundled entry never is.
    pub key: String,
    /// The picker's word for it.
    pub label: String,
    /// The binary name probed on `$PATH`.
    pub binary: String,
    /// The launch command the store receives on selection.
    pub command: String,
}

const ROSTER_TOML: &str = include_str!("agents-roster.toml");

/// The bundled roster. The file is authored data; a malformed one is a broken
/// build, not a runtime state — so a parse failure here is a panic, at startup,
/// where it cannot be mistaken for an empty roster.
pub fn roster() -> Vec<RosterEntry> {
    let raw: toml::Value = toml::from_str(ROSTER_TOML).expect("the bundled roster parses");
    raw.get("agents")
        .and_then(|v| v.clone().try_into::<Vec<RosterEntry>>().ok())
        .expect("the bundled roster carries an [[agents]] array")
}

/// Finds one bundled roster preset by its key.
#[cfg(test)]
pub fn roster_entry(key: &str) -> Option<RosterEntry> {
    roster().into_iter().find(|e| e.key == key)
}

/// Where one roster entry stands on this machine.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ProbeStatus {
    /// The probed binary resolved on `$PATH`: the entry may be offered.
    Present,
    /// The probed binary is not on `$PATH`: the entry is offered nothing.
    Absent,
    /// The entry cannot be probed honestly — it names no binary.
    NoCommand,
}

/// The probed binary's name, trimmed, or the honest refusal when the entry
/// names none. Whitespace-only or shell-word-shaped garbage is not a binary.
fn probe_binary(entry: &RosterEntry) -> Result<String, ProbeStatus> {
    let name = entry.binary.trim();
    if name.is_empty() {
        return Err(ProbeStatus::NoCommand);
    }
    if name.split_whitespace().count() != 1 {
        return Err(ProbeStatus::NoCommand);
    }
    Ok(name.to_string())
}

/// One entry with its probe's answer, as the webview reads the roster.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RosterOffer {
    #[serde(flatten)]
    pub entry: RosterEntry,
    pub status: ProbeStatus,
}

/// Probes every roster entry's binary against the directories of `$PATH` in
/// order, first hit wins — the same resolution a shell would give. `path_var`
/// is the `$PATH` text, named for the probe's witnesses.
pub fn probe_roster(entries: &[RosterEntry], path_var: &str) -> Vec<RosterOffer> {
    let dirs: Vec<PathBuf> = std::env::split_paths(path_var).collect();
    entries
        .iter()
        .map(|entry| {
            let status = probe_binary(entry).and_then(|bin| {
                if dirs.iter().any(|d| d.join(&bin).is_file()) {
                    Ok(ProbeStatus::Present)
                } else {
                    Err(ProbeStatus::Absent)
                }
            });
            match status {
                Ok(status) => RosterOffer {
                    entry: entry.clone(),
                    status,
                },
                Err(status) => RosterOffer {
                    entry: entry.clone(),
                    status,
                },
            }
        })
        .collect()
}

/// The roster the webview reads: the bundled presets with this machine's
/// probe answers beside each. The picker and the settings room read the same
/// command, so the two can never disagree about what `$PATH` holds.
///
/// GUI apps inherit a minimal `$PATH` (`/usr/bin:/bin`, sometimes `/usr/sbin:/sbin`),
/// so the probe resolves the login shell's PATH and asks against that when the
/// process PATH carries none of the usual user-level prefixes — a homebrew or
/// cargo bin launched from Finder is exactly the agent a person has installed.
#[tauri::command]
pub fn roster_get() -> Vec<RosterOffer> {
    probe_roster(&roster(), &effective_path())
}

/// The PATH the probe asks: the process's own, unless it looks like a GUI
/// default, then the login shell's. Asked once per call — the PATH a person
/// has is their setup, not a cached fact.
pub fn effective_path() -> String {
    let process_path = std::env::var("PATH").unwrap_or_default();
    if process_path_looks_minimal(&process_path) {
        if let Some(login_path) = login_shell_path().as_ref() {
            if !login_path.is_empty() {
                return login_path.clone();
            }
        }
    }
    process_path
}

/// The usual GUI-default PATHs: system bins only. Anything wider (homebrew,
/// cargo, a dotfile-set PATH) probes from the process PATH as-is.
fn process_path_looks_minimal(path: &str) -> bool {
    if path.trim().is_empty() {
        return true;
    }
    let dirs: Vec<std::path::PathBuf> = std::env::split_paths(path).collect();
    if dirs.is_empty() {
        return true;
    }
    dirs.iter().all(|d| {
        // The system defaults; a dir under $HOME or /opt has no business being
        // in a GUI default — its presence says the app got a real PATH.
        d.starts_with("/usr/bin")
            || d.starts_with("/bin")
            || d.starts_with("/usr/sbin")
            || d.starts_with("/sbin")
    })
}

/// The login shell's PATH: the person's shell asked with `-l -c 'echo $PATH'` —
/// the same PATH a person's terminal gives their tools. The user's `$SHELL` is
/// preferred, falling back through the common shells, because macOS GUI apps
/// inherit no `$SHELL` at all. A shell that cannot be asked (a failing `-l`, a
/// print wider than one line) costs its turn and nothing else.
fn login_shell_path() -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.trim().is_empty() {
            candidates.push(shell);
        }
    }
    for default in ["/bin/zsh", "/bin/bash"] {
        if std::path::Path::new(default).exists() && !candidates.contains(&default.to_string()) {
            candidates.push(default.to_string());
        }
    }
    for shell in candidates {
        if let Some(path) = ask_the_shell_path(&shell) {
            return Some(path);
        }
    }
    None
}

/// One shell asked for its PATH; None when it does not answer with one line.
fn ask_the_shell_path(shell: &str) -> Option<String> {
    let output = std::process::Command::new(shell)
        .args(["-l", "-c", "echo $PATH"])
        .output()
        .ok()
        .filter(|out| out.status.success())?;
    let path = String::from_utf8(output.stdout).ok()?;
    let path = path.trim().to_string();
    // An echo of a string with a newline or a message in it is not a PATH.
    if path.lines().count() > 1 {
        return None;
    }
    (!path.is_empty()).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    /// The bundled roster parses, and every entry is fully named — a truncated
    /// entry would be a lie the picker cannot express.
    #[test]
    fn the_bundled_roster_parses_whole() {
        let roster = roster();
        assert!(roster.len() >= 5, "the five common agents are present");
        for entry in &roster {
            assert!(!entry.key.trim().is_empty(), "entry keys are non-empty");
            assert!(!entry.label.trim().is_empty(), "entry labels are non-empty");
            assert!(
                !entry.binary.trim().is_empty(),
                "entry binaries are non-empty"
            );
            assert!(
                !entry.command.trim().is_empty(),
                "entry commands are non-empty"
            );
        }
        let keys: std::collections::BTreeSet<&str> =
            roster.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys.len(), roster.len(), "entry keys are distinct");
    }

    /// The preset rows the roster names, with the launch each doc states.
    #[test]
    fn the_common_agents_are_preset() {
        let roster = roster();
        let by_key = |k: &str| {
            roster
                .iter()
                .find(|e| e.key == k)
                .unwrap_or_else(|| panic!("roster entry {k} present"))
        };
        assert_eq!(by_key("opencode").command, "opencode acp");
        assert_eq!(by_key("cursor").binary, "agent");
        assert_eq!(by_key("cursor").command, "agent acp");
        assert_eq!(by_key("gemini").command, "gemini --acp");
        assert_eq!(
            by_key("codex").command,
            "npx -y @agentclientprotocol/codex-acp@^2.0.0"
        );
        assert_eq!(
            by_key("claude").command,
            "npx -y @agentclientprotocol/claude-agent-acp@^0.84.0"
        );
        assert_eq!(by_key("antigravity").binary, "agy");
        assert_eq!(by_key("antigravity").command, "npx -y agy-acp@^0.5.2");
    }

    #[test]
    fn roster_entry_resolves_presets_by_key() {
        assert_eq!(roster_entry("claude").map(|e| e.key), Some("claude".into()));
        assert_eq!(
            roster_entry("antigravity").map(|e| e.key),
            Some("antigravity".into())
        );
        assert!(roster_entry("nonexistent-agent").is_none());
    }

    fn entry(binary: &str) -> RosterEntry {
        RosterEntry {
            key: "k".into(),
            label: "L".into(),
            binary: binary.into(),
            command: "cmd".into(),
        }
    }

    /// A binary present on `$PATH` probes as present, and one that is not is absent.
    #[test]
    fn a_present_binary_probes_present() {
        let dir = std::env::temp_dir().join("probe-present-dir");
        fs::create_dir_all(&dir).expect("dir");
        let bin = dir.join("probed-agent-present");
        fs::write(&bin, b"").expect("binary");
        #[cfg(unix)]
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).expect("chmod");

        let path = format!("{}:/usr/bin", dir.display());
        let offers = probe_roster(&[entry("probed-agent-present")], &path);
        assert_eq!(offers[0].status, ProbeStatus::Present);
        let offers = probe_roster(&[entry("probed-agent-named-but-uninstalled")], &path);
        assert_eq!(offers[0].status, ProbeStatus::Absent);
        assert_eq!(
            offers[0].entry.command, "cmd",
            "the offer carries the launch command the store receives"
        );
    }

    /// A binary absent from `$PATH` probes as absent — and the absent row is
    /// the one the settings room does not render.
    #[test]
    fn an_absent_binary_probes_absent() {
        let offers = probe_roster(&[entry("no-such-agent-anywhere-019f")], "/usr/bin");
        assert_eq!(offers[0].status, ProbeStatus::Absent);
    }

    /// An entry that names no binary offers nothing, honestly.
    #[test]
    fn a_blank_binary_probes_no_command() {
        for name in ["", "   "] {
            let offers = probe_roster(&[entry(name)], "/usr/bin");
            assert_eq!(offers[0].status, ProbeStatus::NoCommand);
        }
        let garbled = entry("npx -y some/package");
        let offers = probe_roster(&[garbled], "/usr/bin");
        assert_eq!(offers[0].status, ProbeStatus::NoCommand);
    }

    /// The process PATH a GUI app inherits — system bins only — and nothing
    /// else, counts as minimal: a homebrew or cargo bin launched from Finder
    /// must not read absent.
    #[test]
    fn a_gui_default_path_is_minimal() {
        for path in ["/usr/bin:/bin", "/usr/bin:/bin:/usr/sbin:/sbin", ""] {
            assert!(process_path_looks_minimal(path), "{path} is minimal");
        }
        for path in [
            "/opt/homebrew/bin:/usr/bin:/bin",
            "/Users/dev/.cargo/bin:/usr/bin",
            "/usr/local/bin:/usr/bin:/bin",
            "/usr/bin:/bin:/opt/homebrew/bin",
        ] {
            assert!(!process_path_looks_minimal(path), "{path} is not minimal");
        }
    }

    /// The login shell's PATH answers on macOS and Linux like a terminal's,
    /// with no `$SHELL` in the env (a GUI app's state) falling through to the
    /// common shells; a shell that prints anything wider than one line is not
    /// a PATH and costs the fallback.
    #[test]
    fn the_login_shell_answers_with_one_line() {
        if let Some(path) = login_shell_path() {
            assert_eq!(path.lines().count(), 1, "the login PATH is one line");
            assert!(!path.is_empty());
        }
        // A machine where no shell answers is simply unnamed: the process PATH
        // falls through, the probe reads what the app actually got.
    }

    #[test]
    fn a_shell_asked_answers_one_line() {
        // /bin/sh exists everywhere and prints one line for `echo $PATH`.
        if std::path::Path::new("/bin/sh").exists() {
            let path = ask_the_shell_path("/bin/sh");
            assert!(path.is_some(), "/bin/sh answers with a PATH");
            assert_eq!(path.unwrap().lines().count(), 1);
        }
    }
}
#[cfg(test)]
mod dbgtests {
    use super::*;
    #[test]
    fn dbg_minimal() {
        for path in ["/usr/bin:/bin", "/usr/bin:/bin:/usr/sbin:/sbin", ""] {
            eprintln!("{} -> {}", path, process_path_looks_minimal(path));
        }
    }
}
