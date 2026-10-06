// Package names on crates.io are `temperkb-*`; their lib names are `temper_*`.
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use temper_client::auth::{auth_status, AuthStatus};
use temper_client::config::{api_url, build_client, load_cloud_config};
use temper_client::error::ClientError;
use temper_client::login::{login, OAuthConfig};
use temper_client::TemperClient;
use temper_core::types::config::global_config_path;
use temper_workflow::operations::Surface;
use temper_workflow::types::resource::{ResourceListParams, ResourceSortField, SortOrder};

use crate::auth_store;

/// The temper connection held by the Rust core.
///
/// The desktop is its own OAuth client: it signs in through the provider
/// entry the connection room writes — its own `desktop_client_id`, never the
/// CLI's — and keeps the credential in its own store ([`auth_store`]: the
/// keychain, or the `TEMPER_DESKTOP_AUTH_STORE` file in dev and witness
/// runs). The CLI's `auth.json` is never read or written here. The client is
/// built on that store at startup and rebuilt when sign-in or sign-out
/// lands, so the managed state follows without an app restart.
pub struct TemperState {
    /// The connected client, when the machine's config and credential
    /// resolved to one. Behind a lock because sign-in and sign-out swap it
    /// while the app runs; the lock is never held across an await.
    client: Mutex<Option<Arc<TemperClient>>>,
    connect_error: Mutex<Option<String>>,
    /// The deployed server's address, as the machine's config resolved it —
    /// the one temper-shaped URL shape a rendered markdown link intercepts
    /// into a tab. None when the machine has no configured server.
    server_url: Option<String>,
}

impl TemperState {
    pub fn connect() -> Self {
        let server_url = load_cloud_config()
            .ok()
            .map(|config| api_url(&config))
            .filter(|url| !url.trim().is_empty());
        let mut state = Self {
            client: Mutex::new(None),
            connect_error: Mutex::new(None),
            server_url,
        };
        // The constructor owns the state exclusively: plain mutable access,
        // no lock discipline needed.
        match Self::try_connect() {
            Ok(client) => {
                *state.client.get_mut().expect("temper client lock") = Some(Arc::new(client))
            }
            Err(err) => {
                *state.connect_error.get_mut().expect("temper error lock") = Some(err);
            }
        }
        state
    }

    /// The connected client, when the machine's credentials resolved to one.
    /// A clone of the shared handle, so a concurrent sign-in or sign-out
    /// cannot pull it out from under a command mid-read.
    pub fn client(&self) -> Option<Arc<TemperClient>> {
        self.client.lock().expect("temper client lock").clone()
    }

    fn connect_error(&self) -> Option<String> {
        self.connect_error
            .lock()
            .expect("temper error lock")
            .clone()
    }

    /// Whether the desktop holds a live temper session: a client built on
    /// the machine's config, and a credential in the desktop's own store
    /// that `auth_status` calls a session — an expired credential is not
    /// one. The store is consulted fresh on every ask, so a sign-out or a
    /// landed refresh is reflected without rebuilding anything.
    fn is_connected(&self) -> bool {
        self.client().is_some()
            && session_status()
                .map(|status| status.authenticated)
                .unwrap_or(false)
    }

    /// Signs the person in through the desktop's own OAuth client and store,
    /// then installs the rebuilt client — the managed state follows without
    /// an app restart.
    async fn sign_in(&self) -> Result<Arc<TemperClient>, String> {
        let client = Arc::new(sign_in_client_at(&global_config_path()).await?);
        *self.client.lock().expect("temper client lock") = Some(client.clone());
        *self.connect_error.lock().expect("temper error lock") = None;
        Ok(client)
    }

    /// Ends the desktop's custody: the credential leaves the desktop's store
    /// (idempotent, the same clear the store gives an already-absent entry)
    /// and the state drops its client.
    fn sign_out(&self) -> Result<(), String> {
        let store = auth_store::desktop_token_store().map_err(|e| e.to_string())?;
        store.clear().map_err(|e| e.to_string())?;
        *self.client.lock().expect("temper client lock") = None;
        Ok(())
    }

