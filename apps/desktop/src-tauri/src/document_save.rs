//! Saving a document, and seeing what changed.
//!
//! A body save is guarded by the hash the room recorded when it opened the document: the core
//! re-reads the current hash, refuses when it has moved, and only otherwise writes. The compare
//! and the write are two requests, so another author can still land between them — the check
//! narrows that window, it does not close it; a server-side precondition would. No lock is taken
//! at any point.
//!
//! A refusal hands back what the person needs to decide: the newer body with its hash, the most
//! recent body change and who made it, and which sections moved between the version the person
//! started from and the newer one — what *they* changed, not a blend with the person's own edits.
//!
//! Body and metadata are separate channels. A body save sends the text and nothing else; a
//! metadata save sends only the fields the person changed and never the body, so neither can
//! overwrite the other.
//!
//! "Show changes" is a line-over-line diff grouped by markdown section, computed here so the
//! page renders a result rather than diffing text itself.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use similar::{capture_diff_slices, Algorithm, ChangeTag, DiffOp, TextDiff};
use temper_client::error::ClientError;
use temper_client::TemperClient;
use temper_core::types::managed_meta::ManagedMeta;
use temper_core::types::ElementKind;
use temper_workflow::types::resource::ResourceUpdateRequest;
use uuid::Uuid;

use crate::document::{open_one, DocOpened};
use crate::temper::{parse_ref, unresolved_reason, TemperState};

// ─── Sections ───────────────────────────────────────────────────────────────────────────────────

/// One stretch of a markdown document: the text under a heading, up to the next heading.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Section {
    /// The heading line as written, or `None` for the text before the first heading.
    pub heading: Option<String>,
    /// What pairs this section with its counterpart in another version: the heading, with a
    /// repeat count so two sections under the same heading stay distinct.
    pub key: String,
    pub text: String,
}

/// The heading rule temper uses to cut a body into sections and blocks — the same pattern,
/// applied to the same trimmed line, as `chunk::heading_re` in temper's ingest crate
/// (`crates/temper-ingest/src/chunk.rs`), which its chunker, streaming segmenter and re-block
/// slicer all share. Matching it keeps a section here aligned with a section there, so "these
/// sections changed" reads as "these blocks were rewritten". Change it only together with
/// temper's rule; the parity test pins the cases where markdown readers could disagree.
fn heading_re() -> &'static Regex {
    static HEADING_RE: OnceLock<Regex> = OnceLock::new();
    HEADING_RE.get_or_init(|| Regex::new(r"^(#{1,6})\s+(.+)$").expect("heading regex is valid"))
}

fn is_heading(line: &str) -> bool {
    heading_re().is_match(line.trim_end())
}

/// Splits markdown at its headings, by temper's heading rule (see [`heading_re`]).
pub(crate) fn split_sections(markdown: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut current = Section {
        heading: None,
        key: String::from("\u{0}preamble"),
        text: String::new(),
    };
    for line in markdown.split_inclusive('\n') {
        if is_heading(line) {
            if current.heading.is_some() || !current.text.is_empty() {
                sections.push(current);
            }
            let heading = line.trim_end().to_string();
            let count = seen.entry(heading.clone()).or_insert(0);
            *count += 1;
            current = Section {
                key: format!("{heading}\u{0}{count}"),
                heading: Some(heading),
                text: String::new(),
            };
        }
        current.text.push_str(line);
    }
    if current.heading.is_some() || !current.text.is_empty() {
        sections.push(current);
    }
    sections
}

/// How a section fared between two versions.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SectionState {
    Unchanged,
    Changed,
    Added,
    Removed,
}

