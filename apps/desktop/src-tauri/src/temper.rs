// Package names on crates.io are `temperkb-*`; their lib names are `temper_*`.
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use temper_client::auth::DiskTokenStore;
use temper_client::config::build_client;
use temper_client::error::ClientError;
use temper_client::TemperClient;
use temper_workflow::operations::Surface;
use temper_workflow::types::resource::{ResourceListParams, ResourceSortField, SortOrder};

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

    /// The connected client, when the machine's credentials resolved to one.
    pub fn client(&self) -> Option<&TemperClient> {
        self.client.as_deref()
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
        Err(err) => match unresolved_reason(&err) {
            Some(reason) => RefResolution::Unresolved {
                id: raw,
                reason: reason.into(),
            },
            None => RefResolution::Failed {
                id: raw,
                message: err.to_string(),
            },
        },
    }
}

/// Why a read found nothing the person can see, when that is what the error says. `None` means
/// the read did not complete — a failure that verifies nothing either way, never an absence.
pub(crate) fn unresolved_reason(err: &ClientError) -> Option<&'static str> {
    match err {
        ClientError::NotFound { .. } => Some("no resource at this reference"),
        ClientError::Gone { .. } => Some("this resource is gone"),
        ClientError::Forbidden | ClientError::ForbiddenDetail { .. } => Some("not visible to you"),
        _ => None,
    }
}

/// One team the signed-in person belongs to, as the teams view reads it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemperTeam {
    pub id: uuid::Uuid,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
}

/// One visible context, as the contexts view reads it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemperContext {
    pub id: uuid::Uuid,
    pub name: String,
    pub slug: String,
    pub owner_ref: String,
    pub resource_count: i64,
    /// RFC 3339 — the webview words recency from it; the desktop adds no clock dependency.
    pub updated: String,
}

/// One row of the recent-work list: what the thing is and where it lives, never its body.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemperRecentRow {
    pub id: uuid::Uuid,
    pub decorated_ref: String,
    pub title: String,
    pub doc_type: String,
    pub context_ref: Option<String>,
    /// RFC 3339, same shape as the contexts view's `updated`.
    pub updated: String,
}

/// One bounded page of the recent-work list. `total` is every row the read
/// could see — what the view's omission sentence is composed from.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemperRecentWork {
    pub total: i64,
    pub rows: Vec<TemperRecentRow>,
}

fn temper_client<'a>(state: &'a tauri::State<'_, TemperState>) -> Result<&'a TemperClient, String> {
    state
        .client
        .as_ref()
        .map(|client| client.as_ref())
        .ok_or_else(|| "temper is not connected".to_string())
}

/// The teams the signed-in person belongs to, read from temper.
#[tauri::command]
pub async fn temper_teams(state: tauri::State<'_, TemperState>) -> Result<Vec<TemperTeam>, String> {
    let rows = temper_client(&state)?
        .teams()
        .list()
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|t| TemperTeam {
            id: t.id,
            slug: t.slug,
            name: t.name,
            description: t.description,
        })
        .collect())
}

/// Every context the signed-in person can see, with their resource counts.
#[tauri::command]
pub async fn temper_contexts(
    state: tauri::State<'_, TemperState>,
) -> Result<Vec<TemperContext>, String> {
    let rows = temper_client(&state)?
        .contexts()
        .list()
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|c| TemperContext {
            id: c.id.0,
            name: c.name,
            slug: c.slug,
            owner_ref: c.owner_ref,
            resource_count: c.resource_count,
            updated: c.updated.to_rfc3339(),
        })
        .collect())
}

/// A context the app just created, as the create read it back. It carries no
/// resource count — a count is a read's fact, and this command made no read.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemperCreatedContext {
    pub id: uuid::Uuid,
    pub name: String,
    pub slug: String,
    pub owner_ref: String,
    /// RFC 3339, same shape as the contexts view's `updated`.
    pub updated: String,
}

/// The name a context-create accepts: trimmed and non-empty. The setup flow is
/// its caller, but the refusal is the command's, tested here without a client.
pub fn trimmed_context_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a temper context name is required".to_string());
    }
    Ok(name.to_string())
}

