//! The document room's reads.
//!
//! Opening a document records the base a later save is compared against: the text shown and the
//! `body_hash` it belongs to. Those arrive from the server as two statements with no shared
//! snapshot — the identity read that carries the hash, then the body reconstruction — so one
//! request can pair a hash with text from a different moment. The hash itself cannot be
//! recomputed here: it is a merkle over the server's chunk hashes, so the text alone does not
//! determine it.
//!
//! The open therefore reads twice: the view with its body, then the head alone. When both reads
//! carry the same hash, no body write landed between them, and the text read in between belongs
//! to that hash. When they differ, the document moved mid-open; the read is retried a bounded
//! number of times and then fails, rather than recording a base the text does not match.

use serde::Serialize;
use temper_client::error::ClientError;
use temper_client::TemperClient;
use temper_core::types::resource_view::{ResourceSection, ResourceView, SectionSet};
use uuid::Uuid;

use crate::temper::{parse_ref, unresolved_reason, TemperState};

/// How many body-then-head pairs an open tries before saying the document would not hold still.
pub const OPEN_ATTEMPTS: usize = 3;

/// Where a document's reads come from: temper in the app, a script in the witnesses.
pub(crate) trait DocSource {
    /// The view with its reconstructed body.
    async fn read_with_body(&self, id: Uuid) -> Result<ResourceView, ClientError>;
    /// The view alone — identity and `body_hash`, no body.
    async fn read_head(&self, id: Uuid) -> Result<ResourceView, ClientError>;
}

impl DocSource for TemperClient {
    async fn read_with_body(&self, id: Uuid) -> Result<ResourceView, ClientError> {
        let body: SectionSet = [ResourceSection::Body].into_iter().collect();
        self.resources().get(id, Some(&body)).await
    }

    async fn read_head(&self, id: Uuid) -> Result<ResourceView, ClientError> {
        self.resources().get(id, None).await
    }
}

/// A body and the hash it belongs to, read so the two are known to agree.
#[derive(Debug)]
pub(crate) struct ConsistentBody {
    pub view: ResourceView,
    pub markdown: String,
    pub body_hash: String,
}

#[derive(Debug)]
pub(crate) enum OpenError {
    /// A read did not complete, or found nothing the person can see.
    Read(ClientError),
    /// The server answered without a `body_hash`: there is no base to guard a save with.
    NoHash,
    /// The server answered a body request without the body.
    NoBody,
    /// Every pair of reads straddled a write.
    KeptMoving { attempts: usize },
}

/// Reads a body and its hash so they are known to belong together — see the module docs.
pub(crate) async fn open_consistent<S: DocSource>(
    source: &S,
    id: Uuid,
    attempts: usize,
) -> Result<ConsistentBody, OpenError> {
    for _ in 0..attempts {
        let view = source.read_with_body(id).await.map_err(OpenError::Read)?;
        let head = source.read_head(id).await.map_err(OpenError::Read)?;
        let (Some(first), Some(second)) = (view.body_hash.clone(), head.body_hash) else {
            return Err(OpenError::NoHash);
        };
        if first != second {
            continue;
        }
        let markdown = view.content.clone().ok_or(OpenError::NoBody)?;
        return Ok(ConsistentBody {
            view,
            markdown,
            body_hash: first,
        });
    }
    Err(OpenError::KeptMoving { attempts })
}