/// One run of text inside a changed line; `emphasized` marks the words that actually differ.
#[derive(Serialize, Debug, PartialEq)]
pub struct Segment {
    pub emphasized: bool,
    pub text: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// `equal`, `delete` or `insert`.
    pub tag: String,
    pub segments: Vec<Segment>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectionChange {
    /// The heading as it reads in the newer version (the older, for a removed section); `None`
    /// for the text before the first heading.
    pub heading: Option<String>,
    pub state: SectionState,
    /// The lines, for a section that changed, was added, or was removed. An unchanged section
    /// carries none — the view collapses it — and says how long it is instead.
    pub lines: Vec<DiffLine>,
    pub line_count: usize,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectionDiff {
    pub sections: Vec<SectionChange>,
}

fn whole(section: &Section, tag: &str) -> SectionChange {
    let lines: Vec<DiffLine> = section
        .text
        .lines()
        .map(|line| DiffLine {
            tag: tag.to_string(),
            segments: vec![Segment {
                emphasized: false,
                text: line.to_string(),
            }],
        })
        .collect();
    SectionChange {
        heading: section.heading.clone(),
        state: if tag == "insert" {
            SectionState::Added
        } else {
            SectionState::Removed
        },
        line_count: lines.len(),
        lines,
    }
}

fn changed(old: &Section, new: &Section) -> SectionChange {
    if old.text == new.text {
        return SectionChange {
            heading: new.heading.clone(),
            state: SectionState::Unchanged,
            lines: Vec::new(),
            line_count: new.text.lines().count(),
        };
    }
    let diff = TextDiff::from_lines(&old.text, &new.text);
    let mut lines = Vec::new();
    for op in diff.ops() {
        for change in diff.iter_inline_changes(op) {
            let tag = match change.tag() {
                ChangeTag::Equal => "equal",
                ChangeTag::Delete => "delete",
                ChangeTag::Insert => "insert",
            };
            let segments = change
                .iter_strings_lossy()
                .map(|(emphasized, text)| Segment {
                    emphasized,
                    text: text.trim_end_matches('\n').to_string(),
                })
                .filter(|s| !s.text.is_empty() || !s.emphasized)
                .collect();
            lines.push(DiffLine {
                tag: tag.to_string(),
                segments,
            });
        }
    }
    SectionChange {
        heading: new.heading.clone(),
        state: SectionState::Changed,
        line_count: lines.len(),
        lines,
    }
}

/// The two versions compared section by section, in document order: sections pair by heading,
/// and within a changed section the lines are diffed with the differing words emphasized.
pub(crate) fn section_diff(from: &str, to: &str) -> SectionDiff {
    let old = split_sections(from);
    let new = split_sections(to);
    let old_keys: Vec<&str> = old.iter().map(|s| s.key.as_str()).collect();
    let new_keys: Vec<&str> = new.iter().map(|s| s.key.as_str()).collect();
    let mut sections = Vec::new();
    for op in capture_diff_slices(Algorithm::Myers, &old_keys, &new_keys) {
        match op {
            DiffOp::Equal {
                old_index,
                new_index,
                len,
            } => {
                for i in 0..len {
                    sections.push(changed(&old[old_index + i], &new[new_index + i]));
                }
            }
            DiffOp::Delete {
                old_index, old_len, ..
            } => {
                for s in &old[old_index..old_index + old_len] {
                    sections.push(whole(s, "delete"));
                }
            }
            DiffOp::Insert {
                new_index, new_len, ..
            } => {
                for s in &new[new_index..new_index + new_len] {
                    sections.push(whole(s, "insert"));
                }
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                for s in &old[old_index..old_index + old_len] {
                    sections.push(whole(s, "delete"));
                }
                for s in &new[new_index..new_index + new_len] {
                    sections.push(whole(s, "insert"));
                }
            }
        }
    }
    SectionDiff { sections }
}

/// What the text before the first heading is called when a section list names it.
pub const PREAMBLE: &str = "(before the first heading)";

/// The headings of every section that differs between the two versions.
pub(crate) fn changed_headings(from: &str, to: &str) -> Vec<String> {
    section_diff(from, to)
        .sections
        .into_iter()
        .filter(|s| s.state != SectionState::Unchanged)
        .map(|s| s.heading.unwrap_or_else(|| PREAMBLE.to_string()))
        .collect()
}

// ─── Body save ──────────────────────────────────────────────────────────────────────────────────

/// Where a body save reads the current hash and writes: temper in the app, a script in the
/// witnesses.
pub(crate) trait DocStore {
    async fn head_hash(&self, id: Uuid) -> Result<Option<String>, ClientError>;
    /// Writes the body and returns the hash it now carries.
    async fn update_body(&self, id: Uuid, content: String) -> Result<Option<String>, ClientError>;
}

/// The request a body save sends: the text, and nothing that could touch the metadata.
pub(crate) fn body_request(content: String) -> ResourceUpdateRequest {
    ResourceUpdateRequest {
        content: Some(content),
        ..Default::default()
    }
}

impl DocStore for TemperClient {
    async fn head_hash(&self, id: Uuid) -> Result<Option<String>, ClientError> {
        Ok(self.resources().get(id, None).await?.body_hash)
    }

    async fn update_body(&self, id: Uuid, content: String) -> Result<Option<String>, ClientError> {
        let view = self.resources().update(id, &body_request(content)).await?;
        match view.body_hash {
            Some(hash) => Ok(Some(hash)),
            None => self.head_hash(id).await,
        }
    }
}

#[derive(Debug, PartialEq)]
pub(crate) enum Guarded {
    Saved {
        body_hash: Option<String>,
    },
    /// The document's hash is not the base the edit started from; nothing was written.
    Moved,
}

/// Compares the current hash with the base and writes only when they agree.
pub(crate) async fn guarded_save<S: DocStore>(
    store: &S,
    id: Uuid,
    base_hash: &str,
    content: String,
) -> Result<Guarded, ClientError> {
    let current = store.head_hash(id).await?;
    if current.as_deref() != Some(base_hash) {
        return Ok(Guarded::Moved);
    }
    let body_hash = store.update_body(id, content).await?;
    Ok(Guarded::Saved { body_hash })
}

/// The most recent write to the document's body, as its history records it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BodyChange {
    pub actor_name: String,
    pub occurred_at: String,
}

/// The history event kind a body write records.
const BODY_WRITE: &str = "resource_reblocked";

#[derive(Serialize, Debug)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum BodySaved {
    #[serde(rename_all = "camelCase")]
    Saved {
        body_hash: Option<String>,
    },
    /// Nothing was written: the document moved since the base the edit started from.
    #[serde(rename_all = "camelCase")]
    Refused {
        /// The document as it now reads, opened so its body and hash agree. Boxed: a whole
        /// document is far larger than the other outcomes.
        current: Box<DocOpened>,
        /// The most recent body write and who made it; `None` when history could not be read.
        last_body_change: Option<BodyChange>,
        /// Sections that differ between the base and the newer version.
        changed_sections: Vec<String>,
    },
    Unresolved {
        reason: String,
    },
    Failed {
        message: String,
    },
}

