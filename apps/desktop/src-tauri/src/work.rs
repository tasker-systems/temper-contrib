//! The conversation work record: one temper resource per ACP conversation,
//! written at close into the person's temper context. Raw ACP continuity —
//! the agent process session and the live transcript buffer — stays
//! device-local; the record is what survives losing it.
//!
//! Every fact rides in as an argument: nothing is read from this machine,
//! so the record names the work on a device that holds no continuity.
//! The context it lands in is the device setting
//! (`DeviceSettings::temper_context_name`), found by profile owner and
//! configured name, created on first write.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use temper_client::TemperClient;
use temper_core::types::ingest::IngestPayload;

use crate::person_context::persons_context_id;
use crate::settings::SettingsState;
use crate::temper::TemperState;

/// The record's doc type: the conversation as work done, not the transcript.
pub const WORK_RECORD_DOC_TYPE: &str = "work record";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkRecordFacts {
    pub agent_label: String,
    pub agent_command: String,
    pub working_dir: String,
    /// RFC 3339, from the surface that watched the conversation open.
    pub opened_at: String,
    pub closed_at: String,
    /// What the session was started for, when it was started with a scope:
    /// linked from the record, never where the record lives (it lives in the
    /// person's context).
    #[serde(default)]
    pub scope: Option<WorkScope>,
}

/// A session's scope: a context the person works in, or a goal.
#[derive(Debug, Clone, Deserialize)]
pub struct WorkScope {
    /// `context` or `goal`.
    pub kind: ScopeKind,
    /// A context ref (`+team/slug`, `@owner/slug`) or a goal's ref.
    #[serde(rename = "ref")]
    pub reference: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    Context,
    Goal,
}

impl ScopeKind {
    fn word(self) -> &'static str {
        match self {
            ScopeKind::Context => "context",
            ScopeKind::Goal => "goal",
        }
    }
}

/// The goal a record advances: only a goal scope names one, and only a ref
/// that carries a UUID can.
fn record_goal(facts: &WorkRecordFacts) -> Option<Uuid> {
    facts
        .scope
        .as_ref()
        .filter(|s| s.kind == ScopeKind::Goal)
        .and_then(|s| crate::temper::parse_ref(&s.reference))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenRecord {
    pub id: Uuid,
    pub decorated_ref: String,
    pub title: String,
}

fn record_title(facts: &WorkRecordFacts) -> String {
    let place = std::path::Path::new(&facts.working_dir)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| facts.working_dir.clone());
    let day = facts
        .closed_at
        .get(..10)
        .unwrap_or(&facts.closed_at)
        .to_string();
    format!("{} — {} — {}", facts.agent_label, place, day)
}

fn record_markdown(facts: &WorkRecordFacts) -> String {
    let scoped = facts
        .scope
        .as_ref()
        .map(|s| format!("- Scoped to the {} `{}`\n", s.kind.word(), s.reference))
        .unwrap_or_default();
    format!(
        "A conversation with the {label} agent, run as `{command}` in `{dir}`.\n\
\n\
- Agent: {label} (`{command}`)\n\
- Working directory: `{dir}`\n\
- Opened: {opened}\n\
- Closed: {closed}\n\
- Resumable workspace: `{dir}` — resolves only on a machine holding this directory\n\
{scoped}\
\n\
What the conversation produced is not linked here yet. The raw transcript \
stays device-local; this record is what survives losing it.\n",
        label = facts.agent_label,
        command = facts.agent_command,
        dir = facts.working_dir,
        opened = facts.opened_at,
        closed = facts.closed_at,
        scoped = scoped,
    )
}

fn record_payload(
    facts: &WorkRecordFacts,
    context_id: Uuid,
    idempotency_key: Uuid,
) -> IngestPayload {
    // Open keys the facts may not carry are omitted, never null: the server deletes an
    // open_meta key on an explicit null on update, and refuses a null on create — a null
    // here would make every scope-less write a 400.
    let mut open_meta = serde_json::json!({
        "agent": facts.agent_label,
        "agent_command": facts.agent_command,
        "working_dir": facts.working_dir,
        "opened_at": facts.opened_at,
        "closed_at": facts.closed_at,
        "resumable_workspace": facts.working_dir,
        "products": [],
    });
    if let Some(scope) = &facts.scope {
        open_meta["scope_kind"] = serde_json::Value::String(scope.kind.word().to_string());
        open_meta["scope_ref"] = serde_json::Value::String(scope.reference.clone());
    }
    IngestPayload {
        title: record_title(facts),
        origin_uri: String::new(),
        context_ref: context_id.to_string(),
        home_cogmap_id: None,
        doc_type_name: WORK_RECORD_DOC_TYPE.to_string(),
        goal: record_goal(facts),
        content_hash: None,
        idempotency_key: Some(idempotency_key),
        content: record_markdown(facts),
        metadata: None,
        managed_meta: None,
        open_meta: Some(open_meta),
        chunks_packed: None,
        sources: Vec::new(),
        act: Default::default(),
        segmented: None,
    }
}

/// Writes the record and returns what landed, as the surface addresses it.
pub async fn write_work_record(
    client: &TemperClient,
    facts: WorkRecordFacts,
    idempotency_key: Uuid,
    context_name: &str,
) -> Result<WrittenRecord, String> {
    let context_id = persons_context_id(client, context_name).await?;
    let view = client
        .ingest()
        .create(&record_payload(&facts, context_id, idempotency_key))
        .await
        .map_err(|e| e.to_string())?;
    Ok(WrittenRecord {
        id: view.id.0,
        decorated_ref: view.r#ref,
        title: view.title,
    })
}