/// What opening a document came to. `Unresolved` is temper saying there is nothing the person
/// can see at that reference; `Failed` is the open not completing, which verifies nothing.
#[derive(Serialize, Debug)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum DocOpened {
    #[serde(rename_all = "camelCase")]
    Opened {
        id: String,
        title: String,
        doc_type: String,
        context_ref: Option<String>,
        decorated_ref: String,
        markdown: String,
        body_hash: String,
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

async fn open_one<S: DocSource>(source: &S, raw: String) -> DocOpened {
    let Some(id) = parse_ref(&raw) else {
        return DocOpened::Unresolved {
            id: raw,
            reason: "not a resource reference".into(),
        };
    };
    match open_consistent(source, id, OPEN_ATTEMPTS).await {
        Ok(opened) => DocOpened::Opened {
            id: raw,
            title: opened.view.title,
            doc_type: opened.view.doc_type_name,
            context_ref: opened.view.context_ref,
            decorated_ref: opened.view.r#ref,
            markdown: opened.markdown,
            body_hash: opened.body_hash,
        },
        Err(OpenError::Read(err)) => match unresolved_reason(&err) {
            Some(reason) => DocOpened::Unresolved {
                id: raw,
                reason: reason.into(),
            },
            None => DocOpened::Failed {
                id: raw,
                message: err.to_string(),
            },
        },
        Err(OpenError::NoHash) => DocOpened::Failed {
            id: raw,
            message: "temper did not report this document's body hash, so a save could not be \
                      checked against it"
                .into(),
        },
        Err(OpenError::NoBody) => DocOpened::Failed {
            id: raw,
            message: "temper answered without the document's body".into(),
        },
        Err(OpenError::KeptMoving { attempts }) => DocOpened::Failed {
            id: raw,
            message: format!(
                "the document changed during each of {attempts} attempts to open it; nothing \
                 was opened"
            ),
        },
    }
}

/// Opens a document by reference: its body and the hash a later save is compared against.
#[tauri::command]
pub async fn doc_open(
    state: tauri::State<'_, TemperState>,
    id: String,
) -> Result<DocOpened, String> {
    let client = state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    Ok(open_one(client, id).await)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use super::*;

    const ID: &str = "01a0e020-a6d7-7420-b924-68f5e89f354b";

    fn view(hash: Option<&str>, body: Option<&str>) -> ResourceView {
        let mut view: ResourceView = serde_json::from_value(serde_json::json!({
            "id": ID,
            "ref": format!("a-document-{ID}"),
            "title": "A document",
            "origin_uri": "",
            "kb_context_id": "01a0c426-681f-7a90-9382-64288ef57082",
            "doc_type_name": "task",
            "owner_handle": "someone",
            "owner_profile_id": "019d4add-f49d-7c43-a87d-dda470e5dd9c",
            "originator_profile_id": "019d4add-f49d-7c43-a87d-dda470e5dd9c",
            "is_active": true,
            "created": "2026-09-27T00:00:00Z",
            "updated": "2026-09-27T00:00:00Z"
        }))
        .expect("a minimal view deserializes");
        view.body_hash = hash.map(str::to_string);
        view.content = body.map(str::to_string);
        view
    }

    /// Answers each read from a script, in order, and counts what was asked.
    #[derive(Default)]
    struct Scripted {
        with_body: Mutex<VecDeque<ResourceView>>,
        heads: Mutex<VecDeque<ResourceView>>,
    }

    impl Scripted {
        fn pair(self, body_read: ResourceView, head_read: ResourceView) -> Self {
            self.with_body.lock().unwrap().push_back(body_read);
            self.heads.lock().unwrap().push_back(head_read);
            self
        }

        fn unanswered(&self) -> usize {
            self.with_body.lock().unwrap().len() + self.heads.lock().unwrap().len()
        }
    }

    impl DocSource for Scripted {
        async fn read_with_body(&self, _id: Uuid) -> Result<ResourceView, ClientError> {
            Ok(self
                .with_body
                .lock()
                .unwrap()
                .pop_front()
                .expect("scripted body read"))
        }

        async fn read_head(&self, _id: Uuid) -> Result<ResourceView, ClientError> {
            Ok(self
                .heads
                .lock()
                .unwrap()
                .pop_front()
                .expect("scripted head read"))
        }
    }

    fn id() -> Uuid {
        Uuid::parse_str(ID).unwrap()
    }

    #[tokio::test]
    async fn a_still_document_opens_on_the_first_pair() {
        let source =
            Scripted::default().pair(view(Some("h1"), Some("text one")), view(Some("h1"), None));
        let opened = open_consistent(&source, id(), OPEN_ATTEMPTS)
            .await
            .expect("opens");
        assert_eq!(opened.markdown, "text one");
        assert_eq!(opened.body_hash, "h1");
        assert_eq!(source.unanswered(), 0);
    }

    /// The bite: the body read pairs the old hash with text written after it. A single read
    /// would record `h1` as the base of `text two`; the head read exposes the move, and the
    /// retry opens on a pair that agrees.
    #[tokio::test]
    async fn a_write_between_the_reads_is_retried_not_recorded() {
        let source = Scripted::default()
            .pair(view(Some("h1"), Some("text two")), view(Some("h2"), None))
            .pair(view(Some("h2"), Some("text two")), view(Some("h2"), None));
        let opened = open_consistent(&source, id(), OPEN_ATTEMPTS)
            .await
            .expect("opens on the second pair");
        assert_eq!(opened.body_hash, "h2");
        assert_eq!(opened.markdown, "text two");
    }

    #[tokio::test]
    async fn a_document_that_keeps_moving_fails_after_the_bound() {
        let source = Scripted::default()
            .pair(view(Some("a"), Some("x")), view(Some("b"), None))
            .pair(view(Some("b"), Some("y")), view(Some("c"), None))
            .pair(view(Some("c"), Some("z")), view(Some("d"), None));
        match open_consistent(&source, id(), OPEN_ATTEMPTS).await {
            Err(OpenError::KeptMoving { attempts }) => assert_eq!(attempts, OPEN_ATTEMPTS),
            other => panic!("expected KeptMoving, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn no_hash_is_a_failure_not_an_unguarded_open() {
        let source = Scripted::default().pair(view(None, Some("text")), view(None, None));
        let opened = open_one(&source, ID.to_string()).await;
        assert!(
            matches!(opened, DocOpened::Failed { .. }),
            "an open with no base to compare against must not read as opened: {opened:?}"
        );
    }

    #[tokio::test]
    async fn a_non_reference_is_unresolved_and_reads_nothing() {
        let source = Scripted::default();
        let opened = open_one(&source, "not-a-ref".to_string()).await;
        assert!(matches!(opened, DocOpened::Unresolved { .. }));
    }

    /// Witness against the real API: the consistent open agrees with a fresh head read, and the
    /// body hash is not something the desktop can recompute from the text. Ignored by default —
    /// it needs the machine's temper credentials, network, and a readable resource that is not
    /// being edited while the witness runs.
    /// Run locally: `TEMPER_WITNESS_REF=<id> cargo test -- --ignored consistent_open`
    #[tokio::test]
    #[ignore = "requires temper credentials, network, and TEMPER_WITNESS_REF"]
    async fn consistent_open_matches_a_fresh_head() {
        let state = TemperState::connect();
        let client = state
            .client()
            .expect("machine temper credentials should resolve to a client");
        let known = std::env::var("TEMPER_WITNESS_REF")
            .expect("set TEMPER_WITNESS_REF to a readable resource id");
        let id = parse_ref(&known).expect("TEMPER_WITNESS_REF is a resource reference");

        let opened = open_consistent(client, id, OPEN_ATTEMPTS)
            .await
            .expect("a quiet document opens consistently");
        let head = client.read_head(id).await.expect("head read");
        assert_eq!(
            head.body_hash.as_deref(),
            Some(opened.body_hash.as_str()),
            "the recorded base is the document's current hash"
        );

        let local = temper_core::hash::compute_body_hash(&opened.markdown);
        let local_hex = local.strip_prefix("sha256:").unwrap_or(&local);
        assert_ne!(
            local_hex, opened.body_hash,
            "the body hash is the server's chunk merkle, not a hash of the text; if this ever \
             holds, a local hash could replace the second read"
        );
    }
}
