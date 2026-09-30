//! The presentation board: every presented view parked between the agent's
//! tool call and the webview's answer. Mirrors [`crate::acp::AskBoard`] with
//! one ruled difference — a presentation parks only until the *webview*
//! answers, never on a person. The webview checks the spec and answers at
//! once; a bounded wait catches a webview that never does, so a turn never
//! waits on anyone.
//!
//! Exactly-once is structural: the parked [`PresentationBoard::present`] is
//! the only place a resolution is emitted. Every other path — the answer, a
//! released surface, a closed conversation, the bound — only delivers an
//! outcome to it.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::oneshot;

/// How long a parked presentation waits for the webview. The fast path is
/// sub-second (a synchronous check, then one command); the bound is the
/// dead-webview valve, and running out of it is a refusal, never a render.
pub const ANSWER_BOUND: Duration = Duration::from_secs(10);

/// How many presentations one conversation may have waiting on the webview
/// at once. Each holds its spec until answered; past the bound a
/// presentation is refused at once rather than held.
pub const MAX_PARKED: usize = 8;

/// How a presentation ended, as the agent's tool result and the webview's
/// resolution notice both carry it. `rendered` means checked and mounted as
/// its own tab — never that the person has seen it. A refusal always names
/// the catalog version.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "ok", rename_all = "camelCase")]
pub enum PresentOutcome {
    Rendered,
    #[serde(rename_all = "camelCase")]
    Refused {
        catalog_version: String,
        reasons: Vec<String>,
    },
}

impl PresentOutcome {
    /// A refusal naming the bundled catalog's version and the given reasons.
    pub fn refused(reasons: Vec<String>) -> Self {
        Self::Refused {
            catalog_version: crate::present_server::catalog_version(),
            reasons,
        }
    }
}

/// What the webview is told about a presentation: the spec to check, then
/// exactly one resolution. The spec is the agent's own, verbatim.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PresentNotice {
    #[serde(rename_all = "camelCase")]
    Presented {
        conversation_id: String,
        presented_id: String,
        /// The presenting agent, as its own init answer named itself.
        agent: String,
        spec: serde_json::Value,
    },
    #[serde(rename_all = "camelCase")]
    Resolved {
        conversation_id: String,
        presented_id: String,
        outcome: PresentOutcome,
    },
}

/// Receives [`PresentNotice`]s. The app wires this to Tauri events;
/// witnesses record, or answer in the webview's place.
pub type PresentSink = Arc<dyn Fn(PresentNotice) + Send + Sync>;

/// One parked presentation's facts, as an answer's commit reads them — the
/// spec the agent sent, held here so what is recorded is what was presented,
/// never a copy the webview hands back.
#[derive(Clone, Debug)]
pub struct Presentation {
    pub agent: String,
    pub spec: serde_json::Value,
}

struct Parked {
    conversation_id: String,
    presentation: Presentation,
    sender: oneshot::Sender<PresentOutcome>,
}

#[derive(Default)]
struct BoardInner {
    next_id: AtomicU64,
    surfaces: Mutex<HashSet<String>>,
    pending: Mutex<HashMap<String, Parked>>,
}

/// Owns every parked presentation. The surface is the conversation's
/// existing room claim — the one `acp_ask_surface` records — fanned to this
/// board too; no second claim is minted.
#[derive(Clone, Default)]
pub struct PresentationBoard {
    inner: Arc<BoardInner>,
}

impl PresentationBoard {
    /// Marks whether the conversation's room is mounted to check and mount a
    /// view. Releasing the surface refuses what is parked: nothing is left
    /// that could answer it.
    pub fn set_surface(&self, conversation_id: &str, present: bool) {
        if present {
            self.inner
                .surfaces
                .lock()
                .unwrap()
                .insert(conversation_id.to_string());
            return;
        }
        self.inner.surfaces.lock().unwrap().remove(conversation_id);
        self.refuse_parked_of(
            conversation_id,
            "the room closed before the view was checked",
        );
    }

    /// Ends the conversation's presenting for good: the surface goes, and
    /// every parked presentation is refused as ended.
    pub fn close(&self, conversation_id: &str) {
        self.inner.surfaces.lock().unwrap().remove(conversation_id);
        self.refuse_parked_of(conversation_id, "conversation ended");
    }

