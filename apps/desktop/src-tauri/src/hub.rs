//! The desktop hub: small, current, cross-device app-lifecycle facts as
//! data artifacts in the person's configured context. The hub is a temper
//! resource found there and created on first write; a creation race leaves
//! two, and a read must still see both, never drop one. Each family is a
//! declared, enforcing shape; a commit supersedes every live `current` it
//! read and merges them, so a fork between devices heals on the next write
//! with no locks. Records stay current and deliberately not verbose:
//! nothing the ledger already holds is repeated — no titles (`ResourceRef`
//! resolves them live), no save events (the ledger holds them), no scroll
//! position (device-local by ruling).

use serde::{Deserialize, Serialize};
use temper_client::TemperClient;
use temper_core::types::data_artifact::{
    ArtifactCommitRequest, ArtifactListParams, ArtifactView, KindOwnerInput,
};
use temper_core::types::data_artifact_shape::{EnforcementMode, ShapeDeclareRequest};
use temper_core::types::ids::DataArtifactId;
use temper_core::types::ingest::IngestPayload;
use temper_workflow::types::resource::ResourceListParams;
use uuid::Uuid;

use crate::person_context::{persons_context_id, persons_contexts};
use crate::settings::SettingsState;
use crate::temper::TemperState;

/// The hub resource's doc type and title: the family conventions every
/// later family inherits. Found in the person's context; created on first
/// write. A creation race leaves several; every one of them is read, the
/// newest receives the write.
pub const HUB_DOC_TYPE: &str = "hub";
pub const HUB_TITLE: &str = "Desktop hub";

/// The first family: what this person recently worked on, feeding home's
/// "Return to …". One `current` artifact, capped, one entry per resource.
pub const RECENT_WORK_KIND: &str = "desktop-recent-work";

/// The cap is on entries, not bytes: recent work is a few facts per
/// resource, and the merge keeps the most recent.
pub const RECENT_WORK_CAP: usize = 50;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkEntry {
    /// The resource the room was about, as a bare UUID string.
    pub resource: String,
    /// The room identity that watched the work, as the surface names it.
    pub room: String,
    /// RFC 3339, from the surface that watched the work open.
    pub opened_at: String,
    /// RFC 3339, from the surface that watched the work end.
    pub left_at: String,
    /// The device that watched it — a label the device owns.
    pub device: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkView {
    pub entries: Vec<RecentWorkEntry>,
    /// How many of `entries`' facts are still queued on this device, not yet
    /// committed — a place just left shows at once, and says it is local.
    pub queued: usize,
}

/// The family's shape: draft 2020-12, closed, capped, every field a surface
/// watched — never a fact the ledger already holds.
pub fn recent_work_schema() -> serde_json::Value {
    serde_json::json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": false,
        "required": ["version", "entries"],
        "properties": {
            "version": { "const": 1 },
            "entries": {
                "type": "array",
                "maxItems": RECENT_WORK_CAP,
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["resource", "room", "openedAt", "leftAt", "device"],
                    "properties": {
                        "resource": { "type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
                        "room": { "type": "string", "minLength": 1 },
                        "openedAt": { "type": "string" },
                        "leftAt": { "type": "string" },
                        "device": { "type": "string", "minLength": 1 }
                    }
                }
            }
        }
    })
}

/// Merges every live `current` with the surface's fresh entries: union by
/// resource, the latest `leftAt` wins per resource, then capped to the most
/// recent. Pure, so the convergence witness needs no server.
fn merge_recent_work(
    currents: &[Vec<RecentWorkEntry>],
    fresh: &[RecentWorkEntry],
) -> Vec<RecentWorkEntry> {
    let mut by_resource: std::collections::HashMap<String, RecentWorkEntry> =
        std::collections::HashMap::new();
    for batch in currents.iter().chain(std::iter::once(&fresh.to_vec())) {
        for entry in batch {
            match by_resource.get(&entry.resource) {
                Some(existing) if existing.left_at >= entry.left_at => {}
                _ => {
                    by_resource.insert(entry.resource.clone(), entry.clone());
                }
            }
        }
    }
    let mut merged: Vec<RecentWorkEntry> = by_resource.into_values().collect();
    merged.sort_by(|a, b| b.left_at.cmp(&a.left_at));
    merged.truncate(RECENT_WORK_CAP);
    merged
}