    fn try_connect() -> Result<TemperClient, String> {
        let store = auth_store::desktop_token_store().map_err(|e| e.to_string())?;
        build_client(store, Surface::Sdk).map_err(|e| e.to_string())
    }
}

/// The store's own word on the desktop's credential, through
/// `temper_client::auth::auth_status` — display-safe by construction, so no
/// token value can cross it. `None` when the store itself could not answer.
fn session_status() -> Option<AuthStatus> {
    let store = auth_store::desktop_token_store().ok()?;
    auth_status(store.as_ref()).ok()
}

/// The sign-in flow's core, parameterised by the config path the way
/// [`crate::connection::gather_from_path`] is. Resolves the active provider
/// entry the client's own `oauth_config` resolves; refuses — before anything
/// opens a browser — when that entry registers no desktop client; then runs
/// the published [`login`] against the desktop's own store and rebuilds the
/// client on the store that now holds the fresh credential.
///
/// The `client_id` the flow authenticates with is the entry's
/// `desktop_client_id` — the desktop's own registered OAuth client. There is
/// no fallback to the entry's `client_id`: that client's registered redirect
/// belongs to the CLI, which this app does not share.
async fn sign_in_client_at(path: &Path) -> Result<TemperClient, String> {
    let gathered = crate::connection::gather_from_path(path)?;
    let provider = gathered.provider.ok_or_else(|| {
        "no temper provider is configured — connect to a server first".to_string()
    })?;
    // The connection room's one-line refusal, before anything opens a
    // browser. Past this check the entry provably registers a desktop
    // client: `sign_in_refusal` is `None` exactly when it does.
    if let Some(refusal) = gathered.sign_in_refusal {
        return Err(refusal);
    }
    let client_id = provider
        .desktop_client_id
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            "the provider entry carries no desktop_client_id — the desktop never signs in \
             with another surface's client"
                .to_string()
        })?;
    // The same entry→config mapping the client's own `oauth_config` performs
    // for the CLI, with the desktop's own client id in place of the CLI's.
    let oauth = OAuthConfig {
        authorize_url: provider.authorize_url,
        token_url: provider.token_url,
        client_id,
        audience: Some(provider.audience),
        callback_url: provider.callback_url,
        scopes: provider.scopes,
    };
    let store = auth_store::desktop_token_store().map_err(|e| e.to_string())?;
    // The published flow opens the browser, waits for the callback, exchanges
    // the code, and saves through the store it was handed — the desktop's
    // custody from the first write. The stored credential itself never
    // crosses to the webview; the reply carries the profile facts only.
    let _stored = login(&oauth, store.as_ref())
        .await
        .map_err(|e| e.to_string())?;
    build_client(store, Surface::Sdk).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    connected: bool,
    error: Option<String>,
    /// The deployed server's address, as the machine's config resolved it —
    /// the one temper-shaped URL shape a rendered markdown link intercepts
    /// into a tab. None when the machine has no configured server.
    server_url: Option<String>,
}

#[tauri::command]
pub fn temper_connection_status(state: tauri::State<TemperState>) -> ConnectionStatus {
    ConnectionStatus {
        // The store's word, not the client object's: a built client with an
        // expired or absent credential is no session. An expired credential
        // is not a session — the same rule `auth status` renders.
        connected: state.is_connected(),
        error: state.connect_error(),
        server_url: state.server_url.clone(),
    }
}

/// Signs the person in: opens the browser through the published login flow
/// against the desktop's own OAuth client and store, then answers with the
/// signed-in profile — the facts `temper_whoami` renders. The credential
/// itself never crosses this boundary: `StoredAuth` serializes its secrets,
/// so it is dropped here and only the profile is serialized.
#[tauri::command]
pub async fn temper_signin(
    state: tauri::State<'_, TemperState>,
) -> Result<serde_json::Value, String> {
    let client = state.sign_in().await?;
    let profile = client.profile().get().await.map_err(|e| e.to_string())?;
    serde_json::to_value(profile).map_err(|e| e.to_string())
}

