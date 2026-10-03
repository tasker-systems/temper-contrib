//! Creating a document in the document room.
//!
//! Create is metadata-only by server ruling: the body is never sendable here —
//! it rides the guarded `doc_save_body` path once the document exists — and the
//! server's shared pipeline fills the managed tier on receive (a task lands in
//! `backlog`, a goal in `active`, the provenance trio, a slug from the title)
//! and stamps the create `user-created`. What this sends is the title, the doc
//! type and the context, plus an idempotency key: the caller's when it holds
//! one from an earlier answer, a fresh mint otherwise.
//!
//! The idempotency key is the retry story: the server dedups creates on
//! `(owner, key)`, so a network error does not mean the write failed. The
//! refused and failed answers carry the key back, and a retry that reuses it
//! converges on the already-committed resource instead of minting a duplicate.
//!
//! The open tier is not part of this call: the client's `ResourceCreateRequest`
//! carries no open-meta field, so open-tier defaults ride a metadata save
//! (`doc_save_meta`) after the create lands.

use serde::Serialize;
use temper_client::error::ClientError;
use temper_client::TemperClient;
use temper_core::types::resource_view::ResourceView;
use temper_workflow::types::resource::ResourceCreateRequest;
use uuid::Uuid;

use crate::temper::{parse_ref, unresolved_reason, TemperState};

/// What creating a document came to. `Created` is the work-record answer shape;
/// `Refused` is the server — or the local check — saying no, in one line naming
/// what failed; `Failed` is the request not completing, which verifies nothing.
/// Both carry the idempotency key: a retry that reuses it converges instead of
/// duplicating.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum DocCreated {
    #[serde(rename_all = "camelCase")]
    Created {
        id: Uuid,
        decorated_ref: String,
        title: String,
    },
    Refused {
        reason: String,
        idempotency_key: Uuid,
    },
    Failed {
        message: String,
        idempotency_key: Uuid,
    },
}

/// Where a create is sent: temper in the app, a script in the witnesses.
pub(crate) trait DocSink {
    async fn create(&self, request: &ResourceCreateRequest) -> Result<ResourceView, ClientError>;
}

impl DocSink for TemperClient {
    async fn create(&self, request: &ResourceCreateRequest) -> Result<ResourceView, ClientError> {
        self.resources().create(request).await
    }
}

/// The request a create sends: the five fields and nothing else — no managed
/// meta, no identity keys, no act authorship. The server's shared pipeline
/// fills the managed defaults and stamps `user-created` on receive.
fn create_request(
    context_id: Uuid,
    doc_type: &str,
    title: &str,
    idempotency_key: Uuid,
) -> ResourceCreateRequest {
    ResourceCreateRequest {
        kb_context_id: context_id,
        doc_type: doc_type.to_string(),
        origin_uri: String::new(),
        title: title.to_string(),
        idempotency_key: Some(idempotency_key),
        act: Default::default(),
    }
}

/// The title a create accepts: trimmed, never blank. The room is the caller,
/// but the refusal is the command's, tested here without a client — the same
/// local posture `doc_save_meta` holds its own title to and
/// `temper_context_create` its context name.
pub(crate) fn trimmed_title(title: &str) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("a title is required".to_string());
    }
    Ok(title.to_string())
}

/// Creates the document and answers what came of it. `idempotency_key` is the
/// caller's when it holds one from an earlier refused or failed answer, and a
/// fresh mint when it does not.
pub(crate) async fn create_document<S: DocSink>(
    sink: &S,
    context_ref: &str,
    doc_type: &str,
    title: &str,
    idempotency_key: Option<Uuid>,
) -> DocCreated {
    let idempotency_key = idempotency_key.unwrap_or_else(Uuid::new_v4);
    let title = match trimmed_title(title) {
        Ok(title) => title,
        Err(reason) => {
            return DocCreated::Refused {
                reason,
                idempotency_key,
            }
        }
    };
    let Some(context_id) = parse_ref(context_ref) else {
        return DocCreated::Refused {
            reason: "not a context reference".into(),
            idempotency_key,
        };
    };
    let request = create_request(context_id, doc_type, &title, idempotency_key);
    match sink.create(&request).await {
        Ok(view) => DocCreated::Created {
            id: view.id.0,
            decorated_ref: view.r#ref,
            title: view.title,
        },
        Err(err) => {
            if err.is_network() {
                // The request did not complete — which is not the same as the
                // write failing. The key comes back so a retry can converge.
                DocCreated::Failed {
                    message: err.to_string(),
                    idempotency_key,
                }
            } else {
                // The client's refusals are worded like the rest of the app's
                // (`unresolved_reason`), never the raw error — and the mapping
                // keeps the composed, disclosure-safe sentences as they are.
                DocCreated::Refused {
                    reason: unresolved_reason(&err)
                        .map(str::to_string)
                        .unwrap_or_else(|| err.to_string()),
                    idempotency_key,
                }
            }
        }
    }
}

