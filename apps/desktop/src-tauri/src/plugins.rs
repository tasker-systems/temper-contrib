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
/// whose manifest cannot be read is named. No root at all is no packages — a package-less
/// desktop stays a desktop.
#[tauri::command]
pub fn plugin_packages() -> Result<Vec<PluginPackage>, String> {
    let Some(root) = plugins_root() else {
        return Ok(Vec::new());
    };
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&root)
        .map_err(|e| format!("failed to read the plugins dir {}: {e}", root.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|dir| dir.join("plugin.json").is_file())
        .collect();
    dirs.sort();
    dirs.iter()
        .map(|dir| {
            let name = dir
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| {
                    format!(
                        "the plugins dir holds a name that is not UTF-8: {}",
                        dir.display()
                    )
                })?
                .to_string();
            let text = std::fs::read_to_string(dir.join("plugin.json"))
                .map_err(|e| format!("failed to read {name}'s plugin.json: {e}"))?;
            Ok(PluginPackage {
                name,
                files: vec![PackageFile {
                    path: "plugin.json".to_string(),
                    text,
                }],
            })
        })
        .collect()
}
