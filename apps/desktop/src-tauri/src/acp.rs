use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    ContentBlock, InitializeRequest, NewSessionRequest, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionConfigOption, SessionConfigOptionValue, SessionModeState, SessionNotification,
    SessionUpdate, SetSessionConfigOptionRequest, SetSessionModeRequest, TextContent,
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

/// What the ask surface is told about a permission ask: the ask itself, then
/// exactly one resolution. Every field is the agent's own declaration passed
/// through — the desktop never renames an option or restates a kind.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AskNotice {
    #[serde(rename_all = "camelCase")]
    Asked {
        conversation_id: String,
        ask_id: String,
        tool_call: serde_json::Value,
        options: serde_json::Value,
    },
    #[serde(rename_all = "camelCase")]
    Resolved {
        conversation_id: String,
        ask_id: String,
        outcome: AskResolution,
    },
}

/// How a permission ask ended: the person chose one of the agent's declared
/// options, or no one could be asked and the request was cancelled.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum AskResolution {
    #[serde(rename_all = "camelCase")]
    Selected {
        option_id: String,
    },
    Cancelled,
}

/// Receives [`AskNotice`]s. The app wires this to Tauri events; witnesses
/// record instead, so the ask machinery is testable without a running app.
pub type AskSink = Arc<dyn Fn(AskNotice) + Send + Sync>;

/// What ends a parked permission ask: the person chose a declared option, or
/// the ask was cancelled because no one could answer it.
#[derive(Debug)]
pub enum AskAnswer {
    Choose(String),
    Cancel,
}

#[derive(Default)]
struct AskBoardInner {
    next_id: AtomicU64,
    surfaces: Mutex<HashSet<String>>,
    pending: Mutex<HashMap<String, PendingAsk>>,
}

struct PendingAsk {
    conversation_id: String,
    option_ids: HashSet<String>,
    sender: oneshot::Sender<AskAnswer>,
}

/// Owns every parked permission ask. An ask parks only while its conversation
/// has an ask surface — a room mounted and able to put the question to the
/// person. Any path that ends the asking (surface released, conversation
/// closed, the person answering) resolves the outcome exactly once, and the
/// cancellation of an unanswered ask is always recorded, never dropped.
#[derive(Clone, Default)]
pub struct AskBoard {
    inner: Arc<AskBoardInner>,
}