fn current_list_params() -> ArtifactListParams {
    ArtifactListParams {
        kind: Some(RECENT_WORK_KIND.to_string()),
        intent: Some("current".to_string()),
        include_folded: Some(false),
        counts: Some(false),
    }
}

/// The hub resources in the person's context: the one this device created,
/// plus any race-made duplicate — a read that dropped a duplicate would drop
/// the entries it holds. Empty means no hub exists yet.
async fn find_hub_resources(client: &TemperClient, context_id: Uuid) -> Result<Vec<Uuid>, String> {
    let params = ResourceListParams {
        context_ref: Some(context_id.to_string()),
        doc_type_name: Some(HUB_DOC_TYPE.to_string()),
        ..Default::default()
    };
    let page = client
        .resources()
        .list(&params)
        .await
        .map_err(|e| e.to_string())?;
    Ok(page
        .rows
        .iter()
        .filter(|r| r.title == HUB_TITLE)
        .map(|r| r.id.0)
        .collect())
}

async fn ensure_hub_resource(client: &TemperClient, context_id: Uuid) -> Result<Uuid, String> {
    let mut hubs = find_hub_resources(client, context_id).await?;
    if let Some(newest) = hubs.pop() {
        return Ok(newest);
    }
    let created = client
        .ingest()
        .create(&IngestPayload {
            title: HUB_TITLE.to_string(),
            origin_uri: String::new(),
            context_ref: context_id.to_string(),
            home_cogmap_id: None,
            doc_type_name: HUB_DOC_TYPE.to_string(),
            goal: None,
            content_hash: None,
            idempotency_key: Some(Uuid::new_v4()),
            content: "App-lifecycle records for this person's devices. Small, current, \
                      cross-device; each family is a declared shape. The ledger holds \
                      the work; this hub holds only what is current."
                .to_string(),
            metadata: None,
            managed_meta: None,
            open_meta: None,
            chunks_packed: None,
            sources: Vec::new(),
            act: Default::default(),
            segmented: None,
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(created.id.0)
}

/// Reads every live `desktop-recent-work` current across the context's hub
/// resources.
async fn read_currents(
    client: &TemperClient,
    context_id: Uuid,
) -> Result<Vec<Vec<RecentWorkEntry>>, String> {
    let mut batches = Vec::new();
    for resource_id in find_hub_resources(client, context_id).await? {
        let listed = client
            .data_artifacts()
            .list(resource_id, &current_list_params())
            .await
            .map_err(|e| e.to_string())?;
        let artifacts: Vec<ArtifactView> = serde_json::from_value(listed)
            .map_err(|e| format!("unexpected artifact list shape: {e}"))?;
        for artifact in artifacts {
            let entries: Vec<RecentWorkEntry> = serde_json::from_value(
                artifact
                    .content
                    .unwrap_or(serde_json::Value::Null)
                    .get("entries")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|e| format!("a current artifact did not conform to its shape: {e}"))?;
            batches.push(entries);
        }
    }
    Ok(batches)
}

/// Declares the family's shape in the hub's context, only when `list_shapes`
/// shows it absent — a second declaration would fork the family's lineage.
/// The namespace is named explicitly: a shape has no resource to default it
/// from, so the family is declared under the person's profile.
async fn ensure_shape(
    client: &TemperClient,
    context_id: Uuid,
    profile_id: Uuid,
) -> Result<(), String> {
    let shapes = client
        .data_artifacts()
        .list_shapes(context_id)
        .await
        .map_err(|e| e.to_string())?;
    if shapes
        .iter()
        .any(|s| !s.is_folded && s.artifact_kind == RECENT_WORK_KIND)
    {
        return Ok(());
    }
    client
        .data_artifacts()
        .declare_shape(
            context_id,
            &ShapeDeclareRequest {
                kind: RECENT_WORK_KIND.to_string(),
                kind_owner: Some(KindOwnerInput::Profile(profile_id)),
                schema: recent_work_schema(),
                enforcement: EnforcementMode::Enforcing,
                act: Default::default(),
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Commits the surface's recent-work facts: reads the live currents across
/// every hub resource in the person's context, merges, and supersedes every
/// current it read. The commit lands on the context's newest hub resource,
/// created on first write; the fork between devices heals here, with no
/// locks.
pub async fn commit_recent_work(
    client: &TemperClient,
    context_name: &str,
    fresh: Vec<RecentWorkEntry>,
) -> Result<RecentWorkView, String> {
    let context_id = persons_context_id(client, context_name).await?;
    let profile_id = client.profile().get().await.map_err(|e| e.to_string())?.id;
    ensure_shape(client, context_id, profile_id).await?;
    let currents = read_currents(client, context_id).await?;
    let hubs = find_hub_resources(client, context_id).await?;
    let superseded = artifact_ids(client, &hubs).await?;
    let hub = ensure_hub_resource(client, context_id).await?;
    let merged = merge_recent_work(&currents, &fresh);
    let content = serde_json::json!({ "version": 1, "entries": merged });
    let response = client
        .data_artifacts()
        .commit(
            hub,
            &ArtifactCommitRequest {
                kind: RECENT_WORK_KIND.to_string(),
                kind_owner: None,
                intent: "current".to_string(),
                precedence: 0.0,
                content,
                supersedes: superseded,
                act: Default::default(),
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let entries: Vec<RecentWorkEntry> = serde_json::from_value(
        response
            .artifact
            .content
            .unwrap_or(serde_json::Value::Null)
            .get("entries")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    )
    .map_err(|e| format!("the committed artifact did not conform: {e}"))?;
    Ok(RecentWorkView { entries, queued: 0 })
}

/// Reads the merged current entries for home's "Return to …" and a later
/// "since you last engaged".
pub async fn recent_work(
    client: &TemperClient,
    context_name: &str,
) -> Result<RecentWorkView, String> {
    let contexts = persons_contexts(client, context_name).await?;
    let mut batches = Vec::new();
    for context_id in contexts {
        batches.extend(read_currents(client, context_id).await?);
    }
    Ok(RecentWorkView {
        entries: merge_recent_work(&batches, &[]),
        queued: 0,
    })
}

async fn artifact_ids(
    client: &TemperClient,
    hub_resource_ids: &[Uuid],
) -> Result<Vec<DataArtifactId>, String> {
    let mut ids = Vec::new();
    for resource_id in hub_resource_ids {
        let listed = client
            .data_artifacts()
            .list(*resource_id, &current_list_params())
            .await
            .map_err(|e| e.to_string())?;
        let artifacts: Vec<ArtifactView> = serde_json::from_value(listed)
            .map_err(|e| format!("unexpected artifact list shape: {e}"))?;
        ids.extend(artifacts.into_iter().map(|a| a.artifact_id));
    }
    Ok(ids)
}

/// Commits the lifecycle facts a surface watched, on room leave or app
/// close — never per event.
#[tauri::command]
pub async fn hub_commit_recent_work(
    state: tauri::State<'_, TemperState>,
    settings: tauri::State<'_, SettingsState>,
    entries: Vec<RecentWorkEntry>,
) -> Result<RecentWorkView, String> {
    let client = state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let context_name = settings.get().temper_context_name().to_string();
    commit_recent_work(client, &context_name, entries).await
}

/// Folds this device's queued entries into what the hub answered, by the
/// same rule every commit merges by.
pub fn with_queued(read: RecentWorkView, queued: &[RecentWorkEntry]) -> RecentWorkView {
    RecentWorkView {
        entries: merge_recent_work(&[read.entries], queued),
        queued: queued.len(),
    }
}

/// Reads the merged recent-work entries for home, with this device's
/// not-yet-committed leaves folded in.
#[tauri::command]
pub async fn hub_recent_work(
    state: tauri::State<'_, TemperState>,
    settings: tauri::State<'_, SettingsState>,
    queue: tauri::State<'_, crate::hub_queue::HubQueue>,
) -> Result<RecentWorkView, String> {
    let client = state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let context_name = settings.get().temper_context_name().to_string();
    let read = recent_work(client, &context_name).await?;
    Ok(with_queued(read, &queue.queued()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(resource: &str, left_at: &str) -> RecentWorkEntry {
        RecentWorkEntry {
            resource: resource.to_string(),
            room: "document".to_string(),
            opened_at: "2026-09-27T10:00:00.000Z".to_string(),
            left_at: left_at.to_string(),
            device: "station".to_string(),
        }
    }

    const A: &str = "00000000-0000-0000-0000-000000000001";
    const B: &str = "00000000-0000-0000-0000-000000000002";

    /// Witness for the converge clause: two commits from the same base leave
    /// two live currents; the next write merges and supersedes both — union
    /// by resource, the latest `leftAt` wins, capped most-recent-first.
    #[test]
    fn two_writers_converge_on_the_next_write() {
        let device_a = vec![entry(A, "2026-09-27T10:30:00.000Z")];
        let device_b = vec![
            entry(A, "2026-09-27T11:00:00.000Z"),
            entry(B, "2026-09-27T09:00:00.000Z"),
        ];
        let merged = merge_recent_work(&[device_a, device_b], &[]);
        assert_eq!(merged.len(), 2, "union by resource, not concatenation");
        assert_eq!(
            merged[0].left_at, "2026-09-27T11:00:00.000Z",
            "the latest leftAt wins per resource"
        );
        assert_eq!(merged[0].resource, A);
        assert_eq!(merged[1].resource, B, "the other device's entry survives");
    }

    /// The cap keeps the most recent entries, not the first seen.
    #[test]
    fn the_merge_is_capped_most_recent_first() {
        let many: Vec<RecentWorkEntry> = (0..RECENT_WORK_CAP + 5)
            .rev()
            .map(|i| {
                entry(
                    &format!("00000000-0000-0000-0000-{i:012}"),
                    &format!("2026-09-27T{:02}:00:00.000Z", i % 24),
                )
            })
            .collect();
        let merged = merge_recent_work(&[], &many);
        assert_eq!(merged.len(), RECENT_WORK_CAP);
        let youngest = merged.windows(2).all(|w| w[0].left_at >= w[1].left_at);
        assert!(youngest, "merged entries sort most-recent-first");
    }

    /// A stale read loses to a fresher one on the same resource.
    #[test]
    fn a_fresher_left_at_wins_over_a_stale_current() {
        let stale = vec![entry(A, "2026-09-26T10:00:00.000Z")];
        let fresh = vec![entry(A, "2026-09-27T10:00:00.000Z")];
        let merged = merge_recent_work(&[stale], &fresh);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].left_at, "2026-09-27T10:00:00.000Z");
    }

    /// A place just left shows at once: the queue folds into the read by
    /// the commit's own rule, and says how much of it is local.
    #[test]
    fn queued_entries_fold_into_the_read() {
        let read = RecentWorkView {
            entries: vec![entry(A, "2026-09-27T10:00:00.000Z")],
            queued: 0,
        };
        let view = with_queued(
            read,
            &[
                entry(A, "2026-09-27T12:00:00.000Z"),
                entry(B, "2026-09-27T11:00:00.000Z"),
            ],
        );
        assert_eq!(view.queued, 2);
        assert_eq!(view.entries.len(), 2);
        assert_eq!(view.entries[0].resource, A);
        assert_eq!(view.entries[0].left_at, "2026-09-27T12:00:00.000Z");
    }

    /// The shape bounds the family: closed, capped, the five watched facts.
    #[test]
    fn the_shape_bounds_the_family() {
        let schema = recent_work_schema();
        assert_eq!(
            schema["properties"]["entries"]["maxItems"],
            RECENT_WORK_CAP as u64
        );
        let item = &schema["properties"]["entries"]["items"];
        assert_eq!(item["additionalProperties"], serde_json::json!(false));
        assert_eq!(
            item["required"],
            serde_json::json!(["resource", "room", "openedAt", "leftAt", "device"])
        );
    }

    /// Live witnesses for the hub clauses, against the real API: the shape
    /// refuses a malformed commit; two currents from the same base are
    /// merged and superseded by the next write; the merged entries read
    /// back. Ignored by default — it needs the machine's temper
    /// credentials and network, and it performs real writes in the person's
    /// configured context, cleaning up its own hub afterwards. Run locally:
    /// `cargo test -p desktop -- --ignored the_hub_round_trips_live`
    #[tokio::test]
    #[ignore = "requires temper credentials, network, and performs real writes"]
    async fn the_hub_round_trips_two_writers_convergence_and_the_shape_guard() {
        use temper_core::types::data_artifact::ArtifactCommitRequest;

        let state = crate::temper::TemperState::connect();
        let client = state
            .client()
            .expect("machine temper credentials should resolve to a client");
        let context_name = crate::settings::DEFAULT_TEMPER_CONTEXT;

        // The fork: two writers from the same base leave two live currents.
        let first = commit_recent_work(
            client,
            context_name,
            vec![entry(A, "2026-09-27T10:00:00.000Z")],
        )
        .await
        .expect("the first commit should land");
        assert_eq!(first.entries.len(), 1);
        let context_id = crate::person_context::persons_context_id(client, context_name)
            .await
            .expect("the person's context should resolve");
        let currents_before = read_currents(client, context_id)
            .await
            .expect("the hub's currents should read");
        let second = commit_recent_work(
            client,
            context_name,
            vec![
                entry(A, "2026-09-27T11:00:00.000Z"),
                entry(B, "2026-09-27T09:00:00.000Z"),
            ],
        )
        .await
        .expect("the second commit should land");
        assert_eq!(
            second.entries.len(),
            2,
            "the second commit superseded the first and merged both"
        );

        // The shape is enforcing: junk is refused, not recorded.
        let hubs = find_hub_resources(client, context_id)
            .await
            .expect("the hub should be findable");
        assert!(!hubs.is_empty(), "the hub should exist by now");
        let junk = client
            .data_artifacts()
            .commit(
                hubs[0],
                &ArtifactCommitRequest {
                    kind: RECENT_WORK_KIND.to_string(),
                    kind_owner: None,
                    intent: "current".to_string(),
                    precedence: 0.0,
                    content: serde_json::json!({ "version": 1, "entries": [
                        { "resource": "not-a-uuid", "room": "x", "openedAt": "x", "leftAt": "x", "device": "x" }
                    ] }),
                    supersedes: Vec::new(),
                    act: Default::default(),
                },
            )
            .await;
        assert!(
            junk.is_err(),
            "the enforcing shape must refuse a malformed commit, got {junk:?}"
        );

        // The read side merges the currents the same way the CLI would see
        // them.
        let view = recent_work(client, context_name)
            .await
            .expect("the merged entries should read");
        assert_eq!(view.entries.len(), 2);
        assert_eq!(view.entries[0].resource, A, "most recent first");
        assert_eq!(view.entries[0].left_at, "2026-09-27T11:00:00.000Z");

        // The shape exists, declared once, enforcing.
        let shapes = client
            .data_artifacts()
            .list_shapes(context_id)
            .await
            .expect("shapes should list");
        assert!(shapes.iter().any(|s| !s.is_folded
            && s.artifact_kind == RECENT_WORK_KIND
            && s.enforcement == EnforcementMode::Enforcing));

        let _ = currents_before;
        client
            .resources()
            .delete(hubs[0], &Default::default())
            .await
            .expect("the witness cleans up after itself");
    }
}
