use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, ContentBlock, InitializeRequest, McpServer, NewSessionRequest,
    PromptRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    ResourceLink, SelectedPermissionOutcome, SessionConfigOption, SessionConfigOptionValue,
    SessionModeState, SessionNotification, SessionUpdate, SetSessionConfigOptionRequest,
    SetSessionModeRequest, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo, Error};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::{mpsc, oneshot};

use crate::present_board::{PresentSink, PresentationBoard};

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

/// What is in view in the person's room, shared with the agent as a reference:
/// a URI the agent's own temper tools resolve, and the name temper gives it.
/// The desktop shares where the person is looking; it never sends the body.
#[derive(Debug, Clone, Deserialize)]
pub struct PromptReference {
    pub uri: String,
    pub name: String,
}

/// The content of one prompt: the person's text, then a `resource_link` for each
/// reference that goes with it — the session's scope on its first prompt, and the
/// room in view when it has changed since it was last shared. Every ACP agent
/// accepts `text` and `resource_link` blocks, so no capability is asked.
pub fn prompt_blocks(text: String, references: Vec<PromptReference>) -> Vec<ContentBlock> {
    let mut blocks = vec![ContentBlock::Text(TextContent::new(text))];
    blocks.extend(references.into_iter().map(|reference| {
        ContentBlock::ResourceLink(ResourceLink::new(reference.name, reference.uri))
    }));
    blocks
}

