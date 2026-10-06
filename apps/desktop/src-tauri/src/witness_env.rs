//! Environment scoping shared by the crate's env-touching witnesses.
//!
//! Witnesses that relocate temper's stores must mutate the process
//! environment, and one test process runs many witnesses at once on
//! parallel threads. Every scoped mutation takes the same serial lock:
//! two independent scopes restoring their own snapshots of the same
//! variable could interleave and leave each other's prior state behind.
//! Restore-on-drop keeps a witness body's changes scoped even when an
//! assertion fails mid-body.

use std::sync::Mutex;

/// The one lock every env-touching witness holds for its body. The desktop
/// has no `temp_env` dev-dependency, so the scoping discipline temper's own
/// auth tests get from `temp_env::with_var(s)` is mirrored here with
/// restore-on-drop guards under this lock.
pub(crate) static ENV_SERIAL: Mutex<()> = Mutex::new(());

/// One env variable scoped to a witness body: set or removed for the body,
/// prior state restored on drop.
pub(crate) struct ScopedEnv {
    key: &'static str,
    prior: Option<String>,
}

impl ScopedEnv {
    pub(crate) fn set(key: &'static str, value: &str) -> Self {
        let prior = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, prior }
    }

    pub(crate) fn removed(key: &'static str) -> Self {
        let prior = std::env::var(key).ok();
        std::env::remove_var(key);
        Self { key, prior }
    }
}

impl Drop for ScopedEnv {
    fn drop(&mut self) {
        match &self.prior {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

/// Remove every named variable for a witness body, restoring on drop.
pub(crate) fn cleared(vars: &[&'static str]) -> Vec<ScopedEnv> {
    vars.iter().copied().map(ScopedEnv::removed).collect()
}
