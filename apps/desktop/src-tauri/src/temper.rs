// Package names on crates.io are `temperkb-*`; their lib names are `temper_*`.
use std::sync::Arc;

use serde::Serialize;
use temper_client::auth::DiskTokenStore;
use temper_client::config::build_client;
use temper_client::error::ClientError;
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
pub async fn temper_whoami(
    state: tauri::State<'_, TemperState>,
) -> Result<serde_json::Value, String> {
    let client = state
        .client
        .as_ref()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let profile = client.profile().get().await.map_err(|e| e.to_string())?;
    serde_json::to_value(profile).map_err(|e| e.to_string())
}

/// What a reference resolved to. Three outcomes, kept apart the way the region vocabulary keeps
/// empty apart from failed: `Unresolved` is the server saying there is nothing (or nothing you
/// can see) at that id; `Failed` is the read not completing, which verifies nothing either way.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum RefResolution {
    #[serde(rename_all = "camelCase")]
    Resolved {
        id: String,
        title: String,
        doc_type: String,
        context_ref: Option<String>,
        decorated_ref: String,
    },
    Unresolved {
        id: String,
        reason: String,
    },
    Failed {
        id: String,
        message: String,
    },
}

/// The UUID a ref names: a bare UUID, or the trailing UUID of a decorated `slug-<uuid>` ref.
pub fn parse_ref(raw: &str) -> Option<uuid::Uuid> {
    let raw = raw.trim();
    if raw.len() < 36 {
        return None;
    }
    let tail = &raw[raw.len() - 36..];
    let head = &raw[..raw.len() - 36];
    if !(head.is_empty() || head.ends_with('-')) {
        return None;
    }
    uuid::Uuid::parse_str(tail).ok()
}

async fn resolve_one(client: &TemperClient, raw: String) -> RefResolution {
    let Some(id) = parse_ref(&raw) else {
        return RefResolution::Unresolved {
            id: raw,
            reason: "not a resource reference".into(),
        };
    };
    match client.resources().get(id, None).await {
        Ok(view) => RefResolution::Resolved {
            id: raw,
            title: view.title,
            doc_type: view.doc_type_name,
            context_ref: view.context_ref,
            decorated_ref: view.r#ref,
        },
        Err(ClientError::NotFound { .. }) => RefResolution::Unresolved {
            id: raw,
            reason: "no resource at this reference".into(),
        },
        Err(ClientError::Gone { .. }) => RefResolution::Unresolved {
            id: raw,
            reason: "this resource is gone".into(),
        },
        Err(ClientError::Forbidden | ClientError::ForbiddenDetail { .. }) => {
            RefResolution::Unresolved {
                id: raw,
                reason: "not visible to you".into(),
            }
        }
        Err(err) => RefResolution::Failed {
            id: raw,
            message: err.to_string(),
        },
    }
}

/// Resolves references for display: title, doc type and home, read from temper. The webview
/// never shows a title an author typed as if it were the resource's own.
#[tauri::command]
pub async fn temper_resolve_refs(
    state: tauri::State<'_, TemperState>,
    ids: Vec<String>,
) -> Result<Vec<RefResolution>, String> {
    let client = state
        .client
        .as_ref()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let mut out = Vec::with_capacity(ids.len());
    for raw in ids {
        out.push(resolve_one(client, raw).await);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::parse_ref;

    #[test]
    fn parses_bare_and_decorated_refs() {
        let id = "01a0d873-59c9-72f0-a31f-23f0da5d8789";
        assert_eq!(parse_ref(id).unwrap().to_string(), id);
        assert_eq!(
            parse_ref(&format!("temper-is-worked-natively-{id}"))
                .unwrap()
                .to_string(),
            id
        );
        assert!(parse_ref("not-a-ref").is_none());
        assert!(
            parse_ref(&format!("x{id}")).is_none(),
            "a uuid glued to a slug is not a ref"
        );
    }

    /// Witness for reference resolution against the real API. Ignored by default — it needs the
    /// machine's temper credentials and network, and a resource the signed-in person can read.
    /// Run locally: `TEMPER_WITNESS_REF=<id> cargo test -- --ignored resolves_a_known_ref`
    #[tokio::test]
    #[ignore = "requires temper credentials, network, and TEMPER_WITNESS_REF"]
    async fn resolves_a_known_ref() {
        let state = super::TemperState::connect();
        let client = state
            .client
            .expect("machine temper credentials should resolve to a client");
        let known = std::env::var("TEMPER_WITNESS_REF")
            .expect("set TEMPER_WITNESS_REF to a readable resource id");
        match super::resolve_one(&client, known).await {
            super::RefResolution::Resolved { title, .. } => assert!(!title.is_empty()),
            other => panic!("expected the ref to resolve, got {other:?}"),
        }
        let missing = "00000000-0000-7000-8000-000000000000".to_string();
        assert!(
            matches!(
                super::resolve_one(&client, missing).await,
                super::RefResolution::Unresolved { .. }
            ),
            "a ref to nothing must read as unresolved, not failed"
        );
    }

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
        assert!(
            !profile.display_name.is_empty(),
            "profile should carry a display name"
        );
    }
}
