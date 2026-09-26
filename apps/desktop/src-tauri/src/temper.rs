// Package names on crates.io are `temperkb-*`; their lib names are `temper_*`.
use std::sync::Arc;

use serde::Serialize;
use temper_client::auth::DiskTokenStore;
use temper_client::config::build_client;
use temper_client::TemperClient;
use temper_workflow::operations::Surface;

/// The temper connection held by the Rust core.
///
/// The client reuses the machine's existing temper credentials (the same
/// disk store the CLI writes); the OAuth login flow is later work. Until the
/// credentials exist, `client` stays `None` and `connect_error` names why —
/// the UI shows that state rather than pretending to be connected.
pub struct TemperState {
    client: Option<Arc<TemperClient>>,
    connect_error: Option<String>,
}

impl TemperState {
    pub fn connect() -> Self {
        match Self::try_connect() {
            Ok(client) => Self {
                client: Some(Arc::new(client)),
                connect_error: None,
            },
            Err(err) => Self {
                client: None,
                connect_error: Some(err),
            },
        }
    }

    fn try_connect() -> Result<TemperClient, String> {
        let store = Arc::new(DiskTokenStore::default_path());
        build_client(store, Surface::Sdk).map_err(|e| e.to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    connected: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn temper_connection_status(state: tauri::State<TemperState>) -> ConnectionStatus {
    ConnectionStatus {
        connected: state.client.is_some(),
        error: state.connect_error.clone(),
    }
}

/// Fetches the signed-in person's profile through the temper API.
#[tauri::command]
pub async fn temper_whoami(state: tauri::State<'_, TemperState>) -> Result<serde_json::Value, String> {
    let client = state
        .client
        .as_ref()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let profile = client.profile().get().await.map_err(|e| e.to_string())?;
    serde_json::to_value(profile).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    /// Witness for the temperkb-client integration: builds the client the way
    /// the app does and completes one real API round-trip. Ignored by
    /// default — it needs the machine's temper credentials and network.
    /// Run locally: `cargo test -p desktop-lib -- --ignored`
    #[tokio::test]
    #[ignore = "requires temper credentials and network"]
    async fn profile_round_trip() {
        let state = super::TemperState::connect();
        let client = state
            .client
            .expect("machine temper credentials should resolve to a client");
        let profile = client
            .profile()
            .get()
            .await
            .expect("profile round-trip against the temper API");
        assert!(!profile.display_name.is_empty(), "profile should carry a display name");
    }
}