    fn refuse_parked_of(&self, conversation_id: &str, reason: &str) {
        let refused: Vec<Parked> = {
            let mut pending = self.inner.pending.lock().unwrap();
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, p)| p.conversation_id == conversation_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| pending.remove(id)).collect()
        };
        for parked in refused {
            let _ = parked
                .sender
                .send(PresentOutcome::refused(vec![reason.to_string()]));
        }
    }

    /// Receives one presentation. Parks it while the conversation has a
    /// surface, then tells the webview — parked first, so an answer can never
    /// arrive for an entry not yet there; the notice still precedes the
    /// resolution. Without a surface the end is a refusal, still announced
    /// and still resolved.
    pub async fn present(
        &self,
        conversation_id: &str,
        presentation: Presentation,
        sink: &PresentSink,
        bound: Duration,
    ) -> PresentOutcome {
        let presented_id = format!(
            "presented-{}",
            self.inner.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let notice = PresentNotice::Presented {
            conversation_id: conversation_id.to_string(),
            presented_id: presented_id.clone(),
            agent: presentation.agent.clone(),
            spec: presentation.spec.clone(),
        };

        // The surface check and the park are one critical section: a surface
        // released between them must refuse this presentation, not strand it.
        let parked = {
            let mut pending = self.inner.pending.lock().unwrap();
            let waiting = pending
                .values()
                .filter(|p| p.conversation_id == conversation_id)
                .count();
            if waiting >= MAX_PARKED {
                Err("too many views are already waiting to be checked")
            } else if self
                .inner
                .surfaces
                .lock()
                .unwrap()
                .contains(conversation_id)
            {
                let (tx, rx) = oneshot::channel();
                pending.insert(
                    presented_id.clone(),
                    Parked {
                        conversation_id: conversation_id.to_string(),
                        presentation,
                        sender: tx,
                    },
                );
                Ok(rx)
            } else {
                Err("no surface to render into")
            }
        };
        sink(notice);

        let outcome = match parked {
            Err(reason) => PresentOutcome::refused(vec![reason.to_string()]),
            Ok(mut rx) => match tokio::time::timeout(bound, &mut rx).await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(_)) => PresentOutcome::refused(vec!["conversation ended".to_string()]),
                Err(_) => {
                    // Out of time. Withdraw the entry; if it is already gone,
                    // an answer or a close took it and its outcome is in flight
                    // on the channel — that outcome wins, not the bound.
                    let withdrawn = self.inner.pending.lock().unwrap().remove(&presented_id);
                    match withdrawn {
                        Some(_) => {
                            PresentOutcome::refused(vec!["the desktop did not answer".to_string()])
                        }
                        None => rx.await.unwrap_or_else(|_| {
                            PresentOutcome::refused(vec!["conversation ended".to_string()])
                        }),
                    }
                }
            },
        };
        sink(PresentNotice::Resolved {
            conversation_id: conversation_id.to_string(),
            presented_id,
            outcome: outcome.clone(),
        });
        outcome
    }

    /// The parked presentation's facts, for the answer's commit — read, not
    /// taken: it stays parked, and so answerable by a close or the bound,
    /// while the commit runs.
    pub fn presentation(
        &self,
        conversation_id: &str,
        presented_id: &str,
    ) -> Result<Presentation, String> {
        let pending = self.inner.pending.lock().unwrap();
        let parked = pending
            .get(presented_id)
            .ok_or_else(|| format!("unknown presentation {presented_id}"))?;
        if parked.conversation_id != conversation_id {
            return Err(format!(
                "presentation {presented_id} does not belong to {conversation_id}"
            ));
        }
        Ok(parked.presentation.clone())
    }

    /// Delivers the webview's outcome to the parked presentation it names.
    /// An entry already ended (closed, timed out) is an error the caller
    /// relays; its resolution was already emitted.
    pub fn resolve(
        &self,
        conversation_id: &str,
        presented_id: &str,
        outcome: PresentOutcome,
    ) -> Result<(), String> {
        let mut pending = self.inner.pending.lock().unwrap();
        let parked = pending
            .remove(presented_id)
            .ok_or_else(|| format!("unknown presentation {presented_id}"))?;
        if parked.conversation_id != conversation_id {
            pending.insert(presented_id.to_string(), parked);
            return Err(format!(
                "presentation {presented_id} does not belong to {conversation_id}"
            ));
        }
        let _ = parked.sender.send(outcome);
        Ok(())
    }

    /// A guard that closes the conversation's presenting when dropped — so
    /// the conversation loop's end, on either arm (awaited to completion, or
    /// dropped with the connection future when the agent dies), refuses what
    /// is parked instead of leaving it to the bound.
    pub fn closer(&self, conversation_id: &str) -> BoardCloser {
        BoardCloser {
            board: self.clone(),
            conversation_id: conversation_id.to_string(),
        }
    }
}

