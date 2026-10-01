fn main() {
    // tauri-build copies `bundle.resources` at compile time and hard-errors on
    // a missing path — before any Tauri beforeBuildCommand could stage the
    // adapter tree. So the tree must exist at every cargo build. When the
    // desktop's node_modules is present (any dev checkout, and CI jobs that
    // run `bun install` first), stage it properly: the staging script is
    // idempotent and carries the resolution/import gates. When node_modules is
    // absent (the cargo-only CI jobs, where `bun install` never ran), lay down
    // the tree's shape without the vendored packages: enough for the build to
    // proceed, carrying a marker that a cargo-only build produced it — a
    // bundle from such a host is not a shippable artifact anyway (the desktop
    // gates its real builds through the Tauri commands, whose
    // beforeBuildCommand runs the full staging first).
    let desktop_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .expect("the desktop root canonicalizes");
    let staging = desktop_root.join("acp-adapter-staging");
    if !staging.join("node_modules").is_dir() {
        if desktop_root.join("node_modules").is_dir() {
            let script = desktop_root.join("scripts/build-adapters.sh");
            let status = std::process::Command::new("bash").arg(&script).status();
            match status {
                Ok(s) if s.success() => {}
                other => panic!(
                    "adapter staging failed ({other:?}); run `bun run build:adapters` and read its gates"
                ),
            }
        } else {
            // The placeholder tree: the directory the config names, and a
            // NOTICE saying what it is not.
            std::fs::create_dir_all(staging.join("node_modules"))
                .expect("the staging tree's shape can be created");
            std::fs::write(
                staging.join("NOTICE"),
                "Placeholder: created by a cargo build without the desktop's node_modules. \
                 Run `bun install && bun run build:adapters` in apps/desktop for the adapters.\n",
            )
            .expect("the placeholder notice writes");
        }
    }
    tauri_build::build()
}