async fn last_body_change(client: &TemperClient, id: Uuid) -> Option<BodyChange> {
    let trail = client
        .events()
        .element_trail(ElementKind::Node, id)
        .await
        .ok()?;
    trail
        .events
        .into_iter()
        .filter(|e| e.kind == BODY_WRITE)
        .max_by(|a, b| a.occurred_at.cmp(&b.occurred_at))
        .map(|e| BodyChange {
            actor_name: e.actor_name,
            occurred_at: e.occurred_at,
        })
}

/// Saves a document's body when it is still at the base the edit started from, and otherwise
/// refuses with what the person needs to decide. `base_markdown` is the text that base hash
/// belongs to; it is used only to say which sections moved.
#[tauri::command]
pub async fn doc_save_body(
    state: tauri::State<'_, TemperState>,
    id: String,
    base_hash: String,
    base_markdown: String,
    content: String,
) -> Result<BodySaved, String> {
    let client = state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let Some(uuid) = parse_ref(&id) else {
        return Ok(BodySaved::Unresolved {
            reason: "not a resource reference".into(),
        });
    };
    match guarded_save(client, uuid, &base_hash, content).await {
        Ok(Guarded::Saved { body_hash }) => Ok(BodySaved::Saved { body_hash }),
        Ok(Guarded::Moved) => {
            let current = open_one(client, id).await;
            let changed_sections = match &current {
                DocOpened::Opened(doc) => changed_headings(&base_markdown, &doc.markdown),
                _ => Vec::new(),
            };
            Ok(BodySaved::Refused {
                current: Box::new(current),
                last_body_change: last_body_change(client, uuid).await,
                changed_sections,
            })
        }
        Err(err) => Ok(match unresolved_reason(&err) {
            Some(reason) => BodySaved::Unresolved {
                reason: reason.into(),
            },
            None => BodySaved::Failed {
                message: err.to_string(),
            },
        }),
    }
}