pub struct BoardCloser {
    board: PresentationBoard,
    conversation_id: String,
}

impl Drop for BoardCloser {
    fn drop(&mut self) {
        self.board.close(&self.conversation_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    type Notices = Arc<Mutex<Vec<PresentNotice>>>;

    fn recording_sink() -> (PresentSink, Notices) {
        let notices: Notices = Arc::default();
        let record = notices.clone();
        (Arc::new(move |n| record.lock().unwrap().push(n)), notices)
    }

    fn a_presentation() -> Presentation {
        Presentation {
            agent: "witness-agent".to_string(),
            spec: json!({ "root": "a", "elements": {} }),
        }
    }

    fn resolutions(notices: &Notices) -> Vec<PresentOutcome> {
        notices
            .lock()
            .unwrap()
            .iter()
            .filter_map(|n| match n {
                PresentNotice::Resolved { outcome, .. } => Some(outcome.clone()),
                _ => None,
            })
            .collect()
    }

    /// Waits until the board has announced a presentation, returning its id.
    async fn wait_presented(notices: &Notices) -> String {
        for _ in 0..200 {
            let found = notices.lock().unwrap().iter().find_map(|n| match n {
                PresentNotice::Presented { presented_id, .. } => Some(presented_id.clone()),
                _ => None,
            });
            if let Some(id) = found {
                return id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no presentation was announced");
    }

    fn reasons_of(outcome: &PresentOutcome) -> Vec<String> {
        match outcome {
            PresentOutcome::Refused { reasons, .. } => reasons.clone(),
            PresentOutcome::Rendered => panic!("expected a refusal, got rendered"),
        }
    }

    #[tokio::test]
    async fn with_no_surface_it_refuses_announced_and_resolved_once() {
        let board = PresentationBoard::default();
        let (sink, notices) = recording_sink();
        let outcome = board
            .present("c1", a_presentation(), &sink, ANSWER_BOUND)
            .await;
        assert_eq!(reasons_of(&outcome), vec!["no surface to render into"]);
        let recorded = notices.lock().unwrap().clone();
        assert!(
            matches!(recorded.first(), Some(PresentNotice::Presented { .. })),
            "the notice precedes the resolution"
        );
        assert_eq!(resolutions(&notices), vec![outcome]);
    }

    #[tokio::test]
    async fn the_webview_s_answer_resolves_it_exactly_once() {
        let board = PresentationBoard::default();
        board.set_surface("c1", true);
        let (sink, notices) = recording_sink();
        let parked = {
            let board = board.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                board
                    .present("c1", a_presentation(), &sink, ANSWER_BOUND)
                    .await
            })
        };
        let id = wait_presented(&notices).await;
        let read = board.presentation("c1", &id).expect("parked and readable");
        assert_eq!(
            read.spec,
            a_presentation().spec,
            "the agent's spec, verbatim"
        );
        board
            .resolve("c1", &id, PresentOutcome::Rendered)
            .expect("the answer lands");
        assert_eq!(parked.await.unwrap(), PresentOutcome::Rendered);
        assert_eq!(resolutions(&notices), vec![PresentOutcome::Rendered]);
        // A second answer finds nothing: the first one ended it.
        assert!(board.resolve("c1", &id, PresentOutcome::Rendered).is_err());
        assert_eq!(resolutions(&notices).len(), 1);
    }

    #[tokio::test]
    async fn an_answer_naming_another_conversation_is_refused_and_leaves_it_parked() {
        let board = PresentationBoard::default();
        board.set_surface("c1", true);
        let (sink, notices) = recording_sink();
        let parked = {
            let board = board.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                board
                    .present("c1", a_presentation(), &sink, ANSWER_BOUND)
                    .await
            })
        };
        let id = wait_presented(&notices).await;
        assert!(board.resolve("c2", &id, PresentOutcome::Rendered).is_err());
        assert!(board.presentation("c2", &id).is_err());
        board.resolve("c1", &id, PresentOutcome::Rendered).unwrap();
        assert_eq!(parked.await.unwrap(), PresentOutcome::Rendered);
    }

