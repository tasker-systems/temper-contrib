//! Creating a document in the document room.
//!
//! Create is metadata-only by server ruling: the body is never sendable here —
//! it rides the guarded `doc_save_body` path once the document exists — and the
//! server's shared pipeline fills the managed tier on receive (a task lands in
//! `backlog`, a goal in `active`, the provenance trio, a slug from the title)
//! and stamps the create `user-created`. What this sends is the title, the doc
//! type and the context, plus a per-invocation idempotency key.
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

use crate::temper::{parse_ref, TemperState};

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

/// Creates the document and answers what came of it.
pub(crate) async fn create_document<S: DocSink>(
    sink: &S,
    context_ref: &str,
    doc_type: &str,
    title: &str,
    idempotency_key: Uuid,
) -> DocCreated {
    let Some(context_id) = parse_ref(context_ref) else {
        return DocCreated::Refused {
            reason: "not a context reference".into(),
            idempotency_key,
        };
    };
    let request = create_request(context_id, doc_type, title, idempotency_key);
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
                DocCreated::Refused {
                    reason: err.to_string(),
                    idempotency_key,
                }
            }
        }
    }
}

/// Creates a document: its title, doc type and context — nothing else. The
/// body and the open tier ride later, guarded calls.
#[tauri::command]
pub async fn doc_create(
    state: tauri::State<'_, TemperState>,
    context_id: String,
    doc_type: String,
    title: String,
) -> Result<DocCreated, String> {
    let client = state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    Ok(create_document(client, &context_id, &doc_type, &title, Uuid::new_v4()).await)
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

    /// What the scripted sink answers.
    enum Answer {
        /// The server answered no: a permission refusal.
        Forbidden,
        /// The request never completed: the connection was refused.
        Transport,
    }

    /// Answers every create with the scripted outcome and counts what was asked.
    struct Scripted {
        answer: Answer,
        calls: Mutex<usize>,
    }

    impl Scripted {
        fn answering(answer: Answer) -> Self {
            Scripted {
                answer,
                calls: Mutex::new(0),
            }
        }

        fn calls(&self) -> usize {
            *self.calls.lock().unwrap()
        }
    }

    impl DocSink for Scripted {
        async fn create(
            &self,
            _request: &ResourceCreateRequest,
        ) -> Result<ResourceView, ClientError> {
            *self.calls.lock().unwrap() += 1;
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
        let answer = create_document(&sink, CONTEXT, "session", "A fresh document", key()).await;
        assert_eq!(
            answer,
            DocCreated::Refused {
                reason: "forbidden".into(),
                idempotency_key: key(),
            }
        );
        assert_eq!(
            sink.calls(),
            1,
            "the refusal came from the create call itself"
        );
    }

    /// The bite: a transport error is not a refusal — the request did not
    /// complete, so nothing is known either way. The failed arm carries the
    /// key: a retried create reusing it converges on whatever landed.
    #[tokio::test]
    async fn a_transport_failure_lands_in_the_failed_arm_with_its_key() {
        let sink = Scripted::answering(Answer::Transport);
        let answer = create_document(&sink, CONTEXT, "session", "A fresh document", key()).await;
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
        let answer =
            create_document(&sink, "not a context", "session", "A fresh document", key()).await;
        assert_eq!(
            answer,
            DocCreated::Refused {
                reason: "not a context reference".into(),
                idempotency_key: key(),
            }
        );
        assert_eq!(sink.calls(), 0, "nothing went on the wire");
    }
}
