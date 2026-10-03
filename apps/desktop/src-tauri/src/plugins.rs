//! The plugin packages the desktop ships beside itself: each a directory at the plugins root
//! holding a `plugin.json`. This module is format-blind — it scans and reads, and hands the raw
//! texts to the shell's loader, which owns what a manifest may say — so the loader can only ever
//! be answering for files that exist.
//!
//! Like the adapters, the plugins root resolves in one order for every process: the dev tree
//! first (the repository's `plugins/`, found from the manifest dir) and the bundle second
//! (`../Resources/plugins` beside the exe), because Tauri's `resource_dir()` answers the exe dir
//! for a cargo-run binary and `../Resources` inside a bundle. One code path for tests, dev, and
//! production.

use std::path::PathBuf;

use serde::Serialize;

/// One file of a package: its path within the package, and its raw text.
#[derive(Serialize)]
pub struct PackageFile {
    pub path: String,
    pub text: String,
}

/// One package: the directory's name, and the files the loader may read.
#[derive(Serialize)]
pub struct PluginPackage {
    pub name: String,
    pub files: Vec<PackageFile>,
}

/// One scanned directory: its package when it read whole, or the reason it did not. A
/// refusal's text names the package where the directory's name is derivable, and never
/// embeds a device path — it reaches the shell's foot.
#[derive(Serialize)]
pub struct ScanEntry {
    pub package: Option<PluginPackage>,
    pub error: Option<String>,
}

/// The repository's plugins dir in a checkout (`{CARGO_MANIFEST_DIR}/../../plugins`).
fn plugins_dev_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugins")
}

/// The plugins root in whichever layout this process is, or none: the dev tree
/// beside the checkout, or the bundle's `Resources/plugins` next to the exe.
fn plugins_root() -> Option<PathBuf> {
    let dev = plugins_dev_root();
    if dev.is_dir() {
        return Some(dev);
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))?;
    let bundled = exe_dir.join("../Resources/plugins");
    bundled.is_dir().then_some(bundled)
}

/// Every package at the plugins root, in directory-name order: the registration order the
/// shell reads. A directory holding no `plugin.json` is not a package and is passed over; one
/// whose manifest cannot be read comes back as a refusal entry, so one bad directory never
/// takes the healthy packages beside it down. No root at all is no packages — a package-less
/// desktop stays a desktop.
#[tauri::command]
pub async fn plugin_packages() -> Result<Vec<ScanEntry>, String> {
    let Some(root) = plugins_root() else {
        return Ok(Vec::new());
    };
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&root)
        .map_err(|e| format!("failed to read the plugins dir: {e}"))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|dir| dir.join("plugin.json").is_file())
        .collect();
    dirs.sort();
    Ok(dirs
        .iter()
        .map(|dir| {
            let Some(name) = dir.file_name().and_then(|name| name.to_str()) else {
                return ScanEntry {
                    package: None,
                    error: Some("a plugins dir holds a package whose name is not UTF-8".into()),
                };
            };
            match std::fs::read_to_string(dir.join("plugin.json")) {
                Ok(text) => ScanEntry {
                    package: Some(PluginPackage {
                        name: name.to_string(),
                        files: vec![PackageFile {
                            path: "plugin.json".to_string(),
                            text,
                        }],
                    }),
                    error: None,
                },
                Err(e) => ScanEntry {
                    package: None,
                    error: Some(format!(
                        "failed to read the {name} package's plugin.json: {e}"
                    )),
                },
            }
        })
        .collect())
}
