use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SessionNotification, SessionUpdate,
    TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo, Error};
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot};

/// One streamed notification from a live agent, as the UI receives it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpEvent {
    pub conversation_id: String,
    pub session_id: String,
    pub update: SessionUpdate,
}

/// Receives streamed agent output. The app wires this to Tauri events;
/// witnesses record instead, so the conversation loop is testable without
/// a running app.
pub type EventSink = Arc<dyn Fn(AcpEvent) + Send + Sync>;

pub enum ConversationCommand {
    Prompt {
        text: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
}

/// What the conversation loop reports once the handshake and session
/// creation are done.
struct ConversationReady {
    session_id: String,
    agent_info: serde_json::Value,
}

#[derive(Clone)]
struct ConversationHandle {
    commands: mpsc::UnboundedSender<ConversationCommand>,
}

/// Live ACP conversations held open across prompts. An entry exists from the
/// moment a conversation signals ready until it is closed or its agent dies.
#[derive(Default)]
pub struct AcpState {
    next_id: AtomicU64,
    conversations: Mutex<HashMap<String, ConversationHandle>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationInfo {
    pub conversation_id: String,
    pub session_id: String,
    pub agent_info: serde_json::Value,
}

/// Spawns an ACP agent subprocess, completes the `initialize` handshake,
/// creates one session in the given working directory, and holds the
/// connection open for the conversation. Prompts are routed into the live
/// session by [`acp_prompt`].
///
/// The working directory is the agent's project root; agents do real work
/// scoped to it at session creation, so it must be a real, small directory —
/// pointing one at `$HOME` makes `session/new` effectively never return.
#[tauri::command]
pub async fn acp_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AcpState>,
    command: String,
    cwd: String,
) -> Result<ConversationInfo, String> {
    let agent = AcpAgent::from_str(&command).map_err(|e| e.to_string())?;
    let cwd = expand_cwd(&cwd)?;

    let conversation_id = format!("conversation-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let (commands, command_rx) = mpsc::unbounded_channel::<ConversationCommand>();
    let (ready_tx, ready_rx) = oneshot::channel::<Result<ConversationReady, String>>();

    let sink: EventSink = {
        let app = app.clone();
        Arc::new(move |event| {
            let _ = app.emit("acp-update", event);
        })
    };

    let connection = Client
        .builder()
        .on_receive_notification(
            {
                let sink = sink.clone();
                let conversation_id = conversation_id.clone();
                async move |notification: SessionNotification, _cx| {
                    sink(AcpEvent {
                        conversation_id: conversation_id.clone(),
                        session_id: notification.session_id.to_string(),
                        update: notification.update,
                    });
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async |request: RequestPermissionRequest, responder, _connection| {
                // The skeleton never approves anything on the person's behalf;
                // a permission request with no UI to ask in is declined.
                eprintln!("acp: declining permission request {request:?}");
                responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, move |connection: ConnectionTo<Agent>| {
            run_conversation(connection, command_rx, ready_tx, cwd)
        });

    // The connection future outlives this command; the conversation loop keeps
    // it alive until the channel closes or the agent dies. A handshake that
    // never answers must not leave the UI spinning forever — timing out here
    // drops the command channel, which ends the loop and shuts the agent down.
    tokio::spawn(connection);
    let info = tokio::time::timeout(READY_TIMEOUT, ready_rx)
        .await
        .map_err(|_| "agent did not answer the handshake within 60s".to_string())?
        .map_err(|_| "conversation ended before it was ready".to_string())??;

    state.conversations.lock().unwrap().insert(
        conversation_id.clone(),
        ConversationHandle { commands },
    );
    Ok(ConversationInfo {
        conversation_id,
        session_id: info.session_id,
        agent_info: info.agent_info,
    })
}

async fn run_conversation(
    connection: ConnectionTo<Agent>,
    mut commands: mpsc::UnboundedReceiver<ConversationCommand>,
    ready: oneshot::Sender<Result<ConversationReady, String>>,
    cwd: PathBuf,
) -> Result<(), Error> {
    let init = connection
        .send_request(InitializeRequest::new(ProtocolVersion::V1))
        .block_task()
        .await?;
    let agent_info = serde_json::to_value(&init)
        .map_err(|e| agent_client_protocol::util::internal_error(e.to_string()))?;

    let new_session = connection
        .send_request(NewSessionRequest::new(cwd))
        .block_task()
        .await?;
    let session_id = new_session.session_id.clone();

    let _ = ready.send(Ok(ConversationReady {
        session_id: session_id.to_string(),
        agent_info,
    }));

    while let Some(command) = commands.recv().await {
        match command {
            ConversationCommand::Prompt { text, reply } => {
                let result = connection
                    .send_request(PromptRequest::new(
                        session_id.clone(),
                        vec![ContentBlock::Text(TextContent::new(text))],
                    ))
                    .block_task()
                    .await;
                let _ = reply.send(match result {
                    Ok(response) => Ok(stop_reason_string(&response.stop_reason)),
                    Err(e) => Err(e.to_string()),
                });
            }
        }
    }
    Ok(())
}

/// Dropping the sender ends the conversation loop, which completes the
/// connection future and shuts the agent process down.
#[tauri::command]
pub fn acp_close(state: tauri::State<'_, AcpState>, conversation_id: String) -> Result<(), String> {
    state
        .conversations
        .lock()
        .unwrap()
        .remove(&conversation_id)
        .map(|_| ())
        .ok_or_else(|| format!("unknown conversation {conversation_id}"))
}

/// Sends a prompt into a live conversation and waits for the turn to end.
/// Streamed output arrives as `acp-update` events, not in this reply.
#[tauri::command]
pub async fn acp_prompt(
    state: tauri::State<'_, AcpState>,
    conversation_id: String,
    text: String,
) -> Result<String, String> {
    let commands = {
        let conversations = state.conversations.lock().unwrap();
        conversations
            .get(&conversation_id)
            .map(|handle| handle.commands.clone())
            .ok_or_else(|| format!("unknown conversation {conversation_id}"))?
    };

    let (reply_tx, reply_rx) = oneshot::channel();
    if commands
        .send(ConversationCommand::Prompt {
            text,
            reply: reply_tx,
        })
        .is_err()
    {
        // The conversation loop is gone; drop the stale handle so the next
        // prompt names the real problem instead of a dead channel.
        state.conversations.lock().unwrap().remove(&conversation_id);
        return Err("conversation has ended".to_string());
    }

    reply_rx
        .await
        .map_err(|_| "conversation ended before the turn completed".to_string())?
}

fn stop_reason_string(reason: &agent_client_protocol::schema::v1::StopReason) -> String {
    match serde_json::to_value(reason) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(e) => format!("<unserializable: {e}>"),
    }
}

const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// Resolves the conversation's working directory. `~` expands to the home
/// directory; the path must be an existing directory.
fn expand_cwd(spec: &str) -> Result<PathBuf, String> {
    let trimmed = spec.trim();
    let path = if trimmed == "~" {
        std::env::home_dir().ok_or_else(|| "home directory cannot be resolved".to_string())?
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        std::env::home_dir()
            .ok_or_else(|| "home directory cannot be resolved".to_string())?
            .join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    if !path.is_dir() {
        return Err(format!(
            "working directory is not an existing directory: {}",
            path.display()
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::AcpAgentConfig;

    type Recorded = Arc<Mutex<Vec<AcpEvent>>>;

    fn recording_sink() -> (EventSink, Recorded) {
        let recorded: Recorded = Arc::default();
        let sink: EventSink = {
            let recorded = recorded.clone();
            Arc::new(move |event| recorded.lock().unwrap().push(event))
        };
        (sink, recorded)
    }

    /// A small real directory for the witnesses — agents do work scoped to
    /// the working directory at session creation, so `$HOME` would hang them.
    fn witness_cwd() -> PathBuf {
        let dir = std::env::temp_dir().join("temper-desktop-acp-witness");
        std::fs::create_dir_all(&dir).expect("witness scratch directory");
        dir
    }

    /// The witness agent runs against a clean user-level config: agents
    /// inherit the operator's personal agent configuration otherwise, and a
    /// witness that inherits it is not reproducible. Auth is unaffected — it
    /// lives in the data directory, not the config directory.
    fn opencode_witness_agent() -> AcpAgent {
        let config_dir = std::env::temp_dir().join("temper-desktop-acp-witness-config");
        std::fs::create_dir_all(&config_dir).expect("witness config directory");
        AcpAgent::new(
            AcpAgentConfig::new("opencode")
                .arg("acp")
                .env("XDG_CONFIG_HOME", config_dir.to_string_lossy().as_ref()),
        )
    }

    /// Starts a conversation the way [`acp_start`] does, with a recording
    /// sink instead of Tauri events, and returns the handles the test drives
    /// prompts with.
    async fn start_test_conversation(
        agent: AcpAgent,
    ) -> (
        mpsc::UnboundedSender<ConversationCommand>,
        Recorded,
        ConversationReady,
    ) {
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let (sink, recorded) = recording_sink();

        let connection = Client
            .builder()
            .on_receive_notification(
                {
                    let sink = sink.clone();
                    async move |notification: SessionNotification, _cx| {
                        sink(AcpEvent {
                            conversation_id: "test-conversation".to_string(),
                            session_id: notification.session_id.to_string(),
                            update: notification.update,
                        });
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async |request: RequestPermissionRequest, responder, _connection| {
                    eprintln!("acp: declining permission request {request:?}");
                    responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Cancelled,
                    ))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(agent, move |connection: ConnectionTo<Agent>| {
                run_conversation(connection, command_rx, ready_tx, witness_cwd())
            });
        tokio::spawn(connection);

        let info = ready_rx
            .await
            .expect("ready signal should arrive")
            .expect("conversation should become ready");
        (commands, recorded, info)
    }

    async fn prompt(
        commands: &mpsc::UnboundedSender<ConversationCommand>,
        text: &str,
    ) -> String {
        let (reply_tx, reply_rx) = oneshot::channel();
        commands
            .send(ConversationCommand::Prompt {
                text: text.to_string(),
                reply: reply_tx,
            })
            .expect("conversation should still be open");
        reply_rx
            .await
            .expect("prompt reply should arrive")
            .expect("prompt round-trip should succeed")
    }

    fn streamed_chunks(recorded: &Recorded) -> Vec<String> {
        recorded
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match &event.update {
                SessionUpdate::AgentMessageChunk(chunk) => match &chunk.content {
                    ContentBlock::Text(text) => Some(text.text.clone()),
                    _ => None,
                },
                _ => None,
            })
            .collect()
    }

    /// Witness for the conversation clause: one `opencode acp` process serves
    /// initialize, session creation, and three prompts — the answer streams
    /// as agent message chunks rather than arriving whole at turn end, and
    /// later turns see earlier ones. Ignored by default — it needs the agent
    /// binary. Run locally: `cargo test -p desktop-lib -- --ignored`
    ///
    /// The connection requires a multi-thread runtime: on current-thread
    /// tokio, responses arrive but notifications are never dispatched.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires opencode on PATH"]
    async fn opencode_answers_prompts_on_one_live_conversation() {
        let (commands, recorded, info) =
            start_test_conversation(opencode_witness_agent()).await;
        assert!(!info.session_id.is_empty(), "agent should create a session");

        let first = prompt(&commands, "Reply with exactly: OK").await;
        assert_eq!(first, "end_turn", "the first turn should end normally");

        let streamed = prompt(
            &commands,
            "Write three sentences about why the sea is blue.",
        )
        .await;
        assert_eq!(streamed, "end_turn", "the second turn should end normally");

        let recalled = prompt(
            &commands,
            "What exactly did I ask you to reply with in your first answer?",
        )
        .await;
        assert_eq!(recalled, "end_turn", "the third turn should end normally");

        let chunks = streamed_chunks(&recorded);
        assert!(
            chunks.concat().to_uppercase().contains("OK"),
            "the streamed answer should carry the first reply, got: {chunks:?}"
        );
        assert!(
            chunks.len() > 1,
            "the prose answer should stream incrementally, not as one blob, got: {chunks:?}"
        );
    }

    /// Witness for the second agent: the real npm adapter
    /// (`@zed-industries/claude-code-acp`; the name `claude-agent-acp` in the
    /// task body does not exist on npm) answers initialize and one prompt
    /// through the same conversation path. Requires `claude` auth on this
    /// machine. Run locally: `cargo test -p desktop-lib -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires npx and local claude auth"]
    async fn claude_code_answers_a_prompt() {
        let (commands, recorded, info) =
            start_test_conversation(
                AcpAgent::from_str("npx -y @zed-industries/claude-code-acp")
                    .expect("agent command should parse"),
            )
            .await;
        assert!(!info.session_id.is_empty(), "agent should create a session");

        let stop_reason = prompt(&commands, "Reply with exactly: OK").await;
        assert_eq!(stop_reason, "end_turn", "the turn should end normally");

        let chunks = streamed_chunks(&recorded);
        assert!(
            chunks.concat().to_uppercase().contains("OK"),
            "the agent's streamed answer should reply OK, got: {chunks:?}"
        );
    }
}
