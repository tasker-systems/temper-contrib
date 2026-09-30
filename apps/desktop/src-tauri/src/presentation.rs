//! The webview's side of a presented view, and its record. The webview runs
//! `checkSpec` — the gate a view renders through — and answers rendered or
//! refused with its reasons. A rendered answer is recorded before it
//! resolves: the core re-checks the agent's own spec (the gate a record is
//! written through), commits it as a `desktop-presented-view` artifact, and
//! only then tells the agent rendered, carrying where the record lives. A
//! record that fails, or does not finish in its bound, turns the render into
//! a refusal; a refused view is never recorded.
//!
//! The record is `pinned` — one immutable fact per presentation, never
//! superseded, never merged — on the person's `Presented views` hub, a
//! sibling of the `Desktop hub` found and created the same race-tolerant way
//! (`hub.rs`). Closed views stay findable as that hub's pinned artifacts; the
//! record is the tab's rebuildable subject.

use std::future::Future;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use temper_client::TemperClient;
use temper_core::types::data_artifact::{ArtifactCommitRequest, ArtifactView};
use uuid::Uuid;

use crate::acp::AcpState;
use crate::hub::{ensure_hub_resource, ensure_shape};
use crate::person_context::persons_context_id;
use crate::present_board::{PresentOutcome, Presentation, PresentationBoard, PresentedTab};
use crate::settings::SettingsState;
use crate::spec_check::check_spec;
use crate::temper::TemperState;

/// The family: one pinned artifact per rendered presentation.
pub const PRESENTED_VIEW_KIND: &str = "desktop-presented-view";

/// The hub presented views home on. Records accumulate here, so they live
/// apart from the `Desktop hub`, which holds only what is current.
pub const PRESENTED_HUB_TITLE: &str = "Presented views";

const PRESENTED_HUB_CONTENT: &str = "Views agents presented in this person's desktop \
                                     conversations. Each is a pinned record of one \
                                     presentation: the agent's spec verbatim, who presented \
                                     it, the catalog it passed and when. A closed view's tab \
                                     is rebuilt from its record here.";

/// How long the lookups before a record may take — the context, the
/// profile, the shape, the hub. The presentation's own bound does not run
/// while it commits, so this keeps a turn from waiting on a slow temper;
/// running out of it is a refusal with nothing written. The commit itself is
/// not under it: once sent, it runs to its answer, bounded by temper's own
/// request ceiling and the client's timeout above it — abandoning a commit
/// in flight is what would record a view whose agent was told refused.
pub const PREPARE_BOUND: Duration = Duration::from_secs(15);

/// A presented view's record, as committed and as read back. Closed both
/// ways: the shape refuses a stray field on commit, and a read refuses one
/// the shape did not.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentedRecord {
    pub version: u32,
    /// The desktop conversation the view was presented in.
    pub conversation_id: String,
    /// The presenting agent, as its own init answer named itself.
    pub agent: String,
    /// The catalog the spec passed, e.g. `temper@1.0.0`.
    pub catalog_version: String,
    /// RFC 3339, when the core recorded it.
    pub presented_at: String,
    /// The agent's spec, verbatim.
    pub spec: serde_json::Value,
    /// Always `rendered`: a refused view is never recorded.
    pub outcome: String,
}

/// The family's shape: draft 2020-12, closed. `spec` is closed at its top
/// level only — the record holds the spec verbatim so a later catalog
/// version can re-check it; which check it passed is `catalogVersion`.
pub fn presented_view_schema() -> serde_json::Value {
    serde_json::json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": false,
        "required": ["version", "conversationId", "agent", "catalogVersion", "presentedAt", "spec", "outcome"],
        "properties": {
            "version": { "const": 1 },
            "conversationId": { "type": "string", "minLength": 1 },
            "agent": { "type": "string" },
            "catalogVersion": { "type": "string", "pattern": "^temper@" },
            "presentedAt": { "type": "string", "minLength": 1 },
            "spec": {
                "type": "object",
                "additionalProperties": false,
                "required": ["root", "elements"],
                "properties": {
                    "root": { "type": "string" },
                    "elements": { "type": "object" }
                }
            },
            "outcome": { "const": "rendered" }
        }
    })
}

