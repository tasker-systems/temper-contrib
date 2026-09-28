use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One agent's launch facts, as the device store holds them. `command` is
/// a launch command string — `opencode acp`, `npx -y @zed-industries/
/// claude-code-acp` — parsed the way the ACP crate parses command strings,
/// or a JSON object carrying command, args, and env verbatim. `label` is
/// the picker's word for it. `binary_path` is kept for the store's shape;
/// a configured agent is launched by `command`, and the path is a hint the
/// config layer may set the command to.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentLaunch {
    pub binary_path: Option<String>,
    pub command: Option<String>,
    pub label: Option<String>,
}

/// The device tier: facts about this machine, not the person. Held in an
/// app-data file owned by the core; the webview reads and writes through
/// commands and never touches the file itself.
///
/// The theme value is held opaquely: the webview owns the preference's
/// semantics and validates it on read, so the core never learns them.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceSettings {
    pub working_dir: Option<String>,
    pub agents: BTreeMap<String, AgentLaunch>,
    pub theme: Option<serde_json::Value>,
    /// The name of the temper context this app stores the person's facts in,
    /// profile-owned (`@<handle>/<name>`). Unset means the default; an
    /// app-setup flow will own choosing and validating it.
    pub temper_context: Option<String>,
    /// What this device is called where its facts meet another device's —
    /// the hub's recent work says "on `<label>`". Unset means the machine's
    /// hostname.
    pub device_label: Option<String>,
}

/// The context name used until a setting says otherwise.
pub const DEFAULT_TEMPER_CONTEXT: &str = "temper-desktop";

impl DeviceSettings {
    /// The configured context name — the setting, or the default when unset.
    pub fn temper_context_name(&self) -> &str {
        self.temper_context
            .as_deref()
            .unwrap_or(DEFAULT_TEMPER_CONTEXT)
    }
}

impl DeviceSettings {
    /// The device's label — the setting, else the machine's hostname, else
    /// words that say only that it is this device.
    pub fn device_label(&self) -> String {
        self.device_label
            .as_deref()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .or_else(|| machine_hostname().clone())
            .unwrap_or_else(|| "this device".to_string())
    }
}

/// The machine's hostname, asked once. `hostname` answers on macOS and
/// Linux alike; a machine where it does not is simply unnamed.
fn machine_hostname() -> &'static Option<String> {
    static HOSTNAME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    HOSTNAME.get_or_init(|| {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|name| name.trim().trim_end_matches(".local").to_string())
            .filter(|name| !name.is_empty())
    })
}

const FILE_NAME: &str = "device-settings.json";

/// The device store, backed by `device-settings.json` in the app-data directory.
pub struct SettingsState {
    path: PathBuf,
    settings: Mutex<DeviceSettings>,
}

impl SettingsState {
    /// Loads the store. A missing or malformed file yields the defaults in
    /// memory; the file itself is never rewritten at load time, so a
    /// malformed one survives until the next deliberate save.
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join(FILE_NAME);
        let settings = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            settings: Mutex::new(settings),
        }
    }

    pub fn get(&self) -> DeviceSettings {
        self.settings.lock().expect("settings lock").clone()
    }

    pub fn set_working_dir(&self, dir: String) -> Result<(), String> {
        self.persist(|s| s.working_dir = Some(dir))
    }

    pub fn set_theme(&self, theme: serde_json::Value) -> Result<(), String> {
        self.persist(|s| s.theme = Some(theme))
    }

    pub fn set_temper_context(&self, name: String) -> Result<(), String> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("a temper context name is required".to_string());
        }
        self.persist(|s| s.temper_context = Some(name))
    }

    /// Names this device. A blank label clears it, back to the hostname.
    pub fn set_device_label(&self, label: String) -> Result<(), String> {
        let label = label.trim().to_string();
        self.persist(|s| s.device_label = (!label.is_empty()).then_some(label))
    }

    /// The device's label as the hub records it.
    pub fn device_label(&self) -> String {
        self.get().device_label()
    }

    /// Stores one agent's launch facts by its key. An empty launch command
    /// is refused: a configured agent that cannot be launched is a lie in
    /// the picker, not a disabled entry.
    pub fn set_agent(&self, key: String, launch: AgentLaunch) -> Result<(), String> {
        let key = key.trim().to_string();
        if key.is_empty() {
            return Err("an agent key is required".to_string());
        }
        match launch.command.as_deref().map(str::trim) {
            None | Some("") => {
                return Err(format!("agent {key} needs a launch command"));
            }
            _ => {}
        }
        self.persist(|s| {
            s.agents.insert(key, launch);
        })
    }

    /// Removes one configured agent. Removing the last one leaves the
    /// picker empty — the room then has no agent to offer, and says so,
    /// rather than falling back to a hardcoded default.
    pub fn remove_agent(&self, key: &str) -> Result<(), String> {
        self.persist(|s| {
            s.agents.remove(key);
        })
    }

    /// Persists first, then commits to memory: a failed write leaves the
    /// in-memory state untouched, so memory never claims a save the file lost.
    ///
    /// The lock is held across the whole read-modify-write, so two saves can
    /// never both start from the same snapshot and have the second overwrite
    /// the first's change — whichever thread or async runtime the commands
    /// run on.
    fn persist(&self, apply: impl FnOnce(&mut DeviceSettings)) -> Result<(), String> {
        let mut current = self.settings.lock().expect("settings lock");
        let mut next = current.clone();
        apply(&mut next);
        Self::write(&self.path, &next)?;
        *current = next;
        Ok(())
    }

    /// Atomic write: a temp file renamed over the target, so a crash mid-write
    /// never leaves a truncated store behind.
    fn write(path: &PathBuf, settings: &DeviceSettings) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
        fs::write(&tmp, raw).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub fn settings_get(state: tauri::State<SettingsState>) -> DeviceSettings {
    state.get()
}