    #[tokio::test]
    async fn closing_the_conversation_refuses_a_parked_view_as_ended_once() {
        let board = PresentationBoard::default();
        board.set_surface("c1", true);
        let (sink, notices) = recording_sink();
        let parked = {
            let board = board.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                board
                    .present("c1", a_presentation(), &sink, ANSWER_BOUND)
                    .await
            })
        };
        let id = wait_presented(&notices).await;
        board.close("c1");
        // A close racing an answer: the answer finds nothing to resolve.
        assert!(board.resolve("c1", &id, PresentOutcome::Rendered).is_err());
        let outcome = parked.await.unwrap();
        assert_eq!(reasons_of(&outcome), vec!["conversation ended"]);
        assert_eq!(resolutions(&notices), vec![outcome]);
    }

    #[tokio::test]
    async fn releasing_the_surface_refuses_a_parked_view() {
        let board = PresentationBoard::default();
        board.set_surface("c1", true);
        let (sink, notices) = recording_sink();
        let parked = {
            let board = board.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                board
                    .present("c1", a_presentation(), &sink, ANSWER_BOUND)
                    .await
            })
        };
        wait_presented(&notices).await;
        board.set_surface("c1", false);
        let outcome = parked.await.unwrap();
        assert_eq!(
            reasons_of(&outcome),
            vec!["the room closed before the view was checked"]
        );
        assert_eq!(resolutions(&notices).len(), 1);
    }

    #[tokio::test]
    async fn a_webview_that_never_answers_is_refused_at_the_bound() {
        let board = PresentationBoard::default();
        board.set_surface("c1", true);
        let (sink, notices) = recording_sink();
        let outcome = board
            .present("c1", a_presentation(), &sink, Duration::from_millis(20))
            .await;
        assert_eq!(reasons_of(&outcome), vec!["the desktop did not answer"]);
        assert_eq!(resolutions(&notices), vec![outcome]);
        // The timed-out entry is withdrawn: a late answer finds nothing.
        let id = wait_presented(&notices).await;
        assert!(board.resolve("c1", &id, PresentOutcome::Rendered).is_err());
    }

    #[tokio::test]
    async fn a_dropped_closer_refuses_what_is_parked() {
        let board = PresentationBoard::default();
        board.set_surface("c1", true);
        let (sink, notices) = recording_sink();
        let closer = board.closer("c1");
        let parked = {
            let board = board.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                board
                    .present("c1", a_presentation(), &sink, ANSWER_BOUND)
                    .await
            })
        };
        wait_presented(&notices).await;
        drop(closer);
        assert_eq!(
            reasons_of(&parked.await.unwrap()),
            vec!["conversation ended"]
        );
    }

    #[tokio::test]
    async fn past_the_bound_a_presentation_is_refused_at_once() {
        let board = PresentationBoard::default();
        board.set_surface("c1", true);
        let (sink, _notices) = recording_sink();
        let mut parked = Vec::new();
        for _ in 0..MAX_PARKED {
            let board = board.clone();
            let sink = sink.clone();
            parked.push(tokio::spawn(async move {
                board
                    .present("c1", a_presentation(), &sink, ANSWER_BOUND)
                    .await
            }));
        }
        while board.inner.pending.lock().unwrap().len() < MAX_PARKED {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let over = board
            .present("c1", a_presentation(), &sink, ANSWER_BOUND)
            .await;
        assert_eq!(
            reasons_of(&over),
            vec!["too many views are already waiting to be checked"]
        );
        // Another conversation's views are not counted against this one.
        board.set_surface("c2", true);
        let other = {
            let board = board.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                board
                    .present("c2", a_presentation(), &sink, ANSWER_BOUND)
                    .await
            })
        };
        while board.inner.pending.lock().unwrap().len() < MAX_PARKED + 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        board.close("c1");
        board.close("c2");
        for p in parked {
            p.await.unwrap();
        }
        other.await.unwrap();
    }

    #[test]
    fn the_outcome_serializes_as_the_tool_result_shape() {
        assert_eq!(
            serde_json::to_value(PresentOutcome::Rendered).unwrap(),
            json!({ "ok": "rendered" })
        );
        let refused = PresentOutcome::refused(vec!["a reason".to_string()]);
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            json!({
                "ok": "refused",
                "catalogVersion": crate::present_server::catalog_version(),
                "reasons": ["a reason"]
            })
        );
    }
}
