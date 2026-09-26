use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// One agent's launch facts. The fields exist so the sequenced agent-config
/// task has a home; nothing populates them yet, so no command writes them.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentLaunch {
    pub binary_path: Option<String>,
    pub command: Option<String>,
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
}
