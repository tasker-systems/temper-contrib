//! The webview's side of a presented view: the answer that resolves a
//! parked presentation. The webview has already run `checkSpec` — the one
//! gate — and says rendered or refused with its reasons. A rendered answer
//! is recorded before it resolves (checkSpec → commit → resolve), so nothing
//! mounts unrecorded: a record that fails turns the render into a refusal.

use std::future::Future;

use crate::acp::AcpState;
use crate::present_board::{PresentOutcome, Presentation, PresentationBoard};

/// Resolves one parked presentation with the webview's answer. `commit`
/// records a rendered view from the facts the board holds — the agent's own
/// spec, never a copy handed back — and runs while the presentation stays
/// parked, so a close or the bound can still end it mid-commit. Open: with a
/// real record, that leaves a recorded view whose agent was told refused —
/// against the ruling that refused presentations are not recorded. The
/// record's build rules how (hold the bound off a committing entry, or undo
/// a record whose resolve fails); the no-op below cannot yet reach it.
pub async fn answer<C, F>(
    board: &PresentationBoard,
    conversation_id: &str,
    presented_id: &str,
    rendered: bool,
    reasons: Vec<String>,
    commit: C,
) -> Result<(), String>
where
    C: FnOnce(Presentation) -> F,
    F: Future<Output = Result<(), String>>,
{
    let outcome = if rendered {
        let presentation = board.presentation(conversation_id, presented_id)?;
        match commit(presentation).await {
            Ok(()) => PresentOutcome::Rendered,
            Err(e) => PresentOutcome::refused(vec![format!(
                "the view was checked but its temper record failed — {e}"
            )]),
        }
    } else if reasons.is_empty() {
        PresentOutcome::refused(vec![
            "the desktop refused the view without naming a reason".to_string()
        ])
    } else {
        PresentOutcome::refused(reasons)
    };
    board.resolve(conversation_id, presented_id, outcome)
}

/// The record a rendered view is committed as. Declared hole: the
/// `desktop-presented-view` family and its commit are not built yet; until
/// they are, a rendered view is resolved unrecorded — and nothing mounts it
/// yet either, since presented views do not open as tabs yet.
async fn record_presentation(_presentation: Presentation) -> Result<(), String> {
    Ok(())
}

/// The webview's answer to a presented view: `rendered` when checkSpec
/// passed, else `refused` with checkSpec's errors as the reasons.
#[tauri::command]
pub async fn present_answer(
    state: tauri::State<'_, AcpState>,
    conversation_id: String,
    presented_id: String,
    rendered: bool,
    reasons: Vec<String>,
) -> Result<(), String> {
    let board = state.present_board.clone();
    answer(
        &board,
        &conversation_id,
        &presented_id,
        rendered,
        reasons,
        record_presentation,
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::present_board::{PresentNotice, PresentSink, ANSWER_BOUND};

    /// Parks one presentation on a surfaced board and returns the board,
    /// the parked call, and its id.
    async fn parked() -> (
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
                            spec: json!({ "root": "a", "elements": {} }),
                        },
                        &sink,
                        ANSWER_BOUND,
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

    #[tokio::test]
    async fn a_checked_view_is_recorded_from_the_agent_s_spec_then_rendered() {
        let (board, call, id) = parked().await;
        let committed: Arc<Mutex<Option<serde_json::Value>>> = Arc::default();
        let seen = committed.clone();
        answer(&board, "c1", &id, true, vec![], |p| async move {
            *seen.lock().unwrap() = Some(p.spec);
            Ok(())
        })
        .await
        .expect("the answer lands");
        assert_eq!(call.await.unwrap(), PresentOutcome::Rendered);
        assert_eq!(
            committed.lock().unwrap().clone(),
            Some(json!({ "root": "a", "elements": {} })),
            "the record is the spec the agent sent"
        );
    }

    #[tokio::test]
    async fn a_failed_record_turns_the_render_into_a_named_refusal() {
        let (board, call, id) = parked().await;
        answer(&board, "c1", &id, true, vec![], |_| async {
            Err("temper unreachable".to_string())
        })
        .await
        .expect("the refusal lands");
        assert_eq!(
            call.await.unwrap(),
            PresentOutcome::refused(vec![
                "the view was checked but its temper record failed — temper unreachable"
                    .to_string()
            ])
        );
    }

    #[tokio::test]
    async fn a_refusal_carries_checkspec_s_reasons_and_records_nothing() {
        let (board, call, id) = parked().await;
        let reasons = vec!["elements/a/props: Unrecognized key: \"colour\"".to_string()];
        answer(&board, "c1", &id, false, reasons.clone(), |_| async {
            panic!("a refused view is never recorded")
        })
        .await
        .expect("the refusal lands");
        assert_eq!(call.await.unwrap(), PresentOutcome::refused(reasons));
    }

    #[tokio::test]
    async fn an_answer_for_an_ended_presentation_is_an_error() {
        let (board, call, id) = parked().await;
        board.close("c1");
        call.await.unwrap();
        assert!(
            answer(&board, "c1", &id, false, vec!["x".to_string()], |_| async {
                Ok(())
            })
            .await
            .is_err()
        );
    }
}