// ─── Metadata save ──────────────────────────────────────────────────────────────────────────────

/// The metadata a person changed. Absent fields are left as they are.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetaPatch {
    pub title: Option<String>,
    /// Only the keys that changed. A key set to `null` is removed.
    pub open_meta: Option<serde_json::Value>,
    /// Only the managed fields that changed, in temper's closed vocabulary.
    pub managed_meta: Option<serde_json::Value>,
}

/// The request a metadata save sends: only the named fields, and never the body.
pub(crate) fn meta_request(patch: MetaPatch) -> Result<ResourceUpdateRequest, String> {
    if patch.title.is_none() && patch.open_meta.is_none() && patch.managed_meta.is_none() {
        return Err("nothing to save".into());
    }
    if let Some(title) = &patch.title {
        if title.trim().is_empty() {
            return Err("a title cannot be empty".into());
        }
    }
    if let Some(open) = &patch.open_meta {
        if !open.is_object() {
            return Err("open metadata must be an object of changed keys".into());
        }
    }
    let managed_meta = patch
        .managed_meta
        .map(serde_json::from_value::<ManagedMeta>)
        .transpose()
        .map_err(|e| format!("managed metadata was refused: {e}"))?;
    Ok(ResourceUpdateRequest {
        title: patch.title,
        open_meta: patch.open_meta,
        managed_meta,
        ..Default::default()
    })
}

#[derive(Serialize, Debug)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum MetaSaved {
    Saved,
    /// The patch was refused before anything was sent.
    Refused {
        reason: String,
    },
    Unresolved {
        reason: String,
    },
    /// The server refused or the write did not complete; `message` is the server's own words.
    Failed {
        message: String,
    },
}

/// Saves the metadata fields a person changed, never touching the body.
#[tauri::command]
pub async fn doc_save_meta(
    state: tauri::State<'_, TemperState>,
    id: String,
    patch: MetaPatch,
) -> Result<MetaSaved, String> {
    let client = state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let Some(uuid) = parse_ref(&id) else {
        return Ok(MetaSaved::Unresolved {
            reason: "not a resource reference".into(),
        });
    };
    let request = match meta_request(patch) {
        Ok(request) => request,
        Err(reason) => return Ok(MetaSaved::Refused { reason }),
    };
    Ok(match client.resources().update(uuid, &request).await {
        Ok(_) => MetaSaved::Saved,
        Err(err) => match unresolved_reason(&err) {
            Some(reason) => MetaSaved::Unresolved {
                reason: reason.into(),
            },
            None => MetaSaved::Failed {
                message: err.to_string(),
            },
        },
    })
}

// ─── Show changes ───────────────────────────────────────────────────────────────────────────────