/// Signs out: the desktop's custody of the temper credential ends — the
/// store is cleared and the connection state drops its client without an
/// app restart.
#[tauri::command]
pub fn temper_signout(state: tauri::State<TemperState>) -> Result<(), String> {
    state.sign_out()
}

/// Fetches the signed-in person's profile through the temper API.
#[tauri::command]
pub async fn temper_whoami(
    state: tauri::State<'_, TemperState>,
) -> Result<serde_json::Value, String> {
    let client = state
        .client()
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

fn temper_client(state: &tauri::State<'_, TemperState>) -> Result<Arc<TemperClient>, String> {
    state
        .client()
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
    /// Whose resources: `@me` for the person's own, or a profile handle.
    pub owner: Option<String>,
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
        owner: given(&filter.owner),
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

/// How many of a context's regions a shape read answers with: the most salient
/// first, and `population` says how many there are.
pub const SHAPE_REGIONS_MAX: usize = 8;

/// One region, as home's Explore shows it: temper's label when a region has one
/// (none is invented), and how many members this person can read.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegionView {
    pub label: Option<String>,
    pub members: i32,
}

/// A context's shape, bounded: its most salient regions, how many it has in all
/// that this person can see, and — when there are none — why, in temper's words
/// (`never_clustered`, `nothing_visible`, `lens_narrowed`, `unreadable_or_absent`).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextShapeView {
    pub regions: Vec<RegionView>,
    pub population: i32,
    pub emptiness: Option<String>,
    /// RFC 3339; absent when never clustered, or not readable.
    pub materialized_at: Option<String>,
}

/// Projects a shape read to what Explore shows: salience order kept, bounded.
pub fn shape_view(shape: temper_core::types::cognitive_maps::AnchorShape) -> ContextShapeView {
    ContextShapeView {
        regions: shape
            .regions
            .into_iter()
            .take(SHAPE_REGIONS_MAX)
            .map(|r| RegionView {
                label: r.label.filter(|l| !l.trim().is_empty()),
                members: r.member_count,
            })
            .collect(),
        population: shape.population,
        emptiness: shape.emptiness.and_then(|e| {
            serde_json::to_value(e)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
        }),
        materialized_at: shape.materialized_at.map(|t| t.to_rfc3339()),
    }
}