/// The record of one rendered presentation. Pure, so the shape witness
/// needs no server.
pub fn record_of(
    conversation_id: &str,
    presentation: &Presentation,
    presented_at: &str,
) -> PresentedRecord {
    PresentedRecord {
        version: 1,
        conversation_id: conversation_id.to_string(),
        agent: presentation.agent.clone(),
        catalog_version: crate::present_server::catalog_version(),
        presented_at: presented_at.to_string(),
        spec: presentation.spec.clone(),
        outcome: "rendered".to_string(),
    }
}

/// The commit a record is written by: pinned, superseding nothing.
fn record_request(record: &PresentedRecord) -> Result<ArtifactCommitRequest, String> {
    Ok(ArtifactCommitRequest {
        kind: PRESENTED_VIEW_KIND.to_string(),
        kind_owner: None,
        intent: "pinned".to_string(),
        precedence: 0.0,
        content: serde_json::to_value(record).map_err(|e| e.to_string())?,
        supersedes: Vec::new(),
        act: Default::default(),
    })
}

/// Resolves one parked presentation with the webview's answer. A rendered
/// answer marks the presentation committing — from then on a close or the
/// bound cannot refuse it — re-checks the agent's own spec in the core,
/// then records it through `commit`, which carries its own bounds. Only a
/// record that landed is told rendered; every other end is a named refusal
/// with nothing recorded.
pub async fn answer<C, F>(
    board: &PresentationBoard,
    conversation_id: &str,
    presented_id: &str,
    rendered: bool,
    reasons: Vec<String>,
    commit: C,
) -> Result<(), String>
where
    C: FnOnce(String, Presentation) -> F,
    F: Future<Output = Result<PresentedTab, String>>,
{
    if !rendered {
        let reasons = if reasons.is_empty() {
            vec!["the desktop refused the view without naming a reason".to_string()]
        } else {
            reasons
        };
        return board.resolve(
            conversation_id,
            presented_id,
            PresentOutcome::refused(reasons),
        );
    }
    let committing = board.begin_commit(conversation_id, presented_id)?;
    let presentation = committing.presentation().clone();
    let outcome = match check_spec(&presentation.spec) {
        Err(core_reasons) => PresentOutcome::refused(
            std::iter::once(
                "the desktop's own check refused a view its webview passed".to_string(),
            )
            .chain(core_reasons)
            .collect(),
        ),
        Ok(()) => match commit(conversation_id.to_string(), presentation).await {
            Ok(tab) => PresentOutcome::Rendered { tab },
            // The agent is told that the record failed, never temper's own
            // error text: it can carry the API host and the ids of the
            // person's context and hub.
            Err(_) => PresentOutcome::refused(vec![
                "the view was checked but could not be recorded in temper".to_string(),
            ]),
        },
    };
    committing.finish(outcome);
    Ok(())
}

/// Runs `prepare` within `bound`, then `commit` on what it prepared with no
/// bound of its own: a slow preparation is abandoned with nothing written,
/// and a commit once begun is never abandoned by us.
async fn prepare_then_commit<T, U, P, C, F>(
    bound: Duration,
    prepare: P,
    commit: C,
) -> Result<U, String>
where
    P: Future<Output = Result<T, String>>,
    C: FnOnce(T) -> F,
    F: Future<Output = Result<U, String>>,
{
    let prepared = tokio::time::timeout(bound, prepare)
        .await
        .map_err(|_| format!("temper did not answer within {bound:?}"))??;
    commit(prepared).await
}