/// Creates a profile-owned context for the signed-in person (`@<handle>/<name>`)
/// — the only owner the setup flow targets. The person context the desktop
/// stores facts in is created here when it does not exist yet.
#[tauri::command]
pub async fn temper_context_create(
    state: tauri::State<'_, TemperState>,
    name: String,
) -> Result<TemperCreatedContext, String> {
    let name = trimmed_context_name(&name)?;
    let row = temper_client(&state)?
        .contexts()
        .create(&name, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TemperCreatedContext {
        id: row.id.0,
        name: row.name,
        slug: row.slug,
        owner_ref: row.owner_ref,
        updated: row.updated.to_rfc3339(),
    })
}

/// One bounded page of the person's recent work: visible resources, newest
/// update first. `offset` walks further into the same ordering.
#[tauri::command]
pub async fn temper_recent_work(
    state: tauri::State<'_, TemperState>,
    limit: i64,
    offset: i64,
) -> Result<TemperRecentWork, String> {
    list_page(
        &state,
        list_params(&ResourceFilter::default(), limit, offset),
    )
    .await
}

/// What a bounded list read narrows by — the left panel's entries name one each
/// (goals that are active, tasks in progress, recent sessions). Every field is
/// optional; an empty filter is the recent-work ordering itself.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceFilter {
    pub doc_type: Option<String>,
    /// Task workflow stage (`backlog`, `in-progress`, `done`, `cancelled`).
    pub stage: Option<String>,
    /// Goal lifecycle status (`active`, `completed`, `paused`, `cancelled`).
    pub status: Option<String>,
    /// A context ref (`@owner/slug`, `+team/slug`, or a UUID).
    pub context_ref: Option<String>,
}

/// The largest page a list read asks for: a list is bounded and says what it
/// omits, so a caller walks further with `offset` rather than asking for all.
pub const LIST_PAGE_MAX: i64 = 100;