/// A context's materialized regions, most salient first and bounded — the
/// orientation home's Explore gives without folders.
#[tauri::command]
pub async fn temper_context_shape(
    state: tauri::State<'_, TemperState>,
    context_id: String,
) -> Result<ContextShapeView, String> {
    let id = uuid::Uuid::parse_str(context_id.trim())
        .map_err(|_| format!("{context_id} is not a context id"))?;
    let shape = temper_client(&state)?
        .contexts()
        .shape(id, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(shape_view(shape))
}

/// Resolves references for display: title, doc type and home, read from temper. The webview
/// never shows a title an author typed as if it were the resource's own.
#[tauri::command]
pub async fn temper_resolve_refs(
    state: tauri::State<'_, TemperState>,
    ids: Vec<String>,
) -> Result<Vec<RefResolution>, String> {
    let client = state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let mut out = Vec::with_capacity(ids.len());
    for raw in ids {
        out.push(resolve_one(&client, raw).await);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        list_params, parse_ref, session_status, shape_view, sign_in_client_at, ResourceFilter,
        TemperState, LIST_PAGE_MAX, SHAPE_REGIONS_MAX,
    };
    use crate::auth_store::{desktop_token_store, AUTH_STORE_ENV};
    use crate::witness_env::{cleared, ScopedEnv, ENV_SERIAL};
    use temper_client::auth::{
        needs_refresh, refresh_token, resolve_auth_path, DiskTokenStore, StoredAuth, TokenStore,
    };
    use temper_workflow::types::resource::{ResourceSortField, SortOrder};

    #[test]
    fn a_filter_reads_as_newest_first_and_bounded() {
        let filter = ResourceFilter {
            doc_type: Some("task".into()),
            stage: Some("in-progress".into()),
            status: Some("  ".into()),
            context_ref: None,
            owner: None,
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

    /// The person's own resources: `@me` reaches the list read as the owner.
    #[test]
    fn an_owner_filter_is_passed_through() {
        let filter = ResourceFilter {
            doc_type: Some("session".into()),
            owner: Some("@me".into()),
            ..Default::default()
        };
        let params = list_params(&filter, 1, 0);
        assert_eq!(params.owner.as_deref(), Some("@me"));
        assert_eq!(params.doc_type_name.as_deref(), Some("session"));
    }

    fn region(
        label: Option<&str>,
        members: i32,
    ) -> temper_core::types::cognitive_maps::CogmapRegionRow {
        serde_json::from_value(serde_json::json!({
            "region_id": uuid::Uuid::new_v4(),
            "lens_id": uuid::Uuid::new_v4(),
            "salience": 0.5,
            "content_cohesion": null,
            "label": label,
            "member_count": members,
        }))
        .expect("a region row")
    }

    /// A shape is bounded, keeps its salience order, and says how many regions
    /// there are in all; an empty label is no label.
    #[test]
    fn a_shape_is_bounded_and_keeps_its_order() {
        use temper_core::types::cognitive_maps::AnchorShape;
        let mut regions: Vec<_> = (0..12)
            .map(|i| region(Some(&format!("region {i}")), 10 - i))
            .collect();
        regions[1] = region(Some("  "), 9);
        let view = shape_view(AnchorShape {
            regions,
            population: 12,
            emptiness: None,
            materialized_at: None,
        });
        assert_eq!(view.regions.len(), SHAPE_REGIONS_MAX);
        assert_eq!(view.population, 12);
        assert_eq!(view.regions[0].label.as_deref(), Some("region 0"));
        assert_eq!(view.regions[1].label, None, "a blank label is no label");
        assert_eq!(view.emptiness, None);
    }

    /// An empty shape says why, in temper's own words.
    #[test]
    fn an_empty_shape_says_why() {
        use temper_core::types::cognitive_maps::{AnchorShape, ShapeEmptiness};
        let view = shape_view(AnchorShape {
            regions: vec![],
            population: 0,
            emptiness: Some(ShapeEmptiness::NeverClustered),
            materialized_at: None,
        });
        assert_eq!(view.emptiness.as_deref(), Some("never_clustered"));
        assert!(view.regions.is_empty());
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
            .client()
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
            .client()
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
            .client()
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

        // A visible context's shape answers, bounded, and an empty one says why.
        if let Some(context) = contexts.first() {
            let view = shape_view(
                client
                    .contexts()
                    .shape(context.id.0, None)
                    .await
                    .expect("context shape"),
            );
            assert!(view.regions.len() <= SHAPE_REGIONS_MAX);
            assert!(view.population as usize >= view.regions.len());
            if view.regions.is_empty() {
                assert!(view.emptiness.is_some(), "an empty shape says why");
            }
        }
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
            .client()
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

    // ─── Witnesses: native sign-in custody and the sign-in seams ───────────
    //
    // Everything here runs under a synthetic deployment: the CLI's config is
    // relocated by `TEMPER_GLOBAL_CONFIG` (honored by `global_config_path`,
    // temper-core config.rs:487-496) and the desktop's store by
    // `TEMPER_DESKTOP_AUTH_STORE`, both pointed inside a scratch root — the
    // person's real keychain and `~/.config/temper` are never read or
    // written. Every witness holds the shared env serial for its body.

    /// The expiry instants the fixtures live at, as RFC 3339: long past, far
    /// future, and inside the five-minute refresh window.
    const PAST: &str = "2020-01-01T00:00:00Z";
    const LIVE: &str = "2100-01-01T00:00:00Z";

    /// A `StoredAuth` fixture, built through its own serde impls — token
    /// strings enter and leave as JSON, never hand-handled.
    fn stored_auth(access_token: &str, expires_at: &str) -> StoredAuth {
        serde_json::from_value(serde_json::json!({
            "provider": { "kind": "auth0", "domain": "witness.invalid" },
            "access_token": access_token,
            "refresh_token": "witness-refresh-token",
            "expires_at": expires_at,
            "profile_id": null,
            "device_id": "01900000-0000-7000-8000-000000000000",
        }))
        .expect("a StoredAuth fixture")
    }

    /// The credential as its serde impls restate it, so equality is the
    /// stored shape's equality and token strings never leave JSON.
    fn stored_json(auth: &StoredAuth) -> serde_json::Value {
        serde_json::to_value(auth).expect("StoredAuth serializes")
    }

    /// A witness deployment: a synthetic config root whose `[auth]` carries
    /// one provider entry and pins the CLI's auth file INSIDE the root, so
    /// every path a witness touches is scratch. `desktop_client` is the
    /// entry's `desktop_client_id` — `None` is the unregistered deployment
    /// the sign-in refusal names.
    struct WitnessDeployment {
        root: PathBuf,
        config_path: PathBuf,
        cli_auth_path: PathBuf,
        desktop_auth_path: PathBuf,
    }

    impl WitnessDeployment {
        fn write(name: &str, desktop_client: Option<&str>, callback_url: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("desktop-signin-{name}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).expect("the witness root creates");
            let cli_auth_path = root.join("cli-auth.json");
            let desktop_auth_path = root.join("desktop-auth.json");
            let config_path = root.join("config.toml");
            let desktop_client_line = match desktop_client {
                Some(id) => format!("desktop_client_id = \"{id}\"\n"),
                None => String::new(),
            };
            std::fs::write(
                &config_path,
                format!(
                    "[vault]\npath = \"{}/vault\"\n\n\
                     [cloud]\napi_url = \"https://witness.invalid\"\n\n\
                     [auth]\nprovider = \"auth0\"\npath = \"{}\"\n\n\
                     [[auth.providers]]\n\
                     name = \"auth0\"\n\
                     authorize_url = \"https://witness.us.auth0.com/authorize\"\n\
                     token_url = \"https://witness.us.auth0.com/oauth/token\"\n\
                     client_id = \"witness-cli-client\"\n\
                     audience = \"https://witness.invalid/api\"\n\
                     callback_url = \"{callback_url}\"\n\
                     scopes = [\"openid\", \"profile\", \"email\", \"offline_access\"]\n\
                     {desktop_client_line}",
                    root.display(),
                    cli_auth_path.display()
                ),
            )
            .expect("the witness config writes");
            Self {
                root,
                config_path,
                cli_auth_path,
                desktop_auth_path,
            }
        }

        /// The env a witness body runs under: the CLI's config relocated to
        /// the synthetic root, the desktop's store on the override file, and
        /// the CLI's auth-path and env-token variables out of the picture.
        fn scoped_env(&self) -> Vec<ScopedEnv> {
            let mut env = vec![
                ScopedEnv::set("TEMPER_GLOBAL_CONFIG", self.config_path.to_str().unwrap()),
                ScopedEnv::set(AUTH_STORE_ENV, self.desktop_auth_path.to_str().unwrap()),
            ];
            env.extend(cleared(&["TEMPER_AUTH_PATH", "TEMPER_TOKEN"]));
            env
        }

        fn cleanup(&self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }

    /// WITNESS (custody, absent arm): the desktop's store writes only its own
    /// file. The bite is executed first — `DiskTokenStore::default_path()`,
    /// the store the connect seam used before the U1 amendment
    /// (`temper.rs`'s old `try_connect`), resolves to exactly the CLI's
    /// `auth.json` under these envs and saving through it writes that file.
    /// The desktop's store, on the same envs, leaves it absent through a
    /// full sign-in's save and sign-out's clear.
    #[test]
    fn the_desktops_store_never_touches_the_cli_auth_file() {
        let _order = ENV_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dep = WitnessDeployment::write(
            "custody-absent",
            Some("witness-desktop-client"),
            "https://witness.invalid/api/auth/cli-callback",
        );
        let _env = dep.scoped_env();

        // The file the CLI resolves is the one the synthetic config pinned —
        // refuse loudly rather than run against the person's real files.
        let watched = resolve_auth_path();
        assert_eq!(
            watched, dep.cli_auth_path,
            "the witness's CLI auth path is the synthetic config's pin, not the person's real file"
        );
        assert!(!watched.exists(), "precondition: nothing written yet");

        // THE BITE: the removed code path's write target IS the CLI's auth
        // file. `DiskTokenStore::default_path` resolves through
        // `resolve_auth_path` (auth.rs:85-89), and its save is the
        // `save_auth_to` helper (auth.rs:73-75) — had the desktop kept it,
        // the login flow's `replace_grant` would have landed right here.
        let old_store = DiskTokenStore::default_path();
        old_store
            .save(&stored_auth("would-have-landed-here", LIVE))
            .expect("the old store saves");
        assert!(
            watched.exists(),
            "the bite: DiskTokenStore::default_path() writes exactly the CLI's auth.json"
        );
        std::fs::remove_file(&watched).expect("the bite's file is scratch; restore absence");

        // GREEN: the desktop's own store, same envs, same operations a real
        // sign-in (login saves through the store it was handed,
        // login.rs:156) and sign-out (store.clear) perform.
        let store = desktop_token_store().expect("the override env selects the file-backed store");
        store
            .save(&stored_auth("desktop-token", LIVE))
            .expect("the sign-in's save lands");
        assert!(
            !watched.exists(),
            "a desktop sign-in's save left the CLI's auth.json absent"
        );
        assert!(
            dep.desktop_auth_path.exists(),
            "the desktop's own file holds it"
        );
        let loaded = store
            .load()
            .expect("the override file reads back")
            .expect("the credential is there");
        assert_eq!(
            stored_json(&loaded)["access_token"],
            "desktop-token",
            "what the desktop stored is what it loads"
        );

        store.clear().expect("the sign-out's clear lands");
        assert!(
            !dep.desktop_auth_path.exists(),
            "the clear empties the desktop's own file"
        );
        assert!(
            !watched.exists(),
            "and the CLI's auth.json is still absent — never written"
        );
        dep.cleanup();
    }

    /// WITNESS (custody, byte-identical arm): a person who signed in through
    /// the CLI carries an existing `auth.json`. The desktop's store neither
    /// reads it (the old `build_client` path would have — its first act was
    /// `store.load()`) nor alters it through a full save-and-clear cycle:
    /// the bytes before and after are identical.
    #[test]
    fn an_existing_cli_auth_file_survives_the_desktops_store_byte_identical() {
        let _order = ENV_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dep = WitnessDeployment::write(
            "custody-existing",
            Some("witness-desktop-client"),
            "https://witness.invalid/api/auth/cli-callback",
        );
        let _env = dep.scoped_env();

        let watched = resolve_auth_path();
        assert_eq!(
            watched, dep.cli_auth_path,
            "the witness's CLI auth path is the synthetic config's pin, not the person's real file"
        );
        // A plausible CLI grant the person signed for with `temper auth login`.
        let cli_grant = stored_auth("the-cli-token", LIVE);
        let cli_bytes = serde_json::to_string_pretty(&cli_grant).expect("the CLI grant writes");
        std::fs::write(&watched, &cli_bytes).expect("pre-write the CLI's auth.json");

        let store = desktop_token_store().expect("the override env selects the file-backed store");
        assert!(
            matches!(store.load(), Ok(None)),
            "the desktop's store does not read the CLI's auth.json — native custody reads its own file only"
        );

        store
            .save(&stored_auth("desktop-token", LIVE))
            .expect("the sign-in's save lands");
        store.clear().expect("the sign-out's clear lands");
        assert_eq!(
            std::fs::read(&watched).expect("the CLI's auth.json survives"),
            cli_bytes.as_bytes(),
            "byte-identical after a full desktop sign-in/sign-out cycle"
        );
        dep.cleanup();
    }

    /// WITNESS (sign-out): the command's own path — seed the desktop's store
    /// with a live grant (the post-sign-in state), connect, sign out. The
    /// desktop's file is gone, the CLI's auth.json was never written, and
    /// the managed state follows without a restart.
    #[test]
    fn sign_out_ends_the_desktops_custody_without_a_restart() {
        let _order = ENV_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dep = WitnessDeployment::write(
            "signout",
            Some("witness-desktop-client"),
            "https://witness.invalid/api/auth/cli-callback",
        );
        let _env = dep.scoped_env();

        let store = desktop_token_store().expect("the override env selects the file-backed store");
        store
            .save(&stored_auth("live-desktop-token", LIVE))
            .expect("seed the post-sign-in grant");
        let state = TemperState::connect();
        assert!(
            state.is_connected(),
            "a live desktop credential is a session"
        );
        assert!(state.client().is_some(), "the client is built on the grant");
        assert!(
            !resolve_auth_path().exists(),
            "precondition: the CLI's auth.json is absent"
        );

        state.sign_out().expect("sign out");

        assert!(
            !dep.desktop_auth_path.exists(),
            "the desktop's credential is gone — custody ended"
        );
        assert!(
            !resolve_auth_path().exists(),
            "sign-out never wrote the CLI's auth.json"
        );
        assert!(
            !state.is_connected(),
            "the managed state follows the sign-out"
        );
        assert!(state.client().is_none(), "the state dropped its client");
        dep.cleanup();
    }

    /// WITNESS (the unregistered refusal): a deployment that registered no
    /// desktop client refuses sign-in with the connection room's one line —
    /// produced before [`login`] is even entered, so no browser can open.
    /// The CLI's client id is never a stand-in.
    //
    // The env serial guard spans the awaits deliberately: it relocates the
    // stores for the whole body, and nothing inside the awaited code takes
    // it, so no other task can be waiting on it.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn an_unregistered_client_refuses_sign_in_before_any_browser() {
        let _order = ENV_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dep = WitnessDeployment::write(
            "unregistered",
            None,
            "https://witness.invalid/api/auth/cli-callback",
        );
        let _env = dep.scoped_env();

        let err = sign_in_client_at(&dep.config_path)
            .await
            .expect_err("an unregistered deployment refuses");
        assert!(
            err.contains("desktop_client_id"),
            "the refusal names the field the registration belongs in: {err}"
        );
        assert!(
            !err.contains("witness-cli-client"),
            "the CLI's client id never appears: {err}"
        );
        assert!(
            !err.contains("browser") && !err.contains("timed out"),
            "the refusal is the connection's line, not the flow's — nothing opened: {err}"
        );
        dep.cleanup();
    }

    /// WITNESS (the published empty-callback refusal): the desktop's
    /// OAuthConfig plumbing preserves the flow's own regression guard — a
    /// provider entry whose callback never resolved refuses with the same
    /// actionable `temper init` line the CLI renders (login.rs:86-90, its
    /// regression test at :353-376), before any browser opens.
    //
    // The env serial guard spans the awaits deliberately: it relocates the
    // stores for the whole body, and nothing inside the awaited code takes
    // it, so no other task can be waiting on it.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn an_empty_callback_refuses_with_the_published_line() {
        let _order = ENV_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dep = WitnessDeployment::write("empty-callback", Some("witness-desktop-client"), "");
        let _env = dep.scoped_env();

        let err = sign_in_client_at(&dep.config_path)
            .await
            .expect_err("an empty callback refuses");
        assert!(
            err.contains("callback URL"),
            "the published line names the unconfigured callback: {err}"
        );
        assert!(
            err.contains("temper init"),
            "the published line names the fix: {err}"
        );
        dep.cleanup();
    }

    /// A local OAuth token endpoint: answers every grant with a fresh,
    /// rotated pair. The refresh witness points `refresh_token` at it.
    async fn token_stub() -> (String, tokio::task::JoinHandle<()>) {
        use axum::routing::post;
        use axum::{Json, Router};
        async fn grant() -> Json<serde_json::Value> {
            Json(serde_json::json!({
                "access_token": "refreshed-access-token",
                "refresh_token": "rotated-refresh-token",
                "expires_in": 3600,
            }))
        }
        let app = Router::new().route("/oauth/token", post(grant));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the stub binds loopback");
        let addr = listener.local_addr().expect("the stub's address");
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}/oauth/token"), handle)
    }

    /// WITNESS (refresh): the published refresh chain runs through the
    /// desktop's own store — `needs_refresh` inside its window,
    /// `refresh_token` posting the grant, and the response landing via the
    /// store's `save` (auth.rs:881) in the override file. A fresh handle on
    /// the same custody reads the rotated grant back.
    //
    // The env serial guard spans the awaits deliberately: it relocates the
    // stores for the whole body, and nothing inside the awaited code takes
    // it, so no other task can be waiting on it.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_refresh_lands_in_the_desktops_store() {
        let (token_url, stub) = token_stub().await;
        let _order = ENV_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dep = WitnessDeployment::write(
            "refresh",
            Some("witness-desktop-client"),
            "https://witness.invalid/api/auth/cli-callback",
        );
        let _env = dep.scoped_env();

        let store = desktop_token_store().expect("the override env selects the file-backed store");
        let soon = (chrono::Utc::now() + chrono::Duration::seconds(30)).to_rfc3339();
        store
            .save(&stored_auth("soon-stale-token", &soon))
            .expect("seed a grant inside the refresh window");
        let auth = store
            .load()
            .expect("the grant reads back")
            .expect("the credential is there");
        assert!(
            needs_refresh(&auth),
            "a grant inside the five-minute window needs refresh (auth.rs:795-797)"
        );

        let refreshed = refresh_token(store.as_ref(), &auth, &token_url, "witness-desktop-client")
            .await
            .expect("the refresh grant completes");

        let reloaded = desktop_token_store()
            .expect("a fresh handle on the same custody")
            .load()
            .expect("the refreshed grant reads back")
            .expect("the credential is there");
        let json = stored_json(&reloaded);
        assert_eq!(
            json["access_token"], "refreshed-access-token",
            "the refresh landed in the desktop's store"
        );
        assert_eq!(
            json["refresh_token"], "rotated-refresh-token",
            "rotation: the response's refresh token wins (auth.rs:872-875)"
        );
        assert!(
            reloaded.expires_at > auth.expires_at,
            "the refreshed grant expires later than the stale one"
        );
        assert_eq!(
            stored_json(&refreshed)["access_token"],
            json["access_token"],
            "the grant refresh_token returned is the grant the store holds"
        );
        stub.abort();
        dep.cleanup();
    }

    /// WITNESS (the status surface): `auth_status`'s line — an expired
    /// credential is not a session (auth.rs:612-617) — holds for the
    /// desktop's status. The store is consulted fresh on every ask, so a
    /// landed re-sign-in is a session and a sign-out is not, without
    /// rebuilding the state.
    #[test]
    fn an_expired_credential_is_not_a_session_for_the_desktop() {
        let _order = ENV_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dep = WitnessDeployment::write(
            "status",
            Some("witness-desktop-client"),
            "https://witness.invalid/api/auth/cli-callback",
        );
        let _env = dep.scoped_env();

        let store = desktop_token_store().expect("the override env selects the file-backed store");
        store
            .save(&stored_auth("expired-token", PAST))
            .expect("seed an expired grant");
        let state = TemperState::connect();

        let status = session_status().expect("the store answers");
        assert!(
            !status.authenticated,
            "an expired credential is not a session"
        );
        assert_eq!(
            status.expires_at,
            Some(
                chrono::DateTime::parse_from_rfc3339(PAST)
                    .expect("the fixture's expiry")
                    .with_timezone(&chrono::Utc)
            ),
            "the expired status explains itself with its expiry"
        );
        assert!(
            !state.is_connected(),
            "the desktop's status holds the same line"
        );

        store
            .save(&stored_auth("fresh-token", LIVE))
            .expect("a re-sign-in's grant");
        assert!(
            state.is_connected(),
            "a live grant in the same store is a session — the status answers from the store"
        );

        store.clear().expect("sign out");
        assert!(
            !session_status().expect("the store answers").authenticated,
            "absence is not a session"
        );
        assert!(!state.is_connected());
        dep.cleanup();
    }
}