/// The lookups a record needs: the person's context, the shape declared
/// when absent, the hub found or created. Answers the hub.
async fn prepare_hub(
    client: &TemperClient,
    context_name: &str,
    hub_title: &str,
) -> Result<Uuid, String> {
    let context_id = persons_context_id(client, context_name).await?;
    let profile_id = client.profile().get().await.map_err(|e| e.to_string())?.id;
    ensure_shape(
        client,
        context_id,
        profile_id,
        PRESENTED_VIEW_KIND,
        presented_view_schema(),
    )
    .await?;
    ensure_hub_resource(client, context_id, hub_title, PRESENTED_HUB_CONTENT).await
}

/// Records one rendered presentation on the named hub in the person's
/// configured context: the lookups within [`PREPARE_BOUND`], then one pinned
/// commit run to its answer.
async fn record_on(
    client: &TemperClient,
    context_name: &str,
    hub_title: &str,
    conversation_id: &str,
    presentation: &Presentation,
) -> Result<PresentedTab, String> {
    prepare_then_commit(
        PREPARE_BOUND,
        prepare_hub(client, context_name, hub_title),
        |hub| async move {
            let record = record_of(
                conversation_id,
                presentation,
                &chrono::Utc::now().to_rfc3339(),
            );
            let response = client
                .data_artifacts()
                .commit(hub, &record_request(&record)?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(PresentedTab {
                resource: hub.to_string(),
                artifact: response.artifact_id.to_string(),
            })
        },
    )
    .await
}

/// A recorded view as the tab reads it: the record, and where it lives.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentedView {
    pub resource: String,
    pub artifact: String,
    pub record: PresentedRecord,
}

/// The read projection: an artifact is a presented view only when it is of
/// this family under the person's own namespace, pinned and live, its
/// content the closed record, and its spec one the core's check passes — a
/// record anyone else wrote, or one written around the shape, is not one.
/// Every refusal is the same sentence: the read never says what an artifact
/// it refused is.
fn presented_view_from(artifact: ArtifactView, profile_id: Uuid) -> Result<PresentedView, String> {
    let refused = || format!("artifact {} is not a presented view", artifact.artifact_id);
    if artifact.artifact_kind != PRESENTED_VIEW_KIND
        || artifact.kind_owner_table != "kb_profiles"
        || artifact.kind_owner_id != profile_id
        || artifact.intent != "pinned"
        || artifact.is_folded
    {
        return Err(refused());
    }
    let record: PresentedRecord = artifact
        .content
        .clone()
        .and_then(|c| serde_json::from_value(c).ok())
        .ok_or_else(refused)?;
    if check_spec(&record.spec).is_err() {
        return Err(refused());
    }
    Ok(PresentedView {
        resource: artifact.resource_id.to_string(),
        artifact: artifact.artifact_id.to_string(),
        record,
    })
}

/// Reads one recorded view back from temper by its owning resource and id.
pub async fn read_presented(
    client: &TemperClient,
    resource: Uuid,
    artifact: Uuid,
) -> Result<PresentedView, String> {
    let view = client
        .data_artifacts()
        .get(resource, artifact)
        .await
        .map_err(|e| e.to_string())?;
    let profile_id = client.profile().get().await.map_err(|e| e.to_string())?.id;
    presented_view_from(view, profile_id)
}

/// The webview's answer to a presented view: `rendered` when checkSpec
/// passed, else `refused` with checkSpec's errors as the reasons.
#[tauri::command]
pub async fn present_answer(
    state: tauri::State<'_, AcpState>,
    temper: tauri::State<'_, TemperState>,
    settings: tauri::State<'_, SettingsState>,
    conversation_id: String,
    presented_id: String,
    rendered: bool,
    reasons: Vec<String>,
) -> Result<(), String> {
    let board = state.present_board.clone();
    let context_name = settings.get().temper_context_name().to_string();
    let client = temper.client();
    answer(
        &board,
        &conversation_id,
        &presented_id,
        rendered,
        reasons,
        |conversation_id, presentation| async move {
            let client = client.ok_or_else(|| "temper is not connected".to_string())?;
            record_on(
                client,
                &context_name,
                PRESENTED_HUB_TITLE,
                &conversation_id,
                &presentation,
            )
            .await
        },
    )
    .await
}