#[tauri::command]
pub fn settings_set_working_dir(
    state: tauri::State<SettingsState>,
    dir: String,
) -> Result<(), String> {
    state.set_working_dir(dir)
}

#[tauri::command]
pub fn settings_set_theme(
    state: tauri::State<SettingsState>,
    theme: serde_json::Value,
) -> Result<(), String> {
    state.set_theme(theme)
}

#[tauri::command]
pub fn settings_set_temper_context(
    state: tauri::State<SettingsState>,
    name: String,
) -> Result<(), String> {
    state.set_temper_context(name)
}

#[tauri::command]
pub fn settings_set_device_label(
    state: tauri::State<SettingsState>,
    label: String,
) -> Result<(), String> {
    state.set_device_label(label)
}

#[tauri::command]
pub fn settings_set_agent(
    state: tauri::State<SettingsState>,
    key: String,
    launch: AgentLaunch,
) -> Result<(), String> {
    state.set_agent(key, launch)
}

#[tauri::command]
pub fn settings_remove_agent(
    state: tauri::State<SettingsState>,
    key: String,
) -> Result<(), String> {
    state.remove_agent(&key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("desktop-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// Witness for the store's reason to exist: a value written through one
    /// instance is read back through a fresh one — restart, same store.
    #[test]
    fn survives_a_restart_from_the_file() {
        let dir = temp_dir();
        let theme = json!({ "follow": "fixed", "name": "quiet-instrument-paper" });
        {
            let first = SettingsState::load(dir.clone());
            first
                .set_working_dir("/home/dev/project".to_string())
                .expect("save the working directory");
            first.set_theme(theme.clone()).expect("save the theme");
        }
        let second = SettingsState::load(dir);
        assert_eq!(
            second.get().working_dir.as_deref(),
            Some("/home/dev/project")
        );
        assert_eq!(second.get().theme, Some(theme));
    }

    /// Saves of different fields made at the same time all survive: none is
    /// lost to another that started from the same snapshot.
    #[test]
    fn concurrent_saves_keep_every_change() {
        let dir = temp_dir();
        let state = std::sync::Arc::new(SettingsState::load(dir.clone()));
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let state = state.clone();
                std::thread::spawn(move || {
                    if i % 2 == 0 {
                        state
                            .set_working_dir(format!("/dir/{i}"))
                            .expect("save dir");
                    } else {
                        state
                            .set_theme(json!({ "follow": "fixed", "name": format!("t{i}") }))
                            .expect("save theme");
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("thread");
        }
        let reloaded = SettingsState::load(dir).get();
        assert!(
            reloaded.working_dir.is_some(),
            "a working-directory save was lost"
        );
        assert!(reloaded.theme.is_some(), "a theme save was lost");
        assert_eq!(reloaded, state.get(), "memory and file agree");
    }

    #[test]
    fn a_missing_file_loads_defaults() {
        let state = SettingsState::load(temp_dir());
        assert_eq!(state.get(), DeviceSettings::default());
    }

    #[test]
    fn a_malformed_file_loads_defaults_without_rewriting_it() {
        let dir = temp_dir();
        fs::write(dir.join(FILE_NAME), "{not json").expect("write malformed store");
        let state = SettingsState::load(dir.clone());
        assert_eq!(state.get(), DeviceSettings::default());
        assert_eq!(
            fs::read_to_string(dir.join(FILE_NAME)).expect("file still there"),
            "{not json",
            "a malformed store is not silently replaced at load"
        );
    }

    /// The context name reads as the default until set, and a set name
    /// survives a restart — it is what the record writes will match against.
    #[test]
    fn the_temper_context_name_defaults_then_survives_a_restart() {
        let dir = temp_dir();
        {
            let first = SettingsState::load(dir.clone());
            assert_eq!(first.get().temper_context_name(), DEFAULT_TEMPER_CONTEXT);
            first
                .set_temper_context("my-desktop".to_string())
                .expect("save the context name");
        }
        let second = SettingsState::load(dir);
        assert_eq!(second.get().temper_context_name(), "my-desktop");
    }

    #[test]
    fn an_empty_context_name_is_refused_and_changes_nothing() {
        let state = SettingsState::load(temp_dir());
        assert!(state.set_temper_context("   ".to_string()).is_err());
        assert_eq!(state.get().temper_context, None);
    }

    #[test]
    fn a_failed_write_leaves_memory_untouched() {
        let dir = temp_dir();
        let blocker = dir.join("blocker");
        fs::write(&blocker, "x").expect("blocker file");
        let state = SettingsState::load(blocker.join(FILE_NAME));
        assert!(
            state.set_working_dir("/x".to_string()).is_err(),
            "a store whose parent is a file cannot be written"
        );
        assert_eq!(state.get(), DeviceSettings::default());
    }

    // --- Agents by configuration ---------------------------------------------

    fn launch(command: &str) -> AgentLaunch {
        AgentLaunch {
            label: Some("opencode".to_string()),
            command: Some(command.to_string()),
            binary_path: None,
        }
    }

    /// Witness for the configured-picker clause: an agent stored through one
    /// instance is in the picker's data through a fresh one — configuration,
    /// not code. The store's shape carries it whole (command, label).
    #[test]
    fn a_configured_agent_survives_a_restart_and_reaches_the_picker() {
        let dir = temp_dir();
        {
            let first = SettingsState::load(dir.clone());
            first
                .set_agent("opencode".to_string(), launch("opencode acp"))
                .expect("save the agent");
        }
        let second = SettingsState::load(dir);
        let agents = second.get().agents;
        assert_eq!(
            agents.len(),
            1,
            "the configured agent is the picker's whole roster"
        );
        assert_eq!(
            agents.get("opencode").and_then(|a| a.command.as_deref()),
            Some("opencode acp")
        );
    }

    /// An agent with no launch command is refused: a configured agent that
    /// cannot be launched is a lie in the picker.
    #[test]
    fn an_agent_without_a_launch_command_is_refused() {
        let state = SettingsState::load(temp_dir());
        assert!(state
            .set_agent("broken".to_string(), AgentLaunch::default())
            .is_err());
        assert!(state
            .set_agent(
                "blank".to_string(),
                AgentLaunch {
                    command: Some("   ".to_string()),
                    ..AgentLaunch::default()
                }
            )
            .is_err());
        assert!(
            state.get().agents.is_empty(),
            "nothing half-configured landed"
        );
    }

    /// An empty key is refused; a removal works and removing the last agent
    /// leaves the store's roster empty — the picker says so, it never falls
    /// back to a hardcoded default.
    #[test]
    fn an_empty_key_is_refused_and_removal_clears_the_roster() {
        let dir = temp_dir();
        let state = SettingsState::load(dir);
        assert!(state
            .set_agent("  ".to_string(), launch("opencode acp"))
            .is_err());
        state
            .set_agent("opencode".to_string(), launch("opencode acp"))
            .expect("save");
        state.remove_agent("opencode").expect("remove the agent");
        assert!(
            state.get().agents.is_empty(),
            "the roster is empty, not defaulted"
        );
    }
}