impl AskBoard {
    /// Marks whether the conversation's room can currently put an ask to the
    /// person. Releasing the surface cancels that conversation's parked asks:
    /// with no one able to answer, waiting would only strand the agent.
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
        self.cancel_parked_of(conversation_id);
    }

    /// Ends the conversation's asking for good: drops parked asks and takes
    /// the surface with it.
    pub fn close(&self, conversation_id: &str) {
        self.inner.surfaces.lock().unwrap().remove(conversation_id);
        self.cancel_parked_of(conversation_id);
    }

    fn cancel_parked_of(&self, conversation_id: &str) {
        self.inner
            .pending
            .lock()
            .unwrap()
            .retain(|_, ask| ask.conversation_id != conversation_id);
    }

    /// Receives one permission request. Emits `Asked` with the request's own
    /// tool call and options verbatim; parks while the surface can ask, and
    /// answers `Cancel` immediately — still recorded — when it cannot.
    async fn ask(
        &self,
        conversation_id: &str,
        request: &RequestPermissionRequest,
        ask_sink: &AskSink,
    ) -> AskAnswer {
        let ask_id = format!("ask-{}", self.inner.next_id.fetch_add(1, Ordering::Relaxed));
        let notice = AskNotice::Asked {
            conversation_id: conversation_id.to_string(),
            ask_id: ask_id.clone(),
            tool_call: serde_json::to_value(&request.tool_call).unwrap_or(serde_json::Value::Null),
            options: serde_json::to_value(&request.options).unwrap_or(serde_json::Value::Null),
        };
        ask_sink(notice);

        // The surface check and the park are one critical section: a surface
        // released between them must cancel this ask, not strand it — a
        // parked ask without a surface is one no path can answer or record.
        let parked = {
            let mut pending = self.inner.pending.lock().unwrap();
            if self
                .inner
                .surfaces
                .lock()
                .unwrap()
                .contains(conversation_id)
            {
                let (tx, rx) = oneshot::channel();
                pending.insert(
                    ask_id.clone(),
                    PendingAsk {
                        conversation_id: conversation_id.to_string(),
                        option_ids: request
                            .options
                            .iter()
                            .map(|o| o.option_id.to_string())
                            .collect(),
                        sender: tx,
                    },
                );
                Some(rx)
            } else {
                None
            }
        };
        let Some(rx) = parked else {
            Self::resolved(conversation_id, &ask_id, AskResolution::Cancelled, ask_sink);
            return AskAnswer::Cancel;
        };
        match rx.await {
            Ok(AskAnswer::Choose(option_id)) => AskAnswer::Choose(option_id),
            // The board itself resolved (the person answered, or released the
            // surface / closed the conversation); `resolve` and the dropping
            // paths already recorded what happened.
            Ok(AskAnswer::Cancel) => AskAnswer::Cancel,
            Err(_) => {
                // The parked entry vanished without a resolution — the surface
                // was released or the conversation closed while waiting.
                Self::resolved(conversation_id, &ask_id, AskResolution::Cancelled, ask_sink);
                AskAnswer::Cancel
            }
        }
    }

    /// Delivers the person's answer to a parked ask. Exactly one resolution is
    /// recorded per ask, here at the moment it is known.
    fn resolve(
        &self,
        conversation_id: &str,
        ask_id: &str,
        answer: AskAnswer,
        ask_sink: &AskSink,
    ) -> Result<(), String> {
        let mut pending = self.inner.pending.lock().unwrap();
        let parked = pending
            .remove(ask_id)
            .ok_or_else(|| format!("unknown ask {ask_id}"))?;
        if parked.conversation_id != conversation_id {
            pending.insert(ask_id.to_string(), parked);
            return Err(format!("ask {ask_id} does not belong to {conversation_id}"));
        }
        // Only an option the agent declared may be relayed as a selection:
        // the answer side carries the same non-widening guarantee as the
        // ask side. The ask stays parked and nothing is recorded.
        if let AskAnswer::Choose(option_id) = &answer {
            if !parked.option_ids.contains(option_id) {
                pending.insert(ask_id.to_string(), parked);
                return Err(format!(
                    "option {option_id} is not one of the declared options for ask {ask_id}"
                ));
            }
        }
        let resolution = match &answer {
            AskAnswer::Choose(option_id) => AskResolution::Selected {
                option_id: option_id.clone(),
            },
            AskAnswer::Cancel => AskResolution::Cancelled,
        };
        let _ = parked.sender.send(answer);
        drop(pending);
        Self::resolved(conversation_id, ask_id, resolution, ask_sink);
        Ok(())
    }

    fn resolved(conversation_id: &str, ask_id: &str, outcome: AskResolution, ask_sink: &AskSink) {
        ask_sink(AskNotice::Resolved {
            conversation_id: conversation_id.to_string(),
            ask_id: ask_id.to_string(),
            outcome,
        });
    }
}