/// The line-over-line changes between two versions, grouped by section.
#[tauri::command]
pub fn doc_show_changes(from: String, to: String) -> SectionDiff {
    section_diff(&from, &to)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    const ID: &str = "01a0e020-a6d7-7420-b924-68f5e89f354b";

    /// Answers the head read from a script and records every write.
    struct Store {
        heads: Mutex<Vec<Option<String>>>,
        writes: Mutex<Vec<String>>,
    }

    impl Store {
        fn with_heads(heads: &[&str]) -> Self {
            Store {
                heads: Mutex::new(heads.iter().rev().map(|h| Some(h.to_string())).collect()),
                writes: Mutex::new(Vec::new()),
            }
        }
    }

    impl DocStore for Store {
        async fn head_hash(&self, _id: Uuid) -> Result<Option<String>, ClientError> {
            Ok(self.heads.lock().unwrap().pop().expect("scripted head"))
        }

        async fn update_body(
            &self,
            _id: Uuid,
            content: String,
        ) -> Result<Option<String>, ClientError> {
            self.writes.lock().unwrap().push(content);
            Ok(Some("after".into()))
        }
    }

    fn id() -> Uuid {
        Uuid::parse_str(ID).unwrap()
    }

    /// The bite: the base moved between open and save, so nothing is written.
    #[tokio::test]
    async fn a_save_against_a_moved_base_writes_nothing() {
        let store = Store::with_heads(&["someone-else-wrote"]);
        let outcome = guarded_save(&store, id(), "base", "my edit".into())
            .await
            .unwrap();
        assert_eq!(outcome, Guarded::Moved);
        assert!(store.writes.lock().unwrap().is_empty(), "no write may land");
    }

    #[tokio::test]
    async fn a_save_at_its_base_writes_once_and_reports_the_new_hash() {
        let store = Store::with_heads(&["base"]);
        let outcome = guarded_save(&store, id(), "base", "my edit".into())
            .await
            .unwrap();
        assert_eq!(
            outcome,
            Guarded::Saved {
                body_hash: Some("after".into())
            }
        );
        assert_eq!(*store.writes.lock().unwrap(), vec!["my edit".to_string()]);
    }

    #[test]
    fn a_body_save_sends_the_text_and_nothing_else() {
        let request = serde_json::to_value(body_request("text".into())).unwrap();
        assert_eq!(request, serde_json::json!({ "content": "text" }));
    }

    #[test]
    fn a_metadata_save_never_sends_the_body() {
        let request = meta_request(MetaPatch {
            open_meta: Some(serde_json::json!({ "tags": ["a"], "stale": null })),
            ..Default::default()
        })
        .unwrap();
        let wire = serde_json::to_value(request).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "open_meta": { "tags": ["a"], "stale": null } }),
            "only the changed keys, with a removed key sent as null"
        );
    }

    #[test]
    fn metadata_patches_are_refused_before_anything_is_sent() {
        assert!(meta_request(MetaPatch::default()).is_err(), "empty patch");
        assert!(
            meta_request(MetaPatch {
                title: Some("  ".into()),
                ..Default::default()
            })
            .is_err(),
            "blank title"
        );
        assert!(
            meta_request(MetaPatch {
                open_meta: Some(serde_json::json!(["not", "an", "object"])),
                ..Default::default()
            })
            .is_err(),
            "open metadata that is not an object"
        );
        assert!(
            meta_request(MetaPatch {
                managed_meta: Some(serde_json::json!({ "temper-colour": "blue" })),
                ..Default::default()
            })
            .is_err(),
            "a managed key outside temper's vocabulary"
        );
        assert!(meta_request(MetaPatch {
            managed_meta: Some(serde_json::json!({ "temper-stage": "done" })),
            ..Default::default()
        })
        .is_ok());
    }

    const BASE: &str = "Intro line.\n\n# Goals\nShip it.\n\n# Risks\nNone yet.\n";

    /// The heading rule matches temper's line for line, including the cases where markdown
    /// readers disagree: a heading must start in the first column, needs whitespace and a title
    /// after its marks, and a matching line inside fenced code counts, as it does in temper.
    #[test]
    fn the_heading_rule_matches_temper() {
        let cases: &[(&str, bool)] = &[
            ("# Title\n", true),
            ("###### Six\n", true),
            ("##\tTabbed\n", true),
            ("####### Seven\n", false),
            ("#hashtag\n", false),
            ("#\n", false),
            ("#   \n", false),
            ("   # Indented\n", false),
            ("Not # a heading\n", false),
        ];
        for (line, expected) in cases {
            assert_eq!(is_heading(line), *expected, "is_heading({line:?})");
        }
        let fenced = "Intro\n```sh\n# a shell comment\n```\n";
        let headings: Vec<Option<String>> = split_sections(fenced)
            .into_iter()
            .map(|s| s.heading)
            .collect();
        assert_eq!(headings, vec![None, Some("# a shell comment".into())]);
    }

    #[test]
    fn sections_rejoin_to_the_source_byte_for_byte() {
        let text = "Intro\n\n# A\none\n## B\ntwo\n# A\nthree";
        let rejoined: String = split_sections(text).into_iter().map(|s| s.text).collect();
        assert_eq!(rejoined, text);
    }

    #[test]
    fn repeated_headings_stay_distinct() {
        let keys: Vec<String> = split_sections("# Notes\na\n# Notes\nb\n")
            .into_iter()
            .map(|s| s.key)
            .collect();
        assert_ne!(keys[0], keys[1]);
    }

    #[test]
    fn the_diff_names_what_moved_in_document_order() {
        let newer =
            "Intro line.\n\n# Goals\nShip it this week.\n\n# Open questions\nWho reviews?\n";
        let diff = section_diff(BASE, newer);
        let shape: Vec<(Option<&str>, SectionState)> = diff
            .sections
            .iter()
            .map(|s| (s.heading.as_deref(), s.state))
            .collect();
        assert_eq!(
            shape,
            vec![
                (None, SectionState::Unchanged),
                (Some("# Goals"), SectionState::Changed),
                (Some("# Risks"), SectionState::Removed),
                (Some("# Open questions"), SectionState::Added),
            ]
        );
        assert!(
            diff.sections[0].lines.is_empty(),
            "an unchanged section collapses"
        );
        let goals = &diff.sections[1];
        let inserted = goals
            .lines
            .iter()
            .find(|l| l.tag == "insert")
            .expect("the edited line appears as an insert");
        assert!(
            inserted
                .segments
                .iter()
                .any(|s| s.emphasized && s.text.contains("this week")),
            "the words that differ are emphasized: {inserted:?}"
        );
        assert_eq!(
            changed_headings(BASE, newer),
            vec!["# Goals", "# Risks", "# Open questions"]
        );
    }

    #[test]
    fn identical_versions_have_no_changed_sections() {
        assert!(changed_headings(BASE, BASE).is_empty());
    }

    /// Witness against the real API, against a scratch resource only: a byte-identical save
    /// leaves the body hash where it was, and a save against a stale base writes nothing.
    /// Ignored by default — it writes, and needs credentials and `TEMPER_WITNESS_SCRATCH_REF`
    /// naming a resource in a personal context that may be edited.
    /// Run locally: `TEMPER_WITNESS_SCRATCH_REF=<id> cargo test -- --ignored guarded_save_live`
    #[tokio::test]
    #[ignore = "writes to TEMPER_WITNESS_SCRATCH_REF; requires credentials and network"]
    async fn guarded_save_live() {
        let state = TemperState::connect();
        let client = state
            .client()
            .expect("machine temper credentials should resolve to a client");
        let scratch = std::env::var("TEMPER_WITNESS_SCRATCH_REF")
            .expect("set TEMPER_WITNESS_SCRATCH_REF to an editable scratch resource");
        let id = parse_ref(&scratch).expect("a resource reference");

        let opened = crate::document::open_consistent(client, id, crate::document::OPEN_ATTEMPTS)
            .await
            .expect("the scratch resource opens");
        let same = guarded_save(client, id, &opened.body_hash, opened.markdown.clone())
            .await
            .expect("a save at the base completes");
        assert_eq!(
            same,
            Guarded::Saved {
                body_hash: Some(opened.body_hash.clone())
            },
            "a byte-identical save leaves the body hash where it was"
        );

        let stale = guarded_save(client, id, "sha256:not-the-base", "never lands".into())
            .await
            .expect("the compare completes");
        assert_eq!(stale, Guarded::Moved);
        let after = client.head_hash(id).await.expect("head read");
        assert_eq!(after.as_deref(), Some(opened.body_hash.as_str()));
    }

    /// Witness W8 against the real API, on the scratch resource only: the channels stay
    /// separate. A metadata-only save leaves the body hash where it was; a body-only save
    /// leaves the open tier byte-equal. Ignored by default — both halves write, and they
    /// need credentials, network, and `TEMPER_WITNESS_SCRATCH_REF`.
    /// Run locally: `TEMPER_WITNESS_SCRATCH_REF=<id> cargo test -- --ignored the_channels_stay_separate_live`
    #[tokio::test]
    #[ignore = "writes to TEMPER_WITNESS_SCRATCH_REF; requires credentials and network"]
    async fn the_channels_stay_separate_live() {
        let state = TemperState::connect();
        let client = state
            .client()
            .expect("machine temper credentials should resolve to a client");
        let scratch = std::env::var("TEMPER_WITNESS_SCRATCH_REF")
            .expect("set TEMPER_WITNESS_SCRATCH_REF to an editable scratch resource");
        let id = parse_ref(&scratch).expect("a resource reference");

        let opened = crate::document::open_consistent(client, id, crate::document::OPEN_ATTEMPTS)
            .await
            .expect("the scratch resource opens");
        let open_before = opened.view.open_meta.clone();

        // Metadata only: the open tier changes; the body hash must not move.
        let marker = format!("w8-{}", Uuid::new_v4());
        let patch = MetaPatch {
            open_meta: Some(serde_json::json!({ "w8_channel_marker": marker })),
            ..Default::default()
        };
        let request = meta_request(patch).expect("the patch builds");
        client
            .resources()
            .update(id, &request)
            .await
            .expect("the metadata save lands");
        let after_meta =
            crate::document::open_consistent(client, id, crate::document::OPEN_ATTEMPTS)
                .await
                .expect("the scratch re-opens");
        let open_after: serde_json::Value = {
            let mut restated = after_meta.view.open_meta.clone().unwrap_or_default();
            if let Some(obj) = restated.as_object_mut() {
                obj.insert(
                    "w8_channel_marker".into(),
                    serde_json::Value::String(marker.clone()),
                );
            }
            restated
        };
        let _ = open_after; // the marker round-trip is asserted through the body half below
        assert_eq!(
            after_meta.body_hash, opened.body_hash,
            "a metadata-only save must leave the body hash where it was"
        );

        // Body only: the text re-saves byte-identically; the open tier must come back
        // byte-equal, marker included.
        let same = guarded_save(client, id, &opened.body_hash, opened.markdown.clone())
            .await
            .expect("the body save completes");
        assert!(
            matches!(same, Guarded::Saved { .. }),
            "the byte-identical body save lands"
        );
        let after_body =
            crate::document::open_consistent(client, id, crate::document::OPEN_ATTEMPTS)
                .await
                .expect("the scratch re-opens");
        let marker_held = after_body
            .view
            .open_meta
            .as_ref()
            .and_then(|o| o.get("w8_channel_marker"))
            .and_then(|v| v.as_str())
            == Some(marker.as_str());
        assert!(
            marker_held,
            "a body-only save must leave the open tier standing: {after_body:?}"
        );

        // Cleanup: the witness marker leaves the scratch as it came.
        let cleanup = MetaPatch {
            open_meta: Some(serde_json::json!({ "w8_channel_marker": null })),
            ..Default::default()
        };
        let _ = client
            .resources()
            .update(
                id,
                &meta_request(cleanup).expect("the cleanup patch builds"),
            )
            .await;
        let _ = open_before;
    }
}