/// A recorded view, read back from temper for its tab.
#[tauri::command]
pub async fn present_read(
    temper: tauri::State<'_, TemperState>,
    resource: String,
    artifact: String,
) -> Result<PresentedView, String> {
    let client = temper
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let resource =
        Uuid::parse_str(&resource).map_err(|e| format!("not a resource id: {resource} — {e}"))?;
    let artifact =
        Uuid::parse_str(&artifact).map_err(|e| format!("not an artifact id: {artifact} — {e}"))?;
    read_presented(client, resource, artifact).await
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::present_board::{PresentNotice, PresentSink, ANSWER_BOUND};

    fn conforming() -> serde_json::Value {
        json!({ "root": "r", "elements": { "r": {
            "type": "RegionState", "props": { "state": "failed", "label": "history" }, "children": []
        } } })
    }

    fn a_tab() -> PresentedTab {
        PresentedTab {
            resource: "00000000-0000-0000-0000-00000000000a".to_string(),
            artifact: "00000000-0000-0000-0000-00000000000b".to_string(),
        }
    }

    /// Parks one presentation of `spec` on a surfaced board with `bound`
    /// and returns the board, the parked call, and its id.
    async fn parked_with(
        spec: serde_json::Value,
        bound: Duration,
    ) -> (
        PresentationBoard,
        tokio::task::JoinHandle<PresentOutcome>,
        String,
    ) {
        let board = PresentationBoard::default();
        board.set_surface("c1", true);
        let ids: Arc<Mutex<Vec<String>>> = Arc::default();
        let record = ids.clone();
        let sink: PresentSink = Arc::new(move |n| {
            if let PresentNotice::Presented { presented_id, .. } = n {
                record.lock().unwrap().push(presented_id);
            }
        });
        let call = {
            let board = board.clone();
            tokio::spawn(async move {
                board
                    .present(
                        "c1",
                        Presentation {
                            agent: "witness-agent".to_string(),
                            spec,
                        },
                        &sink,
                        bound,
                    )
                    .await
            })
        };
        for _ in 0..200 {
            if let Some(id) = ids.lock().unwrap().first().cloned() {
                return (board, call, id);
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("nothing parked");
    }

    async fn parked() -> (
        PresentationBoard,
        tokio::task::JoinHandle<PresentOutcome>,
        String,
    ) {
        parked_with(conforming(), ANSWER_BOUND).await
    }

    fn reasons_of(outcome: PresentOutcome) -> Vec<String> {
        match outcome {
            PresentOutcome::Refused { reasons, .. } => reasons,
            PresentOutcome::Rendered { .. } => panic!("expected a refusal, got rendered"),
        }
    }

    #[tokio::test]
    async fn a_checked_view_is_recorded_from_the_agent_s_spec_then_rendered() {
        let (board, call, id) = parked().await;
        let committed: Arc<Mutex<Option<(String, serde_json::Value)>>> = Arc::default();
        let seen = committed.clone();
        answer(&board, "c1", &id, true, vec![], |c, p| async move {
            *seen.lock().unwrap() = Some((c, p.spec));
            Ok(a_tab())
        })
        .await
        .expect("the answer lands");
        assert_eq!(
            call.await.unwrap(),
            PresentOutcome::Rendered { tab: a_tab() },
            "the agent is told where the record lives"
        );
        assert_eq!(
            committed.lock().unwrap().clone(),
            Some(("c1".to_string(), conforming())),
            "the record is the spec the agent sent, in its conversation"
        );
    }

    #[tokio::test]
    async fn a_failed_record_turns_the_render_into_a_named_refusal() {
        let (board, call, id) = parked().await;
        answer(&board, "c1", &id, true, vec![], |_, _| async {
            Err("temper unreachable".to_string())
        })
        .await
        .expect("the refusal lands");
        assert_eq!(
            reasons_of(call.await.unwrap()),
            vec!["the view was checked but could not be recorded in temper"]
        );
    }

    #[tokio::test]
    async fn a_refusal_carries_checkspec_s_reasons_and_records_nothing() {
        let (board, call, id) = parked().await;
        let reasons = vec!["elements/a/props: Unrecognized key: \"colour\"".to_string()];
        answer(&board, "c1", &id, false, reasons.clone(), |_, _| async {
            panic!("a refused view is never recorded")
        })
        .await
        .expect("the refusal lands");
        assert_eq!(reasons_of(call.await.unwrap()), reasons);
    }

    /// The webview's `rendered` is not taken on trust: a spec the core's own
    /// check refuses is refused, and never reaches the record.
    #[tokio::test]
    async fn the_core_refuses_to_record_a_spec_its_own_check_rejects() {
        let cycle = json!({ "root": "a", "elements": { "a": {
            "type": "RegionState", "props": { "state": "failed", "label": "history" }, "children": ["a"]
        } } });
        let (board, call, id) = parked_with(cycle, ANSWER_BOUND).await;
        answer(&board, "c1", &id, true, vec![], |_, _| async {
            panic!("a spec the core refuses is never recorded")
        })
        .await
        .expect("the refusal lands");
        let reasons = reasons_of(call.await.unwrap());
        assert_eq!(
            reasons[0],
            "the desktop's own check refused a view its webview passed"
        );
        assert!(
            reasons.iter().any(|r| r.contains("already placed")),
            "{reasons:?}"
        );
    }

    /// The ruling's witness, end to end: a record slower than the
    /// presentation's bound still renders — the bound does not refuse a view
    /// whose record is landing.
    #[tokio::test]
    async fn a_record_slower_than_the_bound_is_still_told_rendered() {
        let (board, call, id) = parked_with(conforming(), Duration::from_millis(20)).await;
        answer(&board, "c1", &id, true, vec![], |_, _| async {
            tokio::time::sleep(Duration::from_millis(80)).await;
            Ok(a_tab())
        })
        .await
        .expect("the answer lands");
        assert_eq!(
            call.await.unwrap(),
            PresentOutcome::Rendered { tab: a_tab() }
        );
    }

    /// A slow preparation is abandoned within its bound, and the commit it
    /// would have fed never starts: nothing is written.
    #[tokio::test]
    async fn a_slow_preparation_is_refused_before_anything_is_committed() {
        let committed = Arc::new(Mutex::new(false));
        let mark = committed.clone();
        let result = prepare_then_commit(
            Duration::from_millis(20),
            async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                Ok(())
            },
            |()| async move {
                *mark.lock().unwrap() = true;
                Ok(())
            },
        )
        .await;
        assert_eq!(result, Err("temper did not answer within 20ms".to_string()));
        assert!(!*committed.lock().unwrap(), "no commit began");
    }

    /// A commit once begun is never abandoned by the bound: a commit slower
    /// than the bound still answers — its record and its agent's answer
    /// agree.
    #[tokio::test]
    async fn a_commit_slower_than_the_bound_still_answers() {
        let result = prepare_then_commit(
            Duration::from_millis(20),
            async { Ok("hub") },
            |hub| async move {
                tokio::time::sleep(Duration::from_millis(80)).await;
                Ok(format!("{hub}: committed"))
            },
        )
        .await;
        assert_eq!(result, Ok("hub: committed".to_string()));
    }

    #[tokio::test]
    async fn an_answer_for_an_ended_presentation_is_an_error() {
        let (board, call, id) = parked().await;
        board.close("c1");
        call.await.unwrap();
        assert!(answer(&board, "c1", &id, true, vec![], |_, _| async {
            panic!("an ended presentation is never recorded")
        })
        .await
        .is_err());
    }

    fn shape_errors(content: &serde_json::Value) -> Vec<String> {
        let validator = jsonschema::validator_for(&presented_view_schema()).unwrap();
        validator
            .iter_errors(content)
            .map(|e| e.to_string())
            .collect()
    }

    /// The record the core writes conforms to the family's shape, and the
    /// shape refuses a record it should not hold.
    #[test]
    fn the_record_conforms_and_the_shape_is_closed() {
        let presentation = Presentation {
            agent: "witness-agent".to_string(),
            spec: conforming(),
        };
        let record =
            serde_json::to_value(record_of("c1", &presentation, "2026-09-30T10:00:00+00:00"))
                .unwrap();
        assert_eq!(shape_errors(&record), Vec::<String>::new());
        assert_eq!(record["spec"], conforming(), "the spec, verbatim");

        let mut stray = record.clone();
        stray["title"] = json!("a guessed title");
        assert!(!shape_errors(&stray).is_empty(), "closed at the top");
        let mut refused = record.clone();
        refused["outcome"] = json!("refused");
        assert!(!shape_errors(&refused).is_empty(), "only rendered views");
        let mut unversioned = record;
        unversioned["catalogVersion"] = json!("1.0.0");
        assert!(!shape_errors(&unversioned).is_empty());
    }

    /// Each record is its own immutable fact: pinned, superseding nothing.
    #[test]
    fn a_record_is_pinned_and_supersedes_nothing() {
        let record = record_of(
            "c1",
            &Presentation {
                agent: "a".to_string(),
                spec: conforming(),
            },
            "t",
        );
        let request = record_request(&record).unwrap();
        assert_eq!(request.kind, PRESENTED_VIEW_KIND);
        assert_eq!(request.intent, "pinned");
        assert!(request.supersedes.is_empty());
    }

    fn artifact(kind: &str, intent: &str, content: serde_json::Value) -> ArtifactView {
        serde_json::from_value(json!({
            "artifact_id": "00000000-0000-0000-0000-00000000000b",
            "resource_id": "00000000-0000-0000-0000-00000000000a",
            "kind_owner_table": "kb_profiles",
            "kind_owner_id": OWNER,
            "artifact_kind": kind,
            "intent": intent,
            "precedence": 0.0,
            "content_hash": "h",
            "content_bytes": 1,
            "shape_state": "conforming",
            "is_folded": false,
            "created": "2026-09-30T10:00:00Z",
            "content": content
        }))
        .unwrap()
    }

    const OWNER: &str = "00000000-0000-0000-0000-00000000000c";

    fn owner() -> Uuid {
        Uuid::parse_str(OWNER).unwrap()
    }

    /// The read projection admits only a live pinned record of this family,
    /// in the person's own namespace, whose spec the core's check passes —
    /// and refuses everything else with one sentence that names nothing.
    #[test]
    fn the_read_projection_admits_only_the_person_s_checked_presented_view() {
        let record = serde_json::to_value(record_of(
            "c1",
            &Presentation {
                agent: "a".to_string(),
                spec: conforming(),
            },
            "t",
        ))
        .unwrap();
        let view = presented_view_from(
            artifact(PRESENTED_VIEW_KIND, "pinned", record.clone()),
            owner(),
        )
        .expect("a presented view reads");
        assert_eq!(view.resource, "00000000-0000-0000-0000-00000000000a");
        assert_eq!(view.artifact, "00000000-0000-0000-0000-00000000000b");
        assert_eq!(view.record.spec, conforming());

        let refusal = "artifact 00000000-0000-0000-0000-00000000000b is not a presented view";
        let refused = |a: ArtifactView, by: Uuid| presented_view_from(a, by).unwrap_err();
        let other_kind = refused(
            artifact("desktop-recent-work", "pinned", record.clone()),
            owner(),
        );
        assert_eq!(
            other_kind, refusal,
            "the refusal never names the artifact's kind"
        );
        assert_eq!(
            refused(
                artifact(PRESENTED_VIEW_KIND, "current", record.clone()),
                owner()
            ),
            refusal
        );
        assert_eq!(
            refused(
                artifact(PRESENTED_VIEW_KIND, "pinned", record.clone()),
                Uuid::nil()
            ),
            refusal,
            "another namespace's artifact of the same name is not the person's record"
        );
        let mut stray = record.clone();
        stray["extra"] = json!("a value the refusal must not echo");
        assert_eq!(
            refused(artifact(PRESENTED_VIEW_KIND, "pinned", stray), owner()),
            refusal
        );
        let mut unchecked = record;
        unchecked["spec"] = json!({ "root": "a", "elements": { "a": {
            "type": "RegionState", "props": { "state": "failed", "label": "history" }, "children": ["a"]
        } } });
        assert_eq!(
            refused(artifact(PRESENTED_VIEW_KIND, "pinned", unchecked), owner()),
            refusal,
            "a record written around the shape, with a spec the core refuses, does not read"
        );
    }

    /// Live witness for the record, against the real API: one presentation
    /// is committed in the configured context, read back from temper by id,
    /// read again through a fresh connection (a closed tab reopened), and a
    /// malformed commit is refused by the enforcing shape. Writes to a
    /// witness-titled hub, deleted afterwards — the person's `Presented
    /// views` hub holds real records and is never touched. Run locally:
    /// `cargo test -p desktop -- --ignored present_artifact_round_trips_live`
    #[tokio::test]
    #[ignore = "requires temper credentials, network, and performs real writes"]
    async fn present_artifact_round_trips_live() {
        const WITNESS_HUB: &str = "Presented views (witness)";
        let state = crate::temper::TemperState::connect();
        let client = state
            .client()
            .expect("machine temper credentials should resolve to a client");
        let context_name = crate::settings::DEFAULT_TEMPER_CONTEXT;
        let context_id = persons_context_id(client, context_name)
            .await
            .expect("the person's context should resolve");
        for stale in crate::hub::find_hub_resources(client, context_id, WITNESS_HUB)
            .await
            .expect("witness hubs should list")
        {
            client
                .resources()
                .delete(stale, &Default::default())
                .await
                .expect("the witness clears its own hub before it writes");
        }

        let presentation = Presentation {
            agent: "witness-agent".to_string(),
            spec: conforming(),
        };
        let tab = record_on(
            client,
            context_name,
            WITNESS_HUB,
            "witness-conversation",
            &presentation,
        )
        .await
        .expect("the record should land");
        let resource = Uuid::parse_str(&tab.resource).unwrap();
        let artifact = Uuid::parse_str(&tab.artifact).unwrap();

        let read = read_presented(client, resource, artifact)
            .await
            .expect("the record reads back from temper");
        assert_eq!(read.record.spec, conforming(), "the spec, verbatim");
        assert_eq!(read.record.agent, "witness-agent");
        assert_eq!(read.record.conversation_id, "witness-conversation");
        assert_eq!(
            read.record.catalog_version,
            crate::present_server::catalog_version()
        );
        assert!(chrono::DateTime::parse_from_rfc3339(&read.record.presented_at).is_ok());

        // Closed and reopened: a fresh connection reads the same record.
        let reopened_state = crate::temper::TemperState::connect();
        let reopened = read_presented(reopened_state.client().unwrap(), resource, artifact)
            .await
            .expect("the record reads again after reopening");
        assert_eq!(reopened, read);

        // The shape is enforcing: a record it does not admit is refused.
        let mut junk = serde_json::to_value(&read.record).unwrap();
        junk["outcome"] = json!("refused");
        let refused = client
            .data_artifacts()
            .commit(
                resource,
                &ArtifactCommitRequest {
                    kind: PRESENTED_VIEW_KIND.to_string(),
                    kind_owner: None,
                    intent: "pinned".to_string(),
                    precedence: 0.0,
                    content: junk,
                    supersedes: Vec::new(),
                    act: Default::default(),
                },
            )
            .await;
        assert!(
            refused.is_err(),
            "the enforcing shape must refuse a malformed record, got {refused:?}"
        );

        client
            .resources()
            .delete(resource, &Default::default())
            .await
            .expect("the witness cleans up after itself");
    }
}