/// The list params a filter reads as: newest update first, the page bounded,
/// blank filter fields dropped rather than sent as a filter matching nothing.
pub fn list_params(filter: &ResourceFilter, limit: i64, offset: i64) -> ResourceListParams {
    let given = |v: &Option<String>| {
        v.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    ResourceListParams {
        doc_type_name: given(&filter.doc_type),
        stage: given(&filter.stage),
        status: given(&filter.status),
        context_ref: given(&filter.context_ref),
        sort: Some(ResourceSortField::Updated),
        order: Some(SortOrder::Desc),
        limit: Some(limit.clamp(1, LIST_PAGE_MAX)),
        offset: Some(offset.max(0)),
        ..Default::default()
    }
}

/// One bounded page of visible resources under a filter, newest update first —
/// answered in the recent-work shape, so every list says its total.
#[tauri::command]
pub async fn temper_list_resources(
    state: tauri::State<'_, TemperState>,
    filter: ResourceFilter,
    limit: i64,
    offset: i64,
) -> Result<TemperRecentWork, String> {
    list_page(&state, list_params(&filter, limit, offset)).await
}

async fn list_page(
    state: &tauri::State<'_, TemperState>,
    params: ResourceListParams,
) -> Result<TemperRecentWork, String> {
    let page = temper_client(state)?
        .resources()
        .list_meta(&params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TemperRecentWork {
        total: page.total,
        rows: page
            .rows
            .into_iter()
            .map(|r| TemperRecentRow {
                id: r.id.0,
                decorated_ref: r.r#ref,
                title: r.title,
                doc_type: r.doc_type_name,
                context_ref: r.context_ref,
                updated: r.updated.to_rfc3339(),
            })
            .collect(),
    })
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
    use super::{list_params, parse_ref, ResourceFilter, LIST_PAGE_MAX};
    use temper_workflow::types::resource::{ResourceSortField, SortOrder};

    #[test]
    fn a_filter_reads_as_newest_first_and_bounded() {
        let filter = ResourceFilter {
            doc_type: Some("task".into()),
            stage: Some("in-progress".into()),
            status: Some("  ".into()),
            context_ref: None,
        };
        let params = list_params(&filter, 10, 20);
        assert_eq!(params.doc_type_name.as_deref(), Some("task"));
        assert_eq!(params.stage.as_deref(), Some("in-progress"));
        // A blank field is no filter, never a filter matching nothing.
        assert_eq!(params.status, None);
        assert_eq!(params.context_ref, None);
        assert!(matches!(params.sort, Some(ResourceSortField::Updated)));
        assert!(matches!(params.order, Some(SortOrder::Desc)));
        assert_eq!((params.limit, params.offset), (Some(10), Some(20)));
    }

    #[test]
    fn a_page_is_bounded_whatever_is_asked() {
        let params = list_params(&ResourceFilter::default(), 10_000, -5);
        assert_eq!(params.limit, Some(LIST_PAGE_MAX));
        assert_eq!(params.offset, Some(0));
        assert_eq!(list_params(&ResourceFilter::default(), 0, 0).limit, Some(1));
    }

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

    /// A create whose name is blank is refused before any client is touched.
    #[test]
    fn a_blank_context_name_is_refused() {
        assert!(super::trimmed_context_name("   ").is_err());
        assert_eq!(
            super::trimmed_context_name("  temper-desktop ").unwrap(),
            "temper-desktop"
        );
    }

    /// Witness for the context-create write the setup flow stands on: creates a
    /// witness-named, profile-owned context against the real API, finds it among
    /// the person's visible contexts owned by the same `@<handle>`, and retires
    /// it. Ignored by default — needs the machine's temper credentials and network.
    /// Run locally: `cargo test -p desktop -- --ignored context_create_round_trip`
    #[tokio::test]
    #[ignore = "requires temper credentials and network"]
    async fn context_create_round_trip() {
        let state = super::TemperState::connect();
        let client = state
            .client
            .expect("machine temper credentials should resolve to a client");

        let name = format!("desktop-witness-{}", uuid::Uuid::new_v4().simple());
        let created = client
            .contexts()
            .create(&name, None)
            .await
            .expect("create a profile-owned context");
        assert!(
            created.owner_ref.starts_with('@'),
            "a profile-owned context is owned by @<handle>, got {}",
            created.owner_ref
        );

        let listed = client.contexts().list().await.expect("list contexts");
        assert!(
            listed
                .iter()
                .any(|c| c.name == name && c.owner_ref == created.owner_ref),
            "the created context is visible to its owner after creation"
        );

        client
            .contexts()
            .delete(created.id.0)
            .await
            .expect("retire the witness context");
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

    /// Witness for the three temper reads the views stand on: teams, contexts,
    /// and one page of recent work against the real API. Ignored by default —
    /// it needs the machine's temper credentials and network.
    /// Run locally: `cargo test -p desktop -- --ignored temper_reads_round_trip`
    #[tokio::test]
    #[ignore = "requires temper credentials and network"]
    async fn temper_reads_round_trip() {
        let state = super::TemperState::connect();
        let client = state
            .client
            .expect("machine temper credentials should resolve to a client");

        let teams = client.teams().list().await.expect("teams list");
        let contexts = client.contexts().list().await.expect("contexts list");
        for context in &contexts {
            assert!(!context.slug.is_empty(), "every visible context has a slug");
            assert!(
                !context.owner_ref.is_empty(),
                "every visible context has an owner ref"
            );
        }

        let params = temper_workflow::types::resource::ResourceListParams {
            sort: Some(temper_workflow::types::resource::ResourceSortField::Updated),
            order: Some(temper_workflow::types::resource::SortOrder::Desc),
            limit: Some(5),
            offset: Some(0),
            ..Default::default()
        };
        let page = client
            .resources()
            .list_meta(&params)
            .await
            .expect("recent work");
        assert!(page.total >= 0);
        for row in &page.rows {
            assert!(!row.title.is_empty(), "a recent row names its resource");
            assert!(
                !row.r#ref.is_empty(),
                "a recent row carries its decorated address"
            );
        }
        let _ = teams; // presence of the teams read is the assertion: it answered
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