pub enum ConversationCommand {
    Prompt {
        text: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    SetMode {
        mode_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetConfigOption {
        config_id: String,
        value: SessionConfigOptionValue,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

/// What the conversation loop reports once the handshake and session
/// creation are done.
struct ConversationReady {
    session_id: String,
    agent_info: serde_json::Value,
    /// What `session/new` declares: the mode state and the config options,
    /// verbatim — the agent's own vocabulary, carried out for the room to
    /// render. Nothing here is an agent's answer: an agent that declares
    /// neither carries neither.
    modes: Option<SessionModeState>,
    config_options: Option<Vec<SessionConfigOption>>,
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
    ask_board: AskBoard,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationInfo {
    pub conversation_id: String,
    pub session_id: String,
    pub agent_info: serde_json::Value,
    pub modes: Option<SessionModeState>,
    pub config_options: Option<Vec<SessionConfigOption>>,
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
    // A configured agent's launch facts reach here as one launch spec from
    // the device store: a plain command string (`opencode acp`) parses by
    // shell words, and a JSON object (`{"command":…, "args":…, "env":…}`)
    // carries its args and env verbatim — the same forms the ACP crate
    // accepts, so the store holds exactly what it can launch.
    let agent = AcpAgent::from_str(command.trim())
        .map_err(|e| format!("the launch command does not parse as an ACP agent: {e}"))?;
    let cwd = expand_cwd(&cwd)?;

    let conversation_id = format!(
        "conversation-{}",
        state.next_id.fetch_add(1, Ordering::Relaxed)
    );
    let (commands, command_rx) = mpsc::unbounded_channel::<ConversationCommand>();
    let (ready_tx, ready_rx) = oneshot::channel::<Result<ConversationReady, String>>();

    let sink: EventSink = {
        let app = app.clone();
        Arc::new(move |event| {
            let _ = app.emit("acp-update", event);
        })
    };

    let ask_sink: AskSink = {
        let app = app.clone();
        Arc::new(move |notice| {
            let _ = app.emit("acp-ask", notice);
        })
    };
    let ask_board = state.ask_board.clone();
    let ask_conversation_id = conversation_id.clone();

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
            async move |request: RequestPermissionRequest, responder, connection| {
                // The ask goes to the conversation's room, which offers the
                // agent's own declared options; when no one can be asked, the
                // board cancels and records it. The deliberation is offloaded
                // onto the connection — the event loop must keep serving
                // notifications and further requests while the person thinks.
                let ask_board = ask_board.clone();
                let ask_conversation_id = ask_conversation_id.clone();
                let ask_sink = ask_sink.clone();
                connection.spawn(async move {
                    let answer = ask_board
                        .ask(&ask_conversation_id, &request, &ask_sink)
                        .await;
                    responder.respond(permission_response_for(answer))
                })
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

    state
        .conversations
        .lock()
        .unwrap()
        .insert(conversation_id.clone(), ConversationHandle { commands });
    Ok(ConversationInfo {
        conversation_id,
        session_id: info.session_id,
        agent_info: info.agent_info,
        modes: info.modes,
        config_options: info.config_options,
    })
}

/// Maps the board's answer onto the wire response: the person's choice is
/// relayed as exactly that option; only an unanswerable ask is cancelled.
fn permission_response_for(answer: AskAnswer) -> RequestPermissionResponse {
    match answer {
        AskAnswer::Choose(option_id) => RequestPermissionResponse::new(
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id)),
        ),
        AskAnswer::Cancel => RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
    }
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
        modes: new_session.modes.clone(),
        config_options: new_session.config_options.clone(),
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
            ConversationCommand::SetMode { mode_id, reply } => {
                let result = connection
                    .send_request(SetSessionModeRequest::new(session_id.clone(), mode_id))
                    .block_task()
                    .await;
                let _ = reply.send(match result {
                    Ok(_) => Ok(()),
                    Err(e) => Err(e.to_string()),
                });
            }
            ConversationCommand::SetConfigOption {
                config_id,
                value,
                reply,
            } => {
                let result = connection
                    .send_request(SetSessionConfigOptionRequest::new(
                        session_id.clone(),
                        config_id,
                        value,
                    ))
                    .block_task()
                    .await;
                let _ = reply.send(match result {
                    Ok(_) => Ok(()),
                    Err(e) => Err(e.to_string()),
                });
            }
        }
    }
    Ok(())
}

/// Dropping the sender ends the conversation loop, which completes the
/// connection future and shuts the agent process down. Parked permission asks
/// of the closing conversation are cancelled and recorded.
#[tauri::command]
pub fn acp_close(state: tauri::State<'_, AcpState>, conversation_id: String) -> Result<(), String> {
    state.ask_board.close(&conversation_id);
    state
        .conversations
        .lock()
        .unwrap()
        .remove(&conversation_id)
        .map(|_| ())
        .ok_or_else(|| format!("unknown conversation {conversation_id}"))
}

/// Marks whether the conversation's room is mounted and able to put a
/// permission ask to the person. Releasing the surface cancels that
/// conversation's parked asks — a question nobody can answer must not strand
/// the agent. Claiming a surface for a conversation that does not exist is
/// refused: a ghost surface would park every later ask forever.
#[tauri::command]
pub fn acp_ask_surface(
    state: tauri::State<'_, AcpState>,
    conversation_id: String,
    present: bool,
) -> Result<(), String> {
    if present
        && !state
            .conversations
            .lock()
            .unwrap()
            .contains_key(&conversation_id)
    {
        return Err(format!("unknown conversation {conversation_id}"));
    }
    state.ask_board.set_surface(&conversation_id, present);
    Ok(())
}

/// Delivers the person's answer — one of the agent's declared option ids, or
/// none to cancel — to the parked permission ask it names.
#[tauri::command]
pub async fn acp_answer_permission(
    app: tauri::AppHandle,
    state: tauri::State<'_, AcpState>,
    conversation_id: String,
    ask_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let ask_sink: AskSink = Arc::new(move |notice| {
        let _ = app.emit("acp-ask", notice);
    });
    let answer = match option_id {
        Some(option_id) => AskAnswer::Choose(option_id),
        None => AskAnswer::Cancel,
    };
    state
        .ask_board
        .resolve(&conversation_id, &ask_id, answer, &ask_sink)
}

/// Sends a prompt into a live conversation and waits for the turn to end.
/// Streamed output arrives as `acp-update` events, not in this reply.
#[tauri::command]
pub async fn acp_prompt(
    state: tauri::State<'_, AcpState>,
    conversation_id: String,
    text: String,
) -> Result<String, String> {
    let commands = conversation_commands(&state, &conversation_id)?;

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

/// Sets the session's mode. The mode id is the agent's own — one of what
/// `session/new` declared in `availableModes`; anything else is the agent's
/// error to refuse, and the answer relays it. Declared changes the agent
/// makes itself arrive as `current_mode_update` notifications, which the
/// UI already streams.
#[tauri::command]
pub async fn acp_set_mode(
    state: tauri::State<'_, AcpState>,
    conversation_id: String,
    mode_id: String,
) -> Result<(), String> {
    let commands = conversation_commands(&state, &conversation_id)?;
    let (reply_tx, reply_rx) = oneshot::channel();
    if commands
        .send(ConversationCommand::SetMode {
            mode_id,
            reply: reply_tx,
        })
        .is_err()
    {
        return Err("conversation has ended".to_string());
    }
    reply_rx
        .await
        .map_err(|_| "conversation ended before the mode was set".to_string())?
}

/// Sets one session configuration option's value. The value is the agent's
/// own declared shape (a value id for a select, a boolean for a toggle);
/// the agent's answer carries the updated declared set, which arrives as
/// `config_option_update` notifications.
#[tauri::command]
pub async fn acp_set_config_option(
    state: tauri::State<'_, AcpState>,
    conversation_id: String,
    config_id: String,
    value: SessionConfigOptionValue,
) -> Result<(), String> {
    let commands = conversation_commands(&state, &conversation_id)?;
    let (reply_tx, reply_rx) = oneshot::channel();
    if commands
        .send(ConversationCommand::SetConfigOption {
            config_id,
            value,
            reply: reply_tx,
        })
        .is_err()
    {
        return Err("conversation has ended".to_string());
    }
    reply_rx
        .await
        .map_err(|_| "conversation ended before the option was set".to_string())?
}

/// Clones the live command channel for a conversation, or names the
/// conversation that is not there.
fn conversation_commands(
    state: &tauri::State<'_, AcpState>,
    conversation_id: &str,
) -> Result<mpsc::UnboundedSender<ConversationCommand>, String> {
    state
        .conversations
        .lock()
        .unwrap()
        .get(conversation_id)
        .map(|handle| handle.commands.clone())
        .ok_or_else(|| format!("unknown conversation {conversation_id}"))
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
    /// output sink instead of Tauri events and the caller's ask board and
    /// sink, and returns the handles the test drives prompts with. The caller
    /// keeps its own ask record clone to inspect.
    async fn start_test_conversation(
        agent: AcpAgent,
        ask_board: AskBoard,
        ask_sink: AskSink,
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
                async move |request: RequestPermissionRequest, responder, connection| {
                    let ask_board = ask_board.clone();
                    let ask_sink = ask_sink.clone();
                    connection.spawn(async move {
                        let answer = ask_board
                            .ask("test-conversation", &request, &ask_sink)
                            .await;
                        responder.respond(permission_response_for(answer))
                    })
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

    async fn prompt(commands: &mpsc::UnboundedSender<ConversationCommand>, text: &str) -> String {
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

    // --- The permission-ask seam ---------------------------------------------

    use super::{AskAnswer, AskBoard, AskNotice, AskResolution, AskSink};
    use agent_client_protocol::schema::v1::{
        PermissionOption, PermissionOptionKind, ToolCallUpdate, ToolCallUpdateFields,
    };

    type AskRecorded = Arc<Mutex<Vec<AskNotice>>>;

    fn recording_ask_sink() -> (AskSink, AskRecorded) {
        let recorded: AskRecorded = Arc::default();
        let sink: AskSink = {
            let recorded = recorded.clone();
            Arc::new(move |notice| recorded.lock().unwrap().push(notice))
        };
        (sink, recorded)
    }

    /// A permission request as an agent declares it: a tool call that names
    /// what it would do, and three declared options with their declared kinds.
    fn permission_request() -> RequestPermissionRequest {
        RequestPermissionRequest::new(
            "session-1",
            ToolCallUpdate::new(
                "call-1",
                ToolCallUpdateFields::new().title("Write acp-ask-witness.txt"),
            ),
            vec![
                PermissionOption::new("allow-once", "Allow once", PermissionOptionKind::AllowOnce),
                PermissionOption::new(
                    "allow-always",
                    "Allow always",
                    PermissionOptionKind::AllowAlways,
                ),
                PermissionOption::new(
                    "reject-once",
                    "Reject once",
                    PermissionOptionKind::RejectOnce,
                ),
            ],
        )
    }

    fn resolutions(recorded: &AskRecorded) -> Vec<AskResolution> {
        recorded
            .lock()
            .unwrap()
            .iter()
            .filter_map(|notice| match notice {
                AskNotice::Resolved { outcome, .. } => Some(outcome.clone()),
                AskNotice::Asked { .. } => None,
            })
            .collect()
    }

    /// Waits until a parked ask has been announced, and returns its ask id,
    /// its tool call, and its declared options.
    async fn wait_asked(recorded: &AskRecorded) -> (String, serde_json::Value, serde_json::Value) {
        tokio::time::timeout(Duration::from_millis(100), async {
            loop {
                let found = {
                    let notices = recorded.lock().unwrap();
                    notices.iter().find_map(|n| match n {
                        AskNotice::Asked {
                            ask_id,
                            tool_call,
                            options,
                            ..
                        } => Some((ask_id.clone(), tool_call.clone(), options.clone())),
                        _ => None,
                    })
                };
                if let Some(found) = found {
                    return found;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the parked ask should be announced")
    }

    /// Witness for the seam's cancel clause: an ask arriving where no one can
    /// be asked is cancelled — immediately, not after a wait — and the
    /// cancellation is recorded beside the ask, never dropped.
    #[tokio::test]
    async fn an_ask_with_no_surface_cancels_and_records_it() {
        let board = AskBoard::default();
        let (ask_sink, recorded) = recording_ask_sink();

        let answer = tokio::time::timeout(
            Duration::from_millis(100),
            board.ask("conversation-1", &permission_request(), &ask_sink),
        )
        .await
        .expect("the ask must not park where no one can answer");

        assert!(matches!(answer, AskAnswer::Cancel));
        assert_eq!(resolutions(&recorded), vec![AskResolution::Cancelled]);
    }

    /// Witness for the seam's ask clause: with a surface able to ask, the ask
    /// parks carrying the agent's own declared options — ids, names, and kinds
    /// exactly as declared, nothing renamed — and the person's choice answers
    /// the request as that option, recorded once.
    #[tokio::test]
    async fn a_surface_receives_the_declared_options_and_the_choice_answers_selected() {
        let board = AskBoard::default();
        board.set_surface("conversation-1", true);
        let (ask_sink, recorded) = recording_ask_sink();

        let parking = {
            let board = board.clone();
            let request = permission_request();
            let ask_sink = ask_sink.clone();
            tokio::spawn(async move { board.ask("conversation-1", &request, &ask_sink).await })
        };

        let (_ask_id, tool_call, options) = wait_asked(&recorded).await;
        assert_eq!(
            tool_call["title"],
            serde_json::json!("Write acp-ask-witness.txt"),
            "the ask names what the tool call would do"
        );
        let declared: serde_json::Value =
            serde_json::to_value(&permission_request().options).unwrap();
        assert_eq!(options, declared, "the options pass through verbatim");
        assert_eq!(
            options
                .as_array()
                .unwrap()
                .iter()
                .map(|o| o["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["allow_once", "allow_always", "reject_once"],
            "the kinds are the agent's own, not a desktop vocabulary"
        );

        board
            .resolve(
                "conversation-1",
                "ask-0",
                AskAnswer::Choose("allow-once".to_string()),
                &ask_sink,
            )
            .expect("the parked ask should resolve");

        let answer = tokio::time::timeout(Duration::from_millis(100), parking)
            .await
            .expect("the ask should end once answered")
            .expect("the parked task should not panic");
        assert!(
            matches!(&answer, AskAnswer::Choose(id) if id == "allow-once"),
            "the choice must be delivered as the selected option, got {answer:?}"
        );
        assert_eq!(
            resolutions(&recorded),
            vec![AskResolution::Selected {
                option_id: "allow-once".to_string()
            }],
            "exactly one resolution is recorded per ask"
        );
    }

    /// Witness for the answer side's non-widening guarantee: the wire
    /// response relays the person's choice as exactly that option, and an
    /// option the agent did not declare is refused — the ask stays parked and
    /// no selection is recorded.
    #[test]
    fn the_choice_is_relayed_as_selected_and_an_undeclared_option_is_refused() {
        let chosen = permission_response_for(AskAnswer::Choose("allow-once".to_string()));
        assert!(matches!(
            chosen.outcome,
            RequestPermissionOutcome::Selected(ref picked) if picked.option_id.to_string() == "allow-once"
        ));
        let cancelled = permission_response_for(AskAnswer::Cancel);
        assert!(matches!(
            cancelled.outcome,
            RequestPermissionOutcome::Cancelled
        ));
    }

    #[tokio::test]
    async fn an_undeclared_option_is_refused_not_relayed() {
        let board = AskBoard::default();
        board.set_surface("conversation-1", true);
        let (ask_sink, recorded) = recording_ask_sink();

        let parking = {
            let board = board.clone();
            let request = permission_request();
            let ask_sink = ask_sink.clone();
            tokio::spawn(async move { board.ask("conversation-1", &request, &ask_sink).await })
        };
        let (ask_id, _tool_call, _options) = wait_asked(&recorded).await;

        let refused = board.resolve(
            "conversation-1",
            &ask_id,
            AskAnswer::Choose("invented".to_string()),
            &ask_sink,
        );
        assert!(
            refused.is_err(),
            "an option the agent never declared must be refused"
        );

        // The ask is still parked: the declared option still answers it, and
        // the refused attempt recorded nothing.
        board
            .resolve(
                "conversation-1",
                &ask_id,
                AskAnswer::Choose("allow-once".to_string()),
                &ask_sink,
            )
            .expect("the declared option should still resolve the parked ask");
        let answer = tokio::time::timeout(Duration::from_millis(100), parking)
            .await
            .expect("the ask should end once answered")
            .expect("the parked task should not panic");
        assert!(matches!(&answer, AskAnswer::Choose(id) if id == "allow-once"));
        assert_eq!(
            resolutions(&recorded),
            vec![AskResolution::Selected {
                option_id: "allow-once".to_string()
            }],
            "the refused attempt must not appear as a resolution"
        );
    }

    /// Witness for the unaskable clause, surface half: releasing the room's
    /// ask surface while an ask is parked cancels it and records the
    /// cancellation — a question nobody can answer must not strand the agent.
    #[tokio::test]
    async fn releasing_the_surface_cancels_a_parked_ask() {
        let board = AskBoard::default();
        board.set_surface("conversation-1", true);
        let (ask_sink, recorded) = recording_ask_sink();

        let parking = {
            let board = board.clone();
            let request = permission_request();
            let ask_sink = ask_sink.clone();
            tokio::spawn(async move { board.ask("conversation-1", &request, &ask_sink).await })
        };
        board.set_surface("conversation-1", false);

        let answer = tokio::time::timeout(Duration::from_millis(100), parking)
            .await
            .expect("the ask should end when the surface goes")
            .expect("the parked task should not panic");
        assert!(matches!(answer, AskAnswer::Cancel));
        assert_eq!(resolutions(&recorded), vec![AskResolution::Cancelled]);
    }

    /// Witness for the unaskable clause, close half: ending the conversation
    /// while an ask is parked cancels it the same way.
    #[tokio::test]
    async fn closing_the_conversation_cancels_a_parked_ask() {
        let board = AskBoard::default();
        board.set_surface("conversation-1", true);
        let (ask_sink, recorded) = recording_ask_sink();

        let parking = {
            let board = board.clone();
            let request = permission_request();
            let ask_sink = ask_sink.clone();
            tokio::spawn(async move { board.ask("conversation-1", &request, &ask_sink).await })
        };
        board.close("conversation-1");

        let answer = tokio::time::timeout(Duration::from_millis(100), parking)
            .await
            .expect("the ask should end when the conversation closes")
            .expect("the parked task should not panic");
        assert!(matches!(answer, AskAnswer::Cancel));
        assert_eq!(resolutions(&recorded), vec![AskResolution::Cancelled]);
    }

    /// A sink for conversations whose asks are not under test; anything a
    /// real ask would announce is of no interest there.
    fn silent_ask_sink() -> AskSink {
        Arc::new(|_| {})
    }

    /// Witness for the conversation clause: one `opencode acp` process serves
    /// initialize, session creation, and three prompts — the answer streams
    /// as agent message chunks rather than arriving whole at turn end, and
    /// later turns see earlier ones. Ignored by default — it needs the agent
    /// binary. Run locally: `cargo test -p desktop --lib -- --ignored`
    ///
    /// The connection requires a multi-thread runtime: on current-thread
    /// tokio, responses arrive but notifications are never dispatched.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires opencode on PATH"]
    async fn opencode_answers_prompts_on_one_live_conversation() {
        let (commands, recorded, info) = start_test_conversation(
            opencode_witness_agent(),
            AskBoard::default(),
            silent_ask_sink(),
        )
        .await;
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

    /// Witness for the declared-selection clause: opencode's `session/new`
    /// declares modes and config options (observed live — `configOptions`
    /// carries a `model` select), so the conversation carries them out of
    /// `session/new` verbatim. The changed-lands half: setting the declared
    /// mode round-trips, and the agent's own `current_mode_update`
    /// notification arrives through the update stream. Requires opencode on
    /// PATH. Run locally: `cargo test -p desktop --lib -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires opencode on PATH"]
    async fn opencode_declares_selection_and_a_set_mode_round_trips() {
        let (commands, recorded, info) = start_test_conversation(
            opencode_witness_agent(),
            AskBoard::default(),
            silent_ask_sink(),
        )
        .await;
        assert!(!info.session_id.is_empty(), "agent should create a session");

        // What the agent declares at session/new is carried out verbatim.
        if let Some(modes) = &info.modes {
            assert!(
                !modes.available_modes.is_empty(),
                "a declared mode state names at least one mode"
            );
        }

        // A declared mode id round-trips; the agent's own change notification
        // arrives through the same update stream the UI listens on.
        if let Some(modes) = &info.modes {
            let declared = modes.available_modes.first().expect("a declared mode");
            let (reply_tx, reply_rx) = oneshot::channel();
            commands
                .send(ConversationCommand::SetMode {
                    mode_id: declared.id.to_string(),
                    reply: reply_tx,
                })
                .expect("the conversation should still be open");
            let set = tokio::time::timeout(Duration::from_secs(60), reply_rx)
                .await
                .expect("the set_mode round-trip should complete")
                .expect("the reply channel should live");
            set.expect("the declared mode should set");

            let landed =
                tokio::time::timeout(Duration::from_secs(60), async {
                    loop {
                        if recorded.lock().unwrap().iter().any(|event| {
                            matches!(&event.update, SessionUpdate::CurrentModeUpdate(_))
                        }) {
                            return true;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                })
                .await
                .expect("the agent should announce the mode change itself");
            assert!(landed);
        } else {
            // An agent that declares no modes exercises the other arm: the
            // set command is still routed, and the agent's error — if it
            // refuses an undeclared mode — is relayed as an error, not a
            // desktop-side assumption.
            let (reply_tx, reply_rx) = oneshot::channel();
            commands
                .send(ConversationCommand::SetMode {
                    mode_id: "undeclared-mode".to_string(),
                    reply: reply_tx,
                })
                .expect("the conversation should still be open");
            let set = tokio::time::timeout(Duration::from_secs(60), reply_rx)
                .await
                .expect("the set_mode round-trip should complete")
                .expect("the reply channel should live");
            assert!(
                set.is_ok() || set.is_err(),
                "the answer relays whatever the agent decided"
            );
        }
    }

    /// Witness for the second agent: the real npm adapter
    /// (`@zed-industries/claude-code-acp`; the name `claude-agent-acp` in the
    /// task body does not exist on npm) answers initialize and one prompt
    /// through the same conversation path. Requires `claude` auth on this
    /// machine. Run locally: `cargo test -p desktop --lib -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires npx and local claude auth"]
    async fn claude_code_answers_a_prompt() {
        let (commands, recorded, info) = start_test_conversation(
            AcpAgent::from_str("npx -y @zed-industries/claude-code-acp")
                .expect("agent command should parse"),
            AskBoard::default(),
            silent_ask_sink(),
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

    /// Witness for the ask clause against the real npm adapter: Claude Code
    /// asks before writing a file, the room's surface receives the agent's
    /// own declared options, choosing an allow option answers the request as
    /// `Selected` with that option, and the agent proceeds to do the work.
    /// Requires `claude` auth on this machine.
    /// Run locally: `cargo test -p desktop --lib -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires npx and local claude auth"]
    async fn claude_code_permission_ask_round_trips_and_the_agent_proceeds() {
        let board = AskBoard::default();
        board.set_surface("test-conversation", true);
        let (ask_sink, asks) = recording_ask_sink();
        let resolve_sink = ask_sink.clone();
        let (commands, _recorded, info) = start_test_conversation(
            AcpAgent::from_str("npx -y @zed-industries/claude-code-acp")
                .expect("agent command should parse"),
            board.clone(),
            ask_sink,
        )
        .await;
        assert!(!info.session_id.is_empty(), "agent should create a session");

        let path = witness_cwd().join("acp-ask-witness.txt");
        let _ = std::fs::remove_file(&path);

        let turn = {
            let commands = commands.clone();
            tokio::spawn(async move {
                prompt(
                    &commands,
                    "Create a file named acp-ask-witness.txt in the current working directory \
                     containing exactly the text OK. Use the file-writing tool.",
                )
                .await
            })
        };

        let (ask_id, options) = tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                let snapshot = asks.lock().unwrap().clone();
                if let Some(AskNotice::Asked {
                    ask_id, options, ..
                }) = snapshot
                    .into_iter()
                    .find(|n| matches!(n, AskNotice::Asked { .. }))
                {
                    return (ask_id, options);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("claude code should ask before writing");

        let allow = options
            .as_array()
            .and_then(|opts| {
                opts.iter()
                    .find(|o| o["kind"] == "allow_once" || o["kind"] == "allow_always")
            })
            .unwrap_or_else(|| {
                panic!("claude code should declare an allow option, got: {options}")
            });
        let option_id = allow["optionId"].as_str().expect("declared option id");

        board
            .resolve(
                "test-conversation",
                &ask_id,
                AskAnswer::Choose(option_id.to_string()),
                &resolve_sink,
            )
            .expect("the parked ask should resolve");

        let stop = tokio::time::timeout(Duration::from_secs(120), turn)
            .await
            .expect("the turn should end after the allow")
            .expect("the prompt task should not panic");
        assert_eq!(stop, "end_turn", "the turn should end normally");
        assert_eq!(
            std::fs::read_to_string(&path)
                .ok()
                .map(|t| t.trim().to_string()),
            Some("OK".to_string()),
            "the agent should have done the work once allowed"
        );
        let resolved = resolutions(&asks);
        assert!(
            matches!(resolved.last(), Some(AskResolution::Selected { .. })),
            "the choice should be recorded as a selection, got: {resolved:?}"
        );
    }

    /// Removes the witness config dir — the copied credentials with it —
    /// whenever the witness ends, panic or not.
    struct WitnessConfigDir(PathBuf);
    impl Drop for WitnessConfigDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Verifies live against Claude Code's permission model that a tool call
    /// the person's harness configuration pre-approves never reaches the
    /// client as a permission ask. The witness pre-approves Write through
    /// claude's own settings (`CLAUDE_CONFIG_DIR`), prompts a write with an
    /// ask surface present, and fails — naming the finding — if an ask
    /// arrives anyway. Requires `claude` auth on this machine.
    /// Run locally: `cargo test -p desktop --lib -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires npx and local claude auth"]
    async fn claude_code_preapproved_tools_never_ask() {
        let config_dir = std::env::temp_dir().join("temper-desktop-acp-preapproved-config");
        std::fs::create_dir_all(&config_dir).expect("claude config directory");
        let _cleanup = WitnessConfigDir(config_dir.clone());
        std::fs::write(
            config_dir.join("settings.json"),
            r#"{ "permissions": { "allow": ["Write"] } }"#,
        )
        .expect("claude settings");
        // Auth is file-based on this platform: the witness config dir must
        // carry the operator's credentials or the agent never starts. The
        // copy lives in a temp dir at runtime; nothing personal is stored.
        let credentials = std::env::home_dir()
            .expect("home directory")
            .join(".claude/.credentials.json");
        std::fs::copy(&credentials, config_dir.join(".credentials.json"))
            .expect("claude credentials should be file-based for this witness");

        let agent = AcpAgent::new(
            AcpAgentConfig::new("npx")
                .arg("-y")
                .arg("@zed-industries/claude-code-acp")
                .env("CLAUDE_CONFIG_DIR", config_dir.to_string_lossy().as_ref()),
        );
        let board = AskBoard::default();
        // The surface is present on purpose: if pre-approval fails, the ask
        // parks visibly and the prompt times out naming the finding, rather
        // than silently declining.
        board.set_surface("test-conversation", true);
        let (ask_sink, asks) = recording_ask_sink();
        let (commands, _recorded, info) = start_test_conversation(agent, board, ask_sink).await;
        assert!(!info.session_id.is_empty(), "agent should create a session");

        let path = witness_cwd().join("acp-preapproved-witness.txt");
        let _ = std::fs::remove_file(&path);

        let stop = tokio::time::timeout(
            Duration::from_secs(120),
            prompt(
                &commands,
                "Create a file named acp-preapproved-witness.txt in the current \
                 working directory containing exactly the text OK. Use the file-writing tool.",
            ),
        )
        .await
        .expect(
            "the pre-approved write should complete without asking; a timeout \
             here means an ask arrived — check the recorded notices",
        );
        assert_eq!(stop, "end_turn", "the turn should end normally");

        let snapshot = asks.lock().unwrap().clone();
        assert!(
            !snapshot
                .iter()
                .any(|n| matches!(n, AskNotice::Asked { .. })),
            "a harness-pre-approved tool call reached the client as an ask — \
             land this finding in the task before any workaround: {snapshot:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&path)
                .ok()
                .map(|t| t.trim().to_string()),
            Some("OK".to_string()),
            "the pre-approved write should have happened"
        );
    }
}