pub enum ConversationCommand {
    Prompt {
        text: String,
        references: Vec<PromptReference>,
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
    /// Whether the conversation's presentation surface rides with the
    /// session: `Available` when the MCP HTTP server was started and
    /// delivered, `Unsupported` when the agent's init answer named no HTTP
    /// MCP support — the harness's lack, named, never widened into silence.
    presentations: PresentationsState,
}

/// The two states a conversation's presentation surface can be in, carried
/// out in [`ConversationInfo`] so the room can say which one it is in —
/// an agent that cannot present is an agent that cannot present, not an
/// agent with nothing to say.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum PresentationsState {
    Available,
    Unsupported { reason: String },
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
    pub(crate) present_board: PresentationBoard,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationInfo {
    pub conversation_id: String,
    pub session_id: String,
    pub agent_info: serde_json::Value,
    pub modes: Option<SessionModeState>,
    pub config_options: Option<Vec<SessionConfigOption>>,
    /// Whether the conversation's presentation surface rides with the
    /// session — or why not. `available` says the agent can call the tool;
    /// `unsupported` with its reason names the agent's own lack, never a
    /// silent absence.
    pub presentations: PresentationsState,
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
    // shell words, a JSON object (`{"command":…, "args":…, "env":…}`) carries
    // its args and env verbatim — the same forms the ACP crate accepts, so the
    // store holds exactly what it can launch. A roster row carrying the
    // `{{adapter:key}}` marker names a bundled adapter instead: adapters.rs
    // renders it to the interpreter + entry + harness env at spawn time.
    let agent = if crate::adapters::is_bundled_row(&command) {
        let config = crate::adapters::render_launch(command.trim())?;
        AcpAgent::new(config)
    } else {
        AcpAgent::from_str(command.trim())
            .map_err(|e| format!("the launch command does not parse as an ACP agent: {e}"))?
    };
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
    let presentations = PresentWiring {
        board: state.present_board.clone(),
        conversation_id: conversation_id.clone(),
        sink: {
            let app = app.clone();
            Arc::new(move |notice| {
                let _ = app.emit("acp-present", notice);
            })
        },
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
            run_conversation(
                connection,
                command_rx,
                ready_tx,
                cwd,
                Vec::new(),
                Some(presentations),
            )
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
        presentations: info.presentations,
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

/// The presentation wiring one conversation carries: the board its views
/// park on, its id there, and where the webview is told. `None` is the
/// probe's path — its own servers, passed through untouched.
pub struct PresentWiring {
    pub board: PresentationBoard,
    pub conversation_id: String,
    pub sink: PresentSink,
}

/// What the gate decided: start the desktop's own presentation server and
/// hand it to `session/new`, skip it and name why in `ConversationInfo`, or
/// pass the caller's servers through untouched — the probe's path.
#[derive(Debug, PartialEq)]
enum PresentationStart {
    Start,
    Skip,
    PassThrough,
}

/// The gate's decision, pure: the desktop only starts a presentation server
/// when the conversation carries the wiring AND the agent's init answer
/// declared MCP HTTP support. Everything else passes through unchanged.
fn wants_presentation_server(
    wire_presentations: bool,
    capabilities: &AgentCapabilities,
) -> PresentationStart {
    match (wire_presentations, capabilities.mcp_capabilities.http) {
        (true, true) => PresentationStart::Start,
        (true, false) => PresentationStart::Skip,
        (false, _) => PresentationStart::PassThrough,
    }
}

/// The presenting agent as its own init answer names it — the title when it
/// gave one, else its name. An agent that named itself nothing is named so.
fn agent_name(info: Option<&agent_client_protocol::schema::v1::Implementation>) -> String {
    info.map(|i| i.title.clone().unwrap_or_else(|| i.name.clone()))
        .unwrap_or_else(|| "an unnamed agent".to_string())
}

async fn run_conversation(
    connection: ConnectionTo<Agent>,
    mut commands: mpsc::UnboundedReceiver<ConversationCommand>,
    ready: oneshot::Sender<Result<ConversationReady, String>>,
    cwd: PathBuf,
    mcp_servers: Vec<McpServer>,
    presentation_wiring: Option<PresentWiring>,
) -> Result<(), Error> {
    let init = connection
        .send_request(InitializeRequest::new(ProtocolVersion::V1))
        .block_task()
        .await?;
    let agent_info = serde_json::to_value(&init)
        .map_err(|e| agent_client_protocol::util::internal_error(e.to_string()))?;

    // The capability gate, between initialize and `session/new`: the desktop
    // starts its presentation server only for a conversation whose agent
    // answered that it can reach an MCP server over HTTP — a port is held
    // for an agent that can never call it only if the gate is skipped.
    // The server starts here, before `session/new`: the URL and secret are
    // ready when the request is composed, no race between the answer and
    // the server's bind.
    let want = wants_presentation_server(presentation_wiring.is_some(), &init.agent_capabilities);
    let closing = presentation_wiring
        .as_ref()
        .map(|w| (w.board.clone(), w.conversation_id.clone()));
    let (attached_servers, presentations, server_guard) = match (want, presentation_wiring) {
        (PresentationStart::Start, Some(wiring)) => {
            let server = crate::present_server::RunningServer::start(
                crate::present_server::PresentContext {
                    board: wiring.board,
                    conversation_id: wiring.conversation_id,
                    agent: agent_name(init.agent_info.as_ref()),
                    sink: wiring.sink,
                },
            )
            .await
            .map_err(agent_client_protocol::util::internal_error)?;
            let entry = server.as_mcp_server();
            let guard = crate::present_server::RunningServerGuard::new(server);
            (vec![entry], PresentationsState::Available, Some(guard))
        }
        (PresentationStart::Skip, _) => (
            Vec::new(),
            PresentationsState::Unsupported {
                reason: "the agent declared no MCP HTTP support, so the presentation server was \
                     not started for this conversation"
                    .to_string(),
            },
            None,
        ),
        // The gate answers Start or Skip only for a wired conversation.
        (PresentationStart::Start, None) | (PresentationStart::PassThrough, _) => {
            (mcp_servers, PresentationsState::Available, None)
        }
    };

    // The loop's end — awaited, or dropped with the connection future when
    // the agent dies — refuses whatever is still parked on the board.
    // Declared after the server guard on purpose: a dropped future drops
    // its locals in reverse order, so on the death arm the board is refused
    // before the server's shutdown can end a parked handler unanswered.
    let board_closer = closing.map(|(board, id)| board.closer(&id));

    let new_session = connection
        .send_request(NewSessionRequest::new(cwd).mcp_servers(attached_servers))
        .block_task()
        .await?;
    let session_id = new_session.session_id.clone();

    let _ = ready.send(Ok(ConversationReady {
        session_id: session_id.to_string(),
        agent_info,
        modes: new_session.modes.clone(),
        config_options: new_session.config_options.clone(),
        presentations,
    }));

    // The guard's graceful stop happens here — loop end, on every arm:
    // `acp_close` drops the conversation's handle, which ends this loop, and
    // the agent's death completes (or drops) the connection future, whose
    // guard-drop sends the same shutdown signal. A parked `acp_prompt`'s
    // reply already carried the error before this runs.
    while let Some(command) = commands.recv().await {
        match command {
            ConversationCommand::Prompt {
                text,
                references,
                reply,
            } => {
                let result = connection
                    .send_request(PromptRequest::new(
                        session_id.clone(),
                        prompt_blocks(text, references),
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
    // The conversation ended (close via the dropped command channel, or the
    // agent's death via the connection future): parked views are refused
    // first, so no handler holds the graceful stop open; then the server's
    // shutdown signal goes out on every arm, and the graceful stop waits.
    drop(board_closer);
    if let Some(guard) = server_guard {
        let server = guard.take();
        server.stop().await;
    }
    Ok(())
}

/// Dropping the sender ends the conversation loop, which completes the
/// connection future and shuts the agent process down. Parked permission asks
/// of the closing conversation are cancelled and recorded; parked views are
/// refused as ended — which also ends a turn waiting on one, so the loop is
/// free to see the dropped channel.
#[tauri::command]
pub fn acp_close(state: tauri::State<'_, AcpState>, conversation_id: String) -> Result<(), String> {
    state.ask_board.close(&conversation_id);
    state.present_board.close(&conversation_id);
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
    // One claim, both boards: the room that can put an ask to the person is
    // the room that checks and mounts a presented view.
    state.ask_board.set_surface(&conversation_id, present);
    state.present_board.set_surface(&conversation_id, present);
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
/// Streamed output arrives as `acp-update` events, not in this reply. Each of
/// `references` goes with the text as a `resource_link` block, in order.
#[tauri::command]
pub async fn acp_prompt(
    state: tauri::State<'_, AcpState>,
    conversation_id: String,
    text: String,
    references: Option<Vec<PromptReference>>,
) -> Result<String, String> {
    let references = references.unwrap_or_default();
    let commands = conversation_commands(&state, &conversation_id)?;

    let (reply_tx, reply_rx) = oneshot::channel();
    if commands
        .send(ConversationCommand::Prompt {
            text,
            references,
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
    use agent_client_protocol::schema::v1::{
        AgentCapabilities, HttpHeader, McpCapabilities, McpServerHttp, ToolCallContent,
        ToolCallStatus,
    };
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

    /// Builds an `AcpAgent` from a bundled preset in `agents-roster.toml`.
    /// Bundled-adapter rows render through adapters.rs, so a witness spawns
    /// exactly what the app spawns — interpreter, entry file, harness env and
    /// all; the adapter version is bun.lock's, never the TOML's.
    fn roster_witness_agent(key: &str) -> AcpAgent {
        let entry = crate::roster::roster_entry(key)
            .unwrap_or_else(|| panic!("roster preset for `{key}` present in agents-roster.toml"));
        if crate::adapters::is_bundled_row(&entry.command) {
            AcpAgent::new(
                crate::adapters::render_launch(&entry.command)
                    .unwrap_or_else(|e| panic!("bundled adapter for `{key}` renders: {e}")),
            )
        } else {
            AcpAgent::from_str(&entry.command)
                .unwrap_or_else(|e| panic!("launch command for `{key}` parses: {e}"))
        }
    }

    fn claude_code_witness_agent() -> AcpAgent {
        roster_witness_agent("claude")
    }

    fn agy_witness_agent() -> AcpAgent {
        roster_witness_agent("antigravity")
    }

    /// The model the opencode witnesses run. opencode's own default is a
    /// small free model, which judges the model more than the desktop; the
    /// witnesses select a capable one the session declares.
    /// `TEMPER_WITNESS_OPENCODE_MODEL` overrides it.
    const OPENCODE_WITNESS_MODEL: &str = "ollama-cloud/kimi-k3";

    fn opencode_witness_model() -> String {
        std::env::var("TEMPER_WITNESS_OPENCODE_MODEL")
            .unwrap_or_else(|_| OPENCODE_WITNESS_MODEL.to_string())
    }

    /// Selects `model` through the session's own declared `model` option —
    /// the same `session/set_config_option` the room sends. A model the
    /// session does not declare fails the witness by name; it never falls
    /// back to the harness default.
    async fn pin_witness_model(
        commands: &mpsc::UnboundedSender<ConversationCommand>,
        info: &ConversationReady,
        model: &str,
    ) {
        let options = serde_json::to_value(&info.config_options).unwrap_or_default();
        let option = options
            .as_array()
            .into_iter()
            .flatten()
            .find(|o| o["category"] == "model")
            .unwrap_or_else(|| panic!("the session declares no model option to pin {model} on"));
        let declared = option["options"].to_string();
        assert!(
            declared.contains(&format!("\"{model}\"")),
            "the session does not declare {model} (is its provider authenticated on this \
             machine?) — set TEMPER_WITNESS_OPENCODE_MODEL to one it does"
        );
        let config_id = option["id"]
            .as_str()
            .expect("the option has an id")
            .to_string();
        let (reply, set) = oneshot::channel();
        commands
            .send(ConversationCommand::SetConfigOption {
                config_id,
                // The wire shape the room sends (`setConfigOption` in the
                // session store): a value id, typed.
                value: serde_json::from_value(
                    serde_json::json!({ "type": "value_id", "value": model }),
                )
                .expect("a model id is a value id"),
                reply,
            })
            .expect("the conversation is live");
        set.await
            .expect("the option answer arrives")
            .unwrap_or_else(|e| panic!("the session refused {model}: {e}"));
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
    /// keeps its own ask record clone to inspect. `mcp_servers` rides into
    /// `session/new` (empty by default), which is how the MCP-fidelity
    /// witness attaches the probe server.
    async fn start_test_conversation(
        agent: AcpAgent,
        ask_board: AskBoard,
        ask_sink: AskSink,
    ) -> (
        mpsc::UnboundedSender<ConversationCommand>,
        Recorded,
        ConversationReady,
    ) {
        let wiring = PresentWiring {
            board: PresentationBoard::default(),
            conversation_id: "test-conversation".to_string(),
            sink: Arc::new(|_| {}),
        };
        start_test_conversation_with(agent, ask_board, ask_sink, Vec::new(), Some(wiring)).await
    }

    async fn start_test_conversation_with_mcp(
        agent: AcpAgent,
        ask_board: AskBoard,
        ask_sink: AskSink,
        mcp_servers: Vec<McpServer>,
    ) -> (
        mpsc::UnboundedSender<ConversationCommand>,
        Recorded,
        ConversationReady,
    ) {
        start_test_conversation_with(agent, ask_board, ask_sink, mcp_servers, None).await
    }

    async fn start_test_conversation_with(
        agent: AcpAgent,
        ask_board: AskBoard,
        ask_sink: AskSink,
        mcp_servers: Vec<McpServer>,
        presentation_wiring: Option<PresentWiring>,
    ) -> (
        mpsc::UnboundedSender<ConversationCommand>,
        Recorded,
        ConversationReady,
    ) {
        let agent_name = format!("{agent:?}");
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
                run_conversation(
                    connection,
                    command_rx,
                    ready_tx,
                    witness_cwd(),
                    mcp_servers,
                    presentation_wiring,
                )
            });
        tokio::spawn(connection);

        let info = ready_rx
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "the conversation ended before it was ready (agent: {agent_name}) — the \
                     agent process may have failed to start or answered no handshake"
                )
            })
            .expect("conversation should become ready");
        (commands, recorded, info)
    }

    async fn prompt(commands: &mpsc::UnboundedSender<ConversationCommand>, text: &str) -> String {
        prompt_with(commands, text, None).await
    }

    async fn prompt_with(
        commands: &mpsc::UnboundedSender<ConversationCommand>,
        text: &str,
        reference: Option<PromptReference>,
    ) -> String {
        let (reply_tx, reply_rx) = oneshot::channel();
        commands
            .send(ConversationCommand::Prompt {
                text: text.to_string(),
                references: reference.into_iter().collect(),
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

    /// Every update kind the conversation delivered, in order, as words —
    /// what a cancelled or empty turn needs its evidence read from. A tool
    /// call's kind is followed by its title or toolCallId, the two things an
    /// unreadable turn first gives.
    fn update_kinds(recorded: &Recorded) -> Vec<String> {
        recorded
            .lock()
            .unwrap()
            .iter()
            .map(|event| match &event.update {
                SessionUpdate::AgentMessageChunk(_) => "chunk".to_string(),
                SessionUpdate::ToolCall(call) => {
                    format!("tool_call[{}] id={}", call.title, call.tool_call_id)
                }
                SessionUpdate::ToolCallUpdate(update) => format!(
                    "tool_call_update id={:?} {:?}",
                    update.tool_call_id, update.fields.status
                ),
                SessionUpdate::Plan(_) => "plan".to_string(),
                other => format!(
                    "other[{}]",
                    serde_json::to_value(other)
                        .map(|v| v.to_string())
                        .unwrap_or_default()
                        .len()
                ),
            })
            .collect()
    }

    // --- The prompt's reference ----------------------------------------------

    use super::{prompt_blocks, PromptReference};

    #[test]
    fn a_prompt_carries_its_text_and_then_the_room_in_view() {
        let reference = PromptReference {
            uri: "temper:build-the-desktop-shell-01a0e32f-27e5-7ca3-9327-5812961bdbff".into(),
            name: "Build the desktop shell".into(),
        };
        let blocks = prompt_blocks("What is next?".into(), vec![reference]);
        assert_eq!(blocks.len(), 2);
        match &blocks[0] {
            ContentBlock::Text(text) => assert_eq!(text.text, "What is next?"),
            other => panic!("the text comes first, got {other:?}"),
        }
        match &blocks[1] {
            ContentBlock::ResourceLink(link) => {
                assert_eq!(link.name, "Build the desktop shell");
                assert!(link.uri.starts_with("temper:build-the-desktop-shell-"));
            }
            other => panic!("the reference is a resource_link, got {other:?}"),
        }
        let wire = serde_json::to_value(&blocks[1]).unwrap();
        assert_eq!(wire["type"], "resource_link");
    }

    #[test]
    fn a_prompt_with_nothing_in_view_is_text_alone() {
        let blocks = prompt_blocks("Hello".into(), Vec::new());
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], ContentBlock::Text(_)));
    }

    /// A session's first prompt carries its scope and the room in view, each a
    /// link of its own, in the order given.
    #[test]
    fn a_first_prompt_carries_the_scope_then_the_room_in_view() {
        let scope = PromptReference {
            uri: "temper:+temper-dev/contrib".into(),
            name: "context +temper-dev/contrib".into(),
        };
        let room = PromptReference {
            uri: "temper:the-desktop-hub-01a0e0b8-39a6-7c42-97a4-3c1380308dc7".into(),
            name: "The desktop hub".into(),
        };
        let blocks = prompt_blocks("Where were we?".into(), vec![scope, room]);
        let names: Vec<_> = blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ResourceLink(link) => Some(link.name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(names, ["context +temper-dev/contrib", "The desktop hub"]);
    }

    /// Witness that a real agent accepts the room in view: a prompt carrying a
    /// `resource_link` completes its turn. Requires opencode on PATH. Run
    /// locally: `cargo test -p desktop --lib -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires opencode on PATH"]
    async fn opencode_accepts_a_prompt_with_the_room_in_view() {
        let (commands, _recorded, info) = start_test_conversation(
            opencode_witness_agent(),
            AskBoard::default(),
            silent_ask_sink(),
        )
        .await;
        pin_witness_model(&commands, &info, &opencode_witness_model()).await;
        let reference = PromptReference {
            uri: "temper:01a0e32f-27e5-7ca3-9327-5812961bdbff".into(),
            name: "Build the desktop shell".into(),
        };
        let stop = prompt_with(
            &commands,
            "Reply with exactly the name of the resource I shared, nothing else.",
            Some(reference),
        )
        .await;
        assert_eq!(
            stop, "end_turn",
            "a turn with a resource_link should end normally"
        );
    }

    /// Witness of the handoff's return path against a real agent: a prompt composed exactly as
    /// the document room composes it — intent, the three versions as fenced sections, and the
    /// instruction naming the ```proposal fence — ends its turn with a proposal the frontend's
    /// extraction reads. This is W12's running half: the reply is the material, the fence is
    /// the contract. Requires opencode on PATH. Run locally:
    /// `cargo test -p desktop --lib -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires opencode on PATH"]
    async fn opencode_answers_a_handoff_prompt_with_a_proposal_fence() {
        let (commands, recorded, info) = start_test_conversation(
            opencode_witness_agent(),
            AskBoard::default(),
            silent_ask_sink(),
        )
        .await;
        pin_witness_model(&commands, &info, &opencode_witness_model()).await;
        // The prompt, as the room composes it (src/lib/handoff.ts `handoffPrompt`): the
        // intent, three fenced versions, the instruction bounding the answer.
        let prompt = "I was editing \"Witness scratch\" in temper, but the document changed since \
I opened it, so my save was refused. Here is what I intended, and the material:\n\n\
Intent: fold my changes into theirs — keep the reconciliation small\n\n\
### What I had written (my draft)\n\n```markdown\n# Scope\n\nThe room, read-only.\n\nAnd my \
edit.\n```\n\
### What the document reads now (the newer version)\n\n```markdown\n# Scope\n\nSomeone else \
was here.\n```\n\
### What the document read when I opened it (the base)\n\n```markdown\n# Scope\n\nThe room, \
read-only.\n```\n\n\
Return your proposed reconciliation as ONE fenced markdown block that begins with ```proposal \
and ends with ``` — the body between the fences is exactly the document text you propose, \
whole. Change nothing outside it, and write nothing else inside it.";
        let stop = prompt_with(&commands, prompt, None).await;
        assert_eq!(stop, "end_turn", "a handoff turn should end normally");
        // The turn's reply, as the frontend's extractor receives it: the streamed text chunks.
        let reply = streamed_chunks(&recorded).join("");
        // The fence the frontend asks for, and the extraction of what it asked for.
        let fence = reply.rfind("```proposal");
        assert!(
            fence.is_some(),
            "the turn should carry a ```proposal fence; reply was:\n{reply}"
        );
        // The proposal fence closes: the extraction reads the body between the fences.
        let after_open = reply[fence.unwrap() + "```proposal".len()..]
            .find("\n```")
            .expect("the proposal fence should close");
        let proposal = reply[fence.unwrap() + "```proposal".len() + 1
            ..fence.unwrap() + "```proposal".len() + 1 + after_open]
            .to_string();
        // The proposal is the whole document text: it opens with the shared heading and
        // carries the newer version's line, folded or kept by the agent's own choice.
        assert!(
            proposal.contains("Someone else was here.")
                || proposal.contains("The room, read-only."),
            "the proposal should be a reconciliation of the versions; was:\n{proposal}"
        );
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

    /// An ask surface that answers every ask with the agent's first declared
    /// allow option, and records the resolution. The fidelity witness does
    /// not judge the ask surface — it judges whether the harness's model can
    /// compose a spec once any tool flow it needs is permitted. An ask the
    /// harness makes while composing (agy lists the workspace before
    /// composing) must be allowed, or the turn cancels and the finding dies
    /// at the ask, unread.
    fn auto_allow_ask_sink(board: &AskBoard, conversation: &str) -> (AskSink, AskRecorded) {
        let (sink, recorded) = recording_ask_sink();
        let board = board.clone();
        let conversation = conversation.to_string();
        board.set_surface(&conversation, true);
        let listening: AskSink = Arc::new(move |notice| {
            sink(notice.clone());
            if let AskNotice::Asked {
                ask_id, options, ..
            } = &notice
            {
                // The first declared allow_once, else the first option.
                let allow = options
                    .as_array()
                    .and_then(|opts| {
                        opts.iter().find_map(|o| {
                            if o.get("kind").and_then(|k| k.as_str()) == Some("allow_once") {
                                o.get("optionId").and_then(|v| v.as_str()).map(String::from)
                            } else {
                                None
                            }
                        })
                    })
                    .or_else(|| {
                        options
                            .as_array()
                            .and_then(|o| o.first())
                            .and_then(|o| o.get("optionId"))
                            .and_then(|v| v.as_str())
                            .map(String::from)
                    });
                if let Some(option) = allow {
                    // The ask's notice is emitted before its park, so a
                    // resolve in this closure would hit "unknown ask" — the
                    // parked sender does not exist yet. The answer lands on
                    // a spawned task instead, after the park has taken.
                    let ask_id = ask_id.clone();
                    let conversation = conversation.clone();
                    let sink = sink.clone();
                    let board = board.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(50));
                        let _ =
                            board.resolve(&conversation, &ask_id, AskAnswer::Choose(option), &sink);
                    });
                }
            }
        });
        (listening, recorded)
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
        pin_witness_model(&commands, &info, &opencode_witness_model()).await;
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
        pin_witness_model(&commands, &info, &opencode_witness_model()).await;
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

    /// Pins the adapter interpreter for the duration of a witness body.
    /// Restores the prior value on drop, so a pinned twin never leaks the pin
    /// into the parallel default-interpreter run.
    struct InterpreterPin(Option<String>);
    impl InterpreterPin {
        fn set(value: &str) -> Self {
            let prior = std::env::var("TEMPER_ACP_INTERPRETER").ok();
            std::env::set_var("TEMPER_ACP_INTERPRETER", value);
            InterpreterPin(prior)
        }
    }
    impl Drop for InterpreterPin {
        fn drop(&mut self) {
            match &self.0 {
                Some(v) => std::env::set_var("TEMPER_ACP_INTERPRETER", v),
                None => std::env::remove_var("TEMPER_ACP_INTERPRETER"),
            }
        }
    }

    /// Witness for the second agent: the bundled adapter
    /// (`@agentclientprotocol/claude-agent-acp`, versioned by bun.lock),
    /// launched under node by default, answers initialize and one prompt
    /// through the same conversation path. Requires `claude` auth on this
    /// machine. Run locally: `cargo test -p desktop --lib -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires the claude CLI and local claude auth"]
    async fn claude_code_answers_a_prompt() {
        let (commands, recorded, info) = start_test_conversation(
            claude_code_witness_agent(),
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

    /// The interpreter-parity twin: the same prompt through the same bundled
    /// adapter, pinned to bun. A difference between this witness and its
    /// node-default sibling is an adapter-interpreter incompatibility, named
    /// — never a silent win because one interpreter happened to be picked.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires bun, the claude CLI and local claude auth"]
    async fn claude_code_answers_a_prompt_under_bun() {
        let _pin = InterpreterPin::set("bun");
        let (commands, recorded, info) = start_test_conversation(
            claude_code_witness_agent(),
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
            "under bun the agent's streamed answer should reply OK, got: {chunks:?}"
        );
    }

    /// Witness for Google Antigravity CLI: the bundled `agy-acp` adapter,
    /// which wraps the person's own `agy` (AGY_BIN at launch), answers
    /// initialize and one prompt through the same conversation path. This
    /// adapter drives agy over a PTY (node-pty), so it runs under node only:
    /// bun's node-pty delivers no data (verified 2026-10-01), and the pin
    /// test in adapters.rs is what proves node stays this launch's default.
    /// Requires `agy` CLI on this machine. Run locally:
    /// `cargo test -p desktop --lib -- --ignored agy_answers_a_prompt`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires the agy CLI on PATH"]
    async fn agy_answers_a_prompt() {
        let (commands, recorded, info) =
            start_test_conversation(agy_witness_agent(), AskBoard::default(), silent_ask_sink())
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
    #[ignore = "requires the claude CLI and local claude auth"]
    async fn claude_code_permission_ask_round_trips_and_the_agent_proceeds() {
        let board = AskBoard::default();
        board.set_surface("test-conversation", true);
        let (ask_sink, asks) = recording_ask_sink();
        let resolve_sink = ask_sink.clone();
        let (commands, _recorded, info) =
            start_test_conversation(claude_code_witness_agent(), board.clone(), ask_sink).await;
        assert!(!info.session_id.is_empty(), "agent should create a session");

        // The adapter opens sessions in its `auto` mode, where Claude decides
        // permissions itself and no ask is sent. The witness is of the ask,
        // so it selects the adapter's own declared mode that always asks.
        let (reply, set) = oneshot::channel();
        commands
            .send(ConversationCommand::SetMode {
                mode_id: "default".to_string(),
                reply,
            })
            .expect("the conversation is live");
        set.await
            .expect("the mode answer arrives")
            .expect("the adapter declares an always-ask mode named `default`");

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
    #[ignore = "requires the claude CLI and local claude auth"]
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

        let claude_command = crate::roster::roster_entry("claude")
            .expect("claude preset in agents-roster.toml")
            .command;
        let config = crate::adapters::render_launch(&claude_command)
            .expect("claude's bundled adapter renders")
            .env("CLAUDE_CONFIG_DIR", config_dir.to_string_lossy().as_ref());
        let agent = AcpAgent::new(config);
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

    // ── The presented-view probe's gates ────────────────────────────────

    /// The gate's three arms in words: HTTP support declared → the server
    /// starts; HTTP support absent → skip and name why; the probe's wiring
    /// passes the caller's servers through untouched.
    #[test]
    fn the_gate_starts_only_for_a_http_capable_agent() {
        let mut http = AgentCapabilities::default();
        http.mcp_capabilities = McpCapabilities::default().http(true);
        let mut no_http = AgentCapabilities::default();
        no_http.mcp_capabilities = McpCapabilities::default().http(false);

        assert_eq!(
            wants_presentation_server(true, &http),
            PresentationStart::Start,
            "an HTTP-capable agent gets the presentation server"
        );
        assert_eq!(
            wants_presentation_server(true, &no_http),
            PresentationStart::Skip,
            "an agent without MCP HTTP support gets no server — nothing pretends otherwise"
        );
        assert_eq!(
            wants_presentation_server(false, &http),
            PresentationStart::PassThrough,
            "the probe's wiring passes its own servers through"
        );
        assert_eq!(
            wants_presentation_server(false, &no_http),
            PresentationStart::PassThrough
        );
    }

    /// The unsupported arm speaks: the reason an agent cannot present is the
    /// agent's own lack, named — never a silent absence.
    #[test]
    fn the_unsupported_arm_names_the_agent_s_lack_in_words() {
        assert_eq!(
            PresentationsState::Unsupported {
                reason: "the agent declared no MCP HTTP support, so the presentation \
                         server was not started for this conversation"
                    .to_string()
            },
            PresentationsState::Unsupported {
                reason: "the agent declared no MCP HTTP support, so the presentation \
                         server was not started for this conversation"
                    .to_string()
            }
        );
    }

    use crate::present_probe::ProbeServer;

    /// The completed tool calls' json results, in the order they completed. A
    /// harness may carry a result in `content`, `raw_output`, or both —
    /// either is read. A completion carrying no json (a harness's own
    /// tool-loading step, say) is not a presentation answer and is skipped;
    /// the caller's comparison with the board's record catches a missing one.
    fn completed_tool_results(recorded: &Recorded) -> Vec<serde_json::Value> {
        let mut latest: Vec<(String, ToolCallUpdateFields)> = Vec::new();
        for event in recorded.lock().unwrap().iter() {
            let (id, fields) = match &event.update {
                SessionUpdate::ToolCall(call) => (
                    call.tool_call_id.to_string(),
                    ToolCallUpdateFields::new()
                        .status(call.status)
                        .content(call.content.clone())
                        .raw_output(call.raw_output.clone()),
                ),
                SessionUpdate::ToolCallUpdate(update) => {
                    (update.tool_call_id.to_string(), update.fields.clone())
                }
                _ => continue,
            };
            if fields.status == Some(ToolCallStatus::Completed)
                && !latest.iter().any(|(seen, _)| *seen == id)
            {
                latest.push((id, fields));
            }
        }
        latest
            .into_iter()
            .filter_map(|(_, fields)| {
                let said = fields
                    .content
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|c| match c {
                        ToolCallContent::Content(content) => match &content.content {
                            ContentBlock::Text(text) => Some(text.text.clone()),
                            _ => None,
                        },
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                let raw_output = fields
                    .raw_output
                    .as_ref()
                    .map(|v| v.to_string())
                    .unwrap_or_default();
                serde_json::from_str(&said)
                    .or_else(|_| serde_json::from_str(&raw_output))
                    .ok()
            })
            .collect()
    }

    /// Runs the webview's own gate, `checkSpec`, on a spec — through bun,
    /// headless (`scripts/check-spec.ts`), so the witness answers with the
    /// desktop's check, never a restatement of it.
    async fn check_spec_as_the_webview_does(spec: &serde_json::Value) -> (bool, Vec<String>) {
        use tokio::io::AsyncWriteExt;
        let desktop = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut child = tokio::process::Command::new("bun")
            .arg("scripts/check-spec.ts")
            .current_dir(&desktop)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("bun runs the webview's checkSpec");
        let mut stdin = child.stdin.take().expect("stdin is piped");
        stdin
            .write_all(spec.to_string().as_bytes())
            .await
            .expect("the spec reaches checkSpec");
        drop(stdin);
        let out = child.wait_with_output().await.expect("checkSpec answers");
        let result: serde_json::Value =
            serde_json::from_slice(&out.stdout).expect("checkSpec's answer is json");
        let reasons = result["errors"]
            .as_array()
            .map(|e| {
                e.iter()
                    .filter_map(|r| r.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        (result["ok"] == true, reasons)
    }

    /// Witness for the presentation round trip, against a live agent: opencode
    /// declares MCP HTTP support, so the desktop's server rides its
    /// `session/new`; the model presents one conforming view and one carrying
    /// a colour prop. The webview's place is taken by an answerer running the
    /// webview's own `checkSpec` and answering through `present_answer`'s
    /// logic. The two specs are given literally: composing from the schema
    /// is the fidelity probe's judgment; this witness judges the round trip.
    /// A model may still retry from a refusal's reasons, so the witness
    /// asserts what the channel owes rather than a fixed count: the answers
    /// the agent was told are exactly the board's resolutions, in order; the
    /// conforming view renders; the colour prop is refused naming the catalog
    /// version and the prop; and the turn ends — nothing waits on a person.
    /// Run locally: `cargo test --lib -- --ignored
    /// opencode_presents_a_rendered_and_a_refused_view`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires opencode and bun on PATH"]
    async fn opencode_presents_a_rendered_and_a_refused_view() {
        let model = opencode_witness_model();
        presents_a_rendered_and_a_refused_view(opencode_witness_agent(), Some(&model)).await;
    }

    /// The same round trip through Claude Code's ACP adapter, pinned. Claude
    /// Code speaks MCP 2026-07-28, which refuses a tools/list result lacking
    /// `ttlMs`/`cacheScope` — this is the witness that the server's list
    /// answer is one a current client accepts, not only a lenient one.
    /// Run locally: `cargo test --lib -- --ignored
    /// claude_code_presents_a_rendered_and_a_refused_view`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires bun, the claude CLI and local claude auth"]
    async fn claude_code_presents_a_rendered_and_a_refused_view() {
        presents_a_rendered_and_a_refused_view(claude_code_witness_agent(), None).await;
    }

    /// `model`, when given, is pinned through the session's declared model
    /// option before the prompt; `None` runs the harness's own selection.
    async fn presents_a_rendered_and_a_refused_view(agent: AcpAgent, model: Option<&str>) {
        use crate::present_board::{PresentNotice, PresentOutcome};

        let board = PresentationBoard::default();
        board.set_surface("test-conversation", true);
        let notices: Arc<Mutex<Vec<PresentNotice>>> = Arc::default();
        let runtime = tokio::runtime::Handle::current();
        let sink: crate::present_board::PresentSink = {
            let board = board.clone();
            let notices = notices.clone();
            Arc::new(move |notice| {
                notices.lock().unwrap().push(notice.clone());
                // The witness's own record of what the model composed — a
                // failed run names the spec, not only the reasons.
                eprintln!(
                    "present notice: {}",
                    serde_json::to_string(&notice).unwrap_or_default()
                );
                if let PresentNotice::Presented {
                    conversation_id,
                    presented_id,
                    spec,
                    ..
                } = notice
                {
                    let board = board.clone();
                    runtime.spawn(async move {
                        let (rendered, reasons) = check_spec_as_the_webview_does(&spec).await;
                        let _ = crate::presentation::answer(
                            &board,
                            &conversation_id,
                            &presented_id,
                            rendered,
                            reasons,
                            |_, _| async {
                                Ok(crate::present_board::PresentedTab {
                                    resource: "witness".to_string(),
                                    artifact: "witness".to_string(),
                                })
                            },
                        )
                        .await;
                    });
                }
            })
        };
        let wiring = PresentWiring {
            board: board.clone(),
            conversation_id: "test-conversation".to_string(),
            sink,
        };

        let (commands, recorded, info) = start_test_conversation_with(
            agent,
            AskBoard::default(),
            silent_ask_sink(),
            Vec::new(),
            Some(wiring),
        )
        .await;
        assert_eq!(info.presentations, PresentationsState::Available);
        if let Some(model) = model {
            pin_witness_model(&commands, &info, model).await;
        }

        // The prompt forbids detours — the witness judges the presentation
        // path, and a bash/grep detour is a failed turn, not evidence.
        let stop = tokio::time::timeout(
            Duration::from_secs(180),
            prompt(
                &commands,
                "Call the temper_present_view tool exactly twice, passing each spec below \
                 verbatim as the `spec` argument, in this order, even if a call is refused — do \
                 not alter, fix, or retry either one.\n\
                 First spec: {\"root\":\"r\",\"elements\":{\"r\":{\"type\":\"RegionState\",\
                 \"props\":{\"state\":\"failed\",\"label\":\"history\"},\"children\":[]}}}\n\
                 Second spec: {\"root\":\"r\",\"elements\":{\"r\":{\"type\":\"RegionState\",\
                 \"props\":{\"state\":\"failed\",\"label\":\"history\",\"colour\":\"red\"},\
                 \"children\":[]}}}\n\
                 Do not run bash, read files, or call any other tool — except to load \
                 temper_present_view first, if your harness defers it. After both answers, \
                 state each tool reply in one line.",
            ),
        )
        .await
        .expect("the presentation turn should end within 180s");
        assert_eq!(
            stop, "end_turn",
            "the turn ends; it never waits on a person"
        );

        // The board's record, in order.
        let resolved: Vec<PresentOutcome> = notices
            .lock()
            .unwrap()
            .iter()
            .filter_map(|n| match n {
                PresentNotice::Resolved { outcome, .. } => Some(outcome.clone()),
                _ => None,
            })
            .collect();
        assert!(
            resolved
                .iter()
                .any(|o| matches!(o, PresentOutcome::Rendered { .. })),
            "a conforming view renders: {resolved:?}"
        );
        for outcome in &resolved {
            if let PresentOutcome::Refused {
                catalog_version,
                reasons,
            } = outcome
            {
                assert_eq!(*catalog_version, crate::present_server::catalog_version());
                assert!(!reasons.is_empty(), "a refusal names its reasons");
            }
        }
        assert!(
            resolved.iter().any(|o| matches!(
                o,
                PresentOutcome::Refused { reasons, .. }
                    if reasons.iter().any(|r| r.contains("colour"))
            )),
            "the colour prop is refused by checkSpec, named: {resolved:?}"
        );

        // What the agent was told is exactly what the board resolved, in the
        // same order — the channel neither drops, doubles, nor rewords an end.
        let told: Vec<serde_json::Value> = completed_tool_results(&recorded)
            .into_iter()
            .filter(|r| r.get("ok").is_some())
            .collect();
        let resolved_json: Vec<serde_json::Value> = resolved
            .iter()
            .map(|o| serde_json::to_value(o).expect("an outcome serializes"))
            .collect();
        assert_eq!(told, resolved_json, "the agent was told the board's ends");
    }

    /// The launch spec for each harness the fidelity probe exercises, with
    /// the reason it is expected to work on this machine. A harness missing
    /// here is skipped by name with its reason in the output — never silently.
    /// Launch strings, not built agents: `AcpAgent` is not `Clone`, and each
    /// arm parses its own.
    async fn probed_harnesses() -> Vec<(&'static str, &'static str)> {
        let mut harnesses = Vec::new();
        if which_probe("opencode") {
            harnesses.push(("opencode-witness", "opencode acp (1.18.32)"));
        } else {
            eprintln!("skip arm: opencode not on PATH");
        }
        // The wrapped harnesses are probed by the CLI their bundled adapter
        // wraps; the adapter itself ships with the app.
        if which_probe("claude") {
            harnesses.push((
                "{{adapter:claude}}",
                "claude CLI + bundled claude-agent-acp",
            ));
        } else {
            eprintln!("skip arm: claude not on PATH");
        }
        // codex's arm stays auth-gated: its authStatus is "none" even after a
        // handshake without an OpenAI key, so the arm is skipped with this
        // reason rather than run to a guaranteed not-ready failure.
        if std::env::var("OPENAI_API_KEY").is_ok() && which_probe("codex") {
            harnesses.push(("{{adapter:codex}}", "codex CLI + bundled codex-acp"));
        } else {
            eprintln!("skip arm: codex not installed or not authenticated on this machine");
        }
        harnesses
    }

    /// Builds the agent an arm runs: `opencode-witness` is the clean-config
    /// witness agent; a `{{adapter:key}}` row renders through adapters.rs the
    /// way the app renders it; anything else parses as its own launch string.
    /// Every arm carries the debug callback, so a turn that ends other than
    /// normally has the agent's stderr to read — an unreadable turn with no
    /// stderr is itself the finding.
    fn arm_agent(spec: &str) -> AcpAgent {
        let agent = if spec == "opencode-witness" {
            opencode_witness_agent()
        } else {
            AcpAgent::new(crate::adapters::render_launch(spec).expect("the launch string renders"))
        };
        agent.with_debug(|line, direction| {
            eprintln!("agent {:?}: {}", direction, line);
        })
    }

    fn which_probe(command: &str) -> bool {
        std::process::Command::new("which")
            .arg(command)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Witness for the probe's gate: does each installed ACP harness pass
    /// the tool's `inputSchema` through to its model faithfully enough for
    /// the model to produce a conforming spec, and does a non-conforming
    /// construction reach the probe's own check (which refuses) rather than
    /// being silently mangled by the harness? Each recorded call is asserted
    /// only on deterministic facts — the shape the model sent, and whether
    /// the probe's own closed-catalog check ran on it as `rendered` or
    /// `refused` with reasons; model behaviour that could vary between runs
    /// is printed, not asserted.
    /// Run locally: `cargo test -p desktop --lib -- --ignored present_mcp_harness_fidelity`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires at least one ACP harness on PATH"]
    async fn present_mcp_harness_fidelity() {
        let harnesses = probed_harnesses().await;
        assert!(
            !harnesses.is_empty(),
            "no probed harness is on PATH; state the machine's gap rather than passing vacuously"
        );
        let findings = Arc::new(Mutex::new(String::new()));
        for (spec, name) in &harnesses {
            let findings = findings.clone();
            findings
                .lock()
                .unwrap()
                .push_str(&format!("\n- arm: {name}"));
            let agent = arm_agent(spec);
            let probe = ProbeServer::start().await.expect("probe server binds");
            let url = probe.base_url.clone();
            let server = McpServer::Http(
                McpServerHttp::new("temper", url)
                    .headers(vec![HttpHeader::new("x-temper-presentation", "probe")]),
            );
            let board = AskBoard::default();
            let (ask_sink, _ask_recorded) = auto_allow_ask_sink(&board, "test-conversation");
            let (commands, recorded, info) =
                start_test_conversation_with_mcp(agent, board, ask_sink, vec![server]).await;
            if *spec == "opencode-witness" {
                pin_witness_model(&commands, &info, &opencode_witness_model()).await;
            }
            assert!(!info.session_id.is_empty(), "{name}: session created");

            let stop = tokio::time::timeout(
                Duration::from_secs(120),
                prompt(
                    &commands,
                    "Call the temper_present_view tool with a spec that shows a bounded list of \
                     two resource references. Compose the spec strictly from the tool's \
                     inputSchema — its elements, its $defs, its closed property sets.",
                ),
            )
            .await
            .unwrap_or_else(|_| {
                // A timeout is a finding too: the table must carry what the
                // model did before it stalled, not vanish with the panic.
                eprintln!(
                    "harness-fidelity findings so far:{}",
                    findings.lock().unwrap()
                );
                panic!("{name}: the presentation turn should end within 120s");
            });
            if stop != "end_turn" {
                // A cancelled or errored turn is a finding too: the table
                // must carry what the conversation delivered before it ended.
                let said = streamed_chunks(&recorded).join(" ");
                let kinds = update_kinds(&recorded);
                findings.lock().unwrap().push_str(&format!(
                    "\n- {name}: turn `{stop}` — updates {:?}, said: {}",
                    kinds,
                    if said.len() > 400 {
                        &said[..400]
                    } else {
                        &said
                    }
                ));
                eprintln!(
                    "harness-fidelity findings so far:{}",
                    findings.lock().unwrap()
                );
                assert_eq!(stop, "end_turn", "{name}: the turn should end normally");
            }

            let calls = probe.recorded_calls();
            findings.lock().unwrap().push_str(&format!(
                "\n- {name}: {} tool call(s), stop `{stop}`",
                calls.len()
            ));
            // What the model said instead of calling, when it did not call:
            // a stated gap needs its words, never just its absence.
            if calls.is_empty() {
                let said = streamed_chunks(&recorded).join(" ");
                findings.lock().unwrap().push_str(&format!(
                    "\n  - said in the turn instead: {}",
                    if said.len() > 300 {
                        &said[..300]
                    } else {
                        &said
                    }
                ));
            }
            for (i, call) in calls.iter().enumerate() {
                let verdict = crate::present_probe::check_spec_public(&call["spec"]);
                findings
                    .lock()
                    .unwrap()
                    .push_str(&format!("\n  - call {i}: {}", verdict.describe()));
            }
            // A harness whose model never calls the tool is a FINDING, not a
            // test failure: the fidelity table must carry it — the gap is
            // stated, never assumed away.
            if calls.is_empty() {
                findings
                    .lock()
                    .unwrap()
                    .push_str("\n  - GAP: the model never called the presentation tool this turn");
            }
            probe.stop().await;
            let _ = &recorded;
        }
        println!("harness-fidelity findings:{}", findings.lock().unwrap());
        eprintln!("(probed {} harness(es))", harnesses.len());
    }
}