/// Creates a document: its title, doc type and context — nothing else. The
/// body and the open tier ride later, guarded calls. `idempotencyKey` is a
/// retry's retained key; absent, a fresh one is minted per invocation.
#[tauri::command]
pub async fn doc_create(
    state: tauri::State<'_, TemperState>,
    context_id: String,
    doc_type: String,
    title: String,
    idempotency_key: Option<Uuid>,
) -> Result<DocCreated, String> {
    let client = state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    Ok(create_document(client, &context_id, &doc_type, &title, idempotency_key).await)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use temper_client::error::ClientError;
    use temper_core::types::resource_view::ResourceView;
    use temper_workflow::types::resource::ResourceCreateRequest;

    const CONTEXT: &str = "01a0c426-681f-7a90-9382-64288ef57082";
    const KEY: &str = "01a0e020-a6d7-7420-b924-68f5e89f354b";

    fn key() -> Uuid {
        Uuid::parse_str(KEY).unwrap()
    }

    #[test]
    fn a_document_create_sends_the_fields_and_nothing_else() {
        let wire = serde_json::to_value(create_request(
            Uuid::parse_str(CONTEXT).unwrap(),
            "session",
            "A fresh document",
            key(),
        ))
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "kb_context_id": CONTEXT,
                "doc_type": "session",
                "origin_uri": "",
                "title": "A fresh document",
                "idempotency_key": KEY,
            }),
            "create is metadata-only: the five fields and nothing else — no body, no \
             managed meta, no identity keys, no act authorship"
        );
    }

    /// The bite: a create invoked with a caller's key sends THAT key — the same
    /// five-field body the minted case sends, with the caller's key in the key
    /// slot. Nothing else about the wire body moves.
    #[tokio::test]
    async fn a_create_invoked_with_a_caller_key_sends_that_key() {
        let sink = Scripted::answering(Answer::Forbidden);
        create_document(&sink, CONTEXT, "session", "A fresh document", Some(key())).await;
        assert_eq!(
            sink.sent(),
            vec![serde_json::json!({
                "kb_context_id": CONTEXT,
                "doc_type": "session",
                "origin_uri": "",
                "title": "A fresh document",
                "idempotency_key": KEY,
            })],
            "the caller's key rides the five-field body and nothing else"
        );
    }

    /// The bite: a create invoked without a key mints one — the same five-field
    /// body, with a fresh key in the slot.
    #[tokio::test]
    async fn a_create_invoked_without_a_key_mints_one() {
        let sink = Scripted::answering(Answer::Forbidden);
        create_document(&sink, CONTEXT, "session", "A fresh document", None).await;
        let [wire] = sink.sent().try_into().unwrap();
        let body = wire.as_object().expect("the body is an object");
        assert_eq!(body.len(), 5, "the five fields and nothing else");
        let minted = body["idempotency_key"]
            .as_str()
            .expect("the key is a UUID string");
        assert_ne!(
            Uuid::parse_str(minted).expect("the minted key is a UUID"),
            Uuid::nil(),
            "the mint is a fresh key, not the absence of one"
        );
    }

    /// What the scripted sink answers.
    enum Answer {
        /// The server answered no: a permission refusal.
        Forbidden,
        /// The request never completed: the connection was refused.
        Transport,
    }

    /// Answers every create with the scripted outcome, counts what was asked and
    /// keeps the wire body of everything that was sent.
    struct Scripted {
        answer: Answer,
        calls: Mutex<usize>,
        sent: Mutex<Vec<serde_json::Value>>,
    }

    impl Scripted {
        fn answering(answer: Answer) -> Self {
            Scripted {
                answer,
                calls: Mutex::new(0),
                sent: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> usize {
            *self.calls.lock().unwrap()
        }

        fn sent(&self) -> Vec<serde_json::Value> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl DocSink for Scripted {
        async fn create(
            &self,
            request: &ResourceCreateRequest,
        ) -> Result<ResourceView, ClientError> {
            *self.calls.lock().unwrap() += 1;
            self.sent
                .lock()
                .unwrap()
                .push(serde_json::to_value(request).unwrap());
            Err(match self.answer {
                Answer::Forbidden => ClientError::Forbidden,
                // A real transport error, not a lookalike: the connection to a
                // dead loopback port is refused. `is_network` must see the
                // genuine article to route the failure to `Failed`.
                Answer::Transport => ClientError::Network(
                    reqwest::get("http://127.0.0.1:1/")
                        .await
                        .expect_err("a dead port refuses the connection"),
                ),
            })
        }
    }

    /// The bite: the server answered no, so nothing was created — and the
    /// answer carries the key a retry must reuse to converge instead of
    /// minting a duplicate.
    #[tokio::test]
    async fn a_client_refusal_lands_in_the_refused_arm_with_its_key() {
        let sink = Scripted::answering(Answer::Forbidden);
        let answer =
            create_document(&sink, CONTEXT, "session", "A fresh document", Some(key())).await;
        assert_eq!(
            answer,
            DocCreated::Refused {
                reason: "not visible to you".into(),
                idempotency_key: key(),
            }
        );
        assert_eq!(
            sink.calls(),
            1,
            "the refusal came from the create call itself"
        );
    }

    /// The bite: a blank title is refused before anything is sent — no sink
    /// call at all — the same local posture `doc_save_meta` holds its own
    /// title to and `temper_context_create` its context name.
    #[tokio::test]
    async fn a_blank_title_is_refused_locally_and_sends_nothing() {
        let sink = Scripted::answering(Answer::Forbidden);
        let answer = create_document(&sink, CONTEXT, "session", "   ", Some(key())).await;
        assert_eq!(
            answer,
            DocCreated::Refused {
                reason: "a title is required".into(),
                idempotency_key: key(),
            }
        );
        assert_eq!(sink.calls(), 0, "nothing went on the wire");
    }

    /// The bite: the title is sent trimmed — the room sends what its field
    /// held, the command sends what a title is.
    #[tokio::test]
    async fn a_padded_title_is_sent_trimmed() {
        let sink = Scripted::answering(Answer::Forbidden);
        create_document(
            &sink,
            CONTEXT,
            "session",
            "  A fresh document  ",
            Some(key()),
        )
        .await;
        let [wire] = sink.sent().try_into().unwrap();
        assert_eq!(
            wire["title"], "A fresh document",
            "the title rides trimmed, the five fields otherwise untouched"
        );
    }

    /// The bite: a transport error is not a refusal — the request did not
    /// complete, so nothing is known either way. The failed arm carries the
    /// key: a retried create reusing it converges on whatever landed.
    #[tokio::test]
    async fn a_transport_failure_lands_in_the_failed_arm_with_its_key() {
        let sink = Scripted::answering(Answer::Transport);
        let answer =
            create_document(&sink, CONTEXT, "session", "A fresh document", Some(key())).await;
        let DocCreated::Failed {
            message,
            idempotency_key,
        } = answer
        else {
            panic!("expected Failed, got {answer:?}")
        };
        assert_eq!(idempotency_key, key(), "the retry may reuse the key");
        assert!(
            !message.is_empty(),
            "the failure says what did not complete"
        );
    }

    /// A context that is not a reference is refused before anything is sent.
    #[tokio::test]
    async fn an_unusable_context_ref_is_refused_and_sends_nothing() {
        let sink = Scripted::answering(Answer::Forbidden);
        let answer = create_document(
            &sink,
            "not a context",
            "session",
            "A fresh document",
            Some(key()),
        )
        .await;
        assert_eq!(
            answer,
            DocCreated::Refused {
                reason: "not a context reference".into(),
                idempotency_key: key(),
            }
        );
        assert_eq!(sink.calls(), 0, "nothing went on the wire");
    }

    /// Live witness for the whole create flow, against the real API: creates a
    /// uniquely-named task in the person's context, opens it through the
    /// document room's consistent open, saves one line of markdown through the
    /// guarded save, and retires the resource. Ignored by default — it needs
    /// the machine's temper credentials and network, and it performs a real
    /// write in the person's configured context, cleaning up its own resource
    /// afterwards. Run locally: `cargo test -p desktop -- --ignored
    /// a_created_document_opens_and_saves_live`
    #[tokio::test]
    #[ignore = "requires temper credentials, network, and performs real writes"]
    async fn a_created_document_opens_and_saves_live() {
        let state = crate::temper::TemperState::connect();
        let client = state
            .client()
            .expect("machine temper credentials should resolve to a client");
        let context_name = crate::settings::DEFAULT_TEMPER_CONTEXT;
        let context_id = crate::person_context::persons_context_id(client, context_name)
            .await
            .expect("the person's context should resolve");

        let title = format!("desktop-create-witness-{}", Uuid::new_v4().simple());
        let created = create_document(client, &context_id.to_string(), "task", &title, None).await;
        let DocCreated::Created {
            id,
            decorated_ref,
            title: created_title,
        } = created
        else {
            panic!("expected Created, got {created:?}")
        };
        assert_eq!(created_title, title, "the create answers the title sent");
        assert!(
            !decorated_ref.is_empty(),
            "the create answers a decorated address"
        );

        // The created document opens through the room's read path. A fresh
        // body is an empty string, not an absence, and the server's pipeline
        // has already filled the managed tier: a fresh task is in `backlog`
        // before anyone touched it.
        let opened = crate::document::open_consistent(client, id, crate::document::OPEN_ATTEMPTS)
            .await
            .expect("the created document opens");
        assert_eq!(opened.markdown, "", "a fresh document has no body yet");
        assert_eq!(
            opened.view.managed_meta.stage.as_deref(),
            Some("backlog"),
            "the server's pipeline landed the fresh task in backlog"
        );

        // One line of markdown through the guarded save: it writes at the
        // base the open recorded, and what lands is not that base any more.
        let line = format!("{title}: one line of markdown from the witness");
        let saved = crate::document_save::guarded_save(client, id, &opened.body_hash, line)
            .await
            .expect("the guarded save completes");
        let crate::document_save::Guarded::Saved {
            body_hash: Some(landed),
        } = saved
        else {
            panic!("expected Saved, got {saved:?}")
        };
        assert_ne!(
            landed, opened.body_hash,
            "the write landed: the hash is no longer the base the open recorded"
        );

        client
            .resources()
            .delete(id, &Default::default())
            .await
            .expect("the witness cleans up after itself");
    }
}