/// Writes the conversation work record at close. Every fact arrives from
/// the surface; the core adds nothing from this machine beyond the
/// configured context name.
#[tauri::command]
pub async fn temper_write_work_record(
    state: tauri::State<'_, TemperState>,
    settings: tauri::State<'_, SettingsState>,
    facts: WorkRecordFacts,
    idempotency_key: Uuid,
) -> Result<WrittenRecord, String> {
    let client = state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let context_name = settings.get().temper_context_name().to_string();
    write_work_record(client, facts, idempotency_key, &context_name).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> WorkRecordFacts {
        WorkRecordFacts {
            agent_label: "opencode".to_string(),
            agent_command: "opencode acp".to_string(),
            working_dir: "/home/dev/project".to_string(),
            opened_at: "2026-09-27T10:00:00.000Z".to_string(),
            closed_at: "2026-09-27T10:30:00.000Z".to_string(),
            scope: None,
        }
    }

    /// A session scoped to a goal advances it: the record carries the scope
    /// and takes the goal edge, and stays homed where it always is.
    #[test]
    fn a_goal_scope_is_linked_and_advanced_not_homed() {
        let mut f = facts();
        f.scope = Some(WorkScope {
            kind: ScopeKind::Goal,
            reference: "temper-is-worked-natively-01a0d873-59c9-72f0-a31f-23f0da5d8789".into(),
        });
        let home = Uuid::new_v4();
        let payload = record_payload(&f, home, Uuid::new_v4());
        assert_eq!(
            payload.goal,
            Some(Uuid::parse_str("01a0d873-59c9-72f0-a31f-23f0da5d8789").unwrap())
        );
        assert_eq!(
            payload.context_ref,
            home.to_string(),
            "homed in the person's context"
        );
        let meta = payload.open_meta.expect("open_meta");
        assert_eq!(meta["scope_kind"], "goal");
        assert!(payload.content.contains("Scoped to the goal"));
    }

    /// A context scope is linked, and advances nothing.
    #[test]
    fn a_context_scope_is_linked_and_advances_nothing() {
        let mut f = facts();
        f.scope = Some(WorkScope {
            kind: ScopeKind::Context,
            reference: "+temper-dev/contrib".into(),
        });
        let payload = record_payload(&f, Uuid::nil(), Uuid::new_v4());
        assert_eq!(payload.goal, None);
        let meta = payload.open_meta.expect("open_meta");
        assert_eq!(meta["scope_kind"], "context");
        assert_eq!(meta["scope_ref"], "+temper-dev/contrib");
        assert!(payload
            .content
            .contains("Scoped to the context `+temper-dev/contrib`"));
    }

    #[test]
    fn an_unscoped_record_says_nothing_of_scope() {
        let payload = record_payload(&facts(), Uuid::nil(), Uuid::new_v4());
        assert_eq!(payload.goal, None);
        assert!(!payload.content.contains("Scoped"));
        assert_eq!(
            payload.open_meta.expect("open_meta")["scope_kind"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn the_record_names_the_work_without_reading_the_machine() {
        let markdown = record_markdown(&facts());
        for named in [
            "opencode",
            "opencode acp",
            "/home/dev/project",
            "2026-09-27T10:00:00.000Z",
            "2026-09-27T10:30:00.000Z",
            "Resumable workspace",
            "not linked here yet",
        ] {
            assert!(markdown.contains(named), "the record must name {named}");
        }
        assert_eq!(
            record_title(&facts()),
            "opencode — project — 2026-09-27",
            "the title names the agent, the place, and the day"
        );
    }

    #[test]
    fn a_title_falls_back_to_the_full_directory_when_it_has_no_basename() {
        let mut f = facts();
        f.working_dir = "/".to_string();
        assert_eq!(record_title(&f), "opencode — / — 2026-09-27");
    }

    #[test]
    fn the_payload_is_self_contained_and_keyed() {
        let key = Uuid::new_v4();
        let payload = record_payload(&facts(), Uuid::nil(), key);
        assert_eq!(payload.doc_type_name, WORK_RECORD_DOC_TYPE);
        assert_eq!(payload.idempotency_key, Some(key));
        assert!(payload.context_ref.contains('-'));
        let meta = payload.open_meta.expect("structured facts ride open_meta");
        assert_eq!(meta["products"], serde_json::json!([]));
        assert_eq!(meta["working_dir"], "/home/dev/project");
        assert!(payload.content.contains("Resumable workspace"));
    }

    /// Witness for the record clause: a write against the real API lands a
    /// readable record in the person's configured context, then removes
    /// itself. Ignored by default — it needs the machine's temper
    /// credentials and network, and it performs one real write and one real
    /// delete. Run locally:
    /// `cargo test -p desktop -- --ignored writes_a_readable_work_record`
    #[tokio::test]
    #[ignore = "requires temper credentials, network, and performs a real write"]
    async fn writes_a_readable_work_record() {
        let state = crate::temper::TemperState::connect();
        let client = state
            .client()
            .expect("machine temper credentials should resolve to a client");

        let key = Uuid::new_v4();
        let context_name = crate::settings::DEFAULT_TEMPER_CONTEXT;
        let written = write_work_record(client, facts(), key, context_name)
            .await
            .expect("the work record should land in temper");

        // Read back the way the CLI would see it: a resource with a title and a body.
        let view = client
            .resources()
            .get(written.id, None)
            .await
            .expect("the record should read back");
        assert_eq!(view.title, written.title);
        assert_eq!(view.doc_type_name, WORK_RECORD_DOC_TYPE);
        let content = client
            .resources()
            .content(written.id)
            .await
            .expect("the record's body should read");
        assert!(content.markdown.contains("Resumable workspace"));

        client
            .resources()
            .delete(written.id, &Default::default())
            .await
            .expect("the witness cleans up after itself");
    }
}
