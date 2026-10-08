//! The presentation server: the MCP surface an agent calls to put a temper
//! view in front of the person. One tool, `temper_present_view`, whose
//! `inputSchema` is the closed `temper` catalog read from the same file the
//! webview's `checkSpec` validates against — served over streamable HTTP,
//! bound to loopback on an ephemeral port, gated by a per-conversation
//! secret so only the agent process that conversation started can call it.
//!
//! A tool call parks on the conversation's [`PresentationBoard`] until the
//! webview has checked the spec and answered, and returns that answer.
//! Nothing here is reachable from the webview — this module runs in the Rust
//! core, and the app's CSP forbids any `connect-src` addition; the webview
//! reaches answers through Tauri commands and events only.

use std::sync::Arc;

use agent_client_protocol::schema::v1::{HttpHeader, McpServer, McpServerHttp};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CacheScope, CallToolResult, ContentBlock, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerConfig,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::present_board::{
    PresentOutcome, PresentSink, Presentation, PresentationBoard, ANSWER_BOUND,
};

/// The catalog file the webview validates against — included, never copied,
/// so the server cannot describe a catalog the app would refuse.
pub const CATALOG_JSON: &str = include_str!("../../src/lib/catalog/temper.catalog.json");

/// The HTTP header that carries the per-conversation secret.
pub const SECRET_HEADER: &str = "x-temper-presentation";

/// The wire schema a refusal names, read from the catalog file rather than
/// restated.
pub fn catalog_version() -> String {
    let v: Value = serde_json::from_str(CATALOG_JSON).expect("the bundled catalog parses");
    format!("temper@{}", v["version"].as_str().expect("catalog version"))
}

/// The tool's `inputSchema`: the closed spec shape with each catalog
/// component's props in `$defs`, referenced through a `oneOf` in `elements`.
/// `$defs` sits at the schema's root: a `#/$defs/…` pointer resolves from the
/// document root, so defs nested anywhere else leave every ref dangling —
/// which a strict harness answers by dropping the tool. Each def also
/// carries the component's own `description` — what it is for and the rules
/// its props cannot state — read from the same file, so the agent reads
/// purpose beside shape and no second copy exists to drift.
/// Pure and unit-tested; the projection is the only place catalog names are
/// read, so a renamed component surfaces here first.
pub fn present_view_input_schema() -> Value {
    let catalog: Value = serde_json::from_str(CATALOG_JSON).expect("the bundled catalog parses");
    let components = catalog["components"]
        .as_object()
        .expect("the catalog carries components");
    let defs: serde_json::Map<String, Value> = components
        .iter()
        .map(|(name, c)| {
            // The description rides the def as a JSON Schema annotation
            // beside the props it documents. A component without one projects
            // without one — the tests hold the corpus to carrying one, so a
            // silent gap here is a red suite, not a quiet shrug.
            let mut def = c["props"].clone();
            if let Some(description) = c["description"].as_str() {
                def["description"] = Value::String(description.to_string());
            }
            (name.clone(), def)
        })
        .collect();
    // `children` is required: the gate (`checkSpec`, via json-render's
    // element shape) refuses an element without it, so a schema that left it
    // optional would invite a spec the desktop must refuse.
    let element_branches: Vec<Value> = components
        .keys()
        .map(|name| {
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["type", "props", "children"],
                "properties": {
                    "type": { "const": name },
                    "props": { "$ref": format!("#/$defs/{name}") },
                    "children": { "type": "array", "items": { "type": "string" } }
                }
            })
        })
        .collect();
    // An element's name, and root that names one, are bounded like every
    // other string an agent sends: the catalog's limits say how long.
    let max_name = catalog["limits"]["maxNameLength"].clone();
    json!({
        "type": "object",
        "additionalProperties": false,
        "$defs": defs,
        "required": ["spec"],
        "properties": {
            "spec": {
                "type": "object",
                "additionalProperties": false,
                "required": ["root", "elements"],
                "properties": {
                    "root": { "type": "string", "maxLength": max_name },
                    "elements": {
                        "type": "object",
                        "propertyNames": { "maxLength": max_name },
                        "additionalProperties": {
                            "oneOf": element_branches
                        }
                    }
                }
            }
        }
    })
}

/// The tool call's arguments. The schema they answer to is the projection
/// above, replaced at `list_tools`, not what this derive infers — the
/// derive exists for the `Parameters` trait bound only.
#[derive(Debug, Clone, JsonSchema, Serialize, Deserialize)]
pub struct PresentViewArgs {
    /// The json-render spec to check against the `temper` catalog.
    pub spec: Value,
}

/// What one conversation's server presents into: the board its views park
/// on, the conversation they belong to, the agent presenting (its own init
/// answer's name), and where the webview is told.
#[derive(Clone)]
pub struct PresentContext {
    pub board: PresentationBoard,
    pub conversation_id: String,
    pub agent: String,
    pub sink: PresentSink,
}

/// The service one conversation's MCP server runs. Fresh per request in
/// stateless mode, each carrying the conversation's context; the router is
/// not stored as a field (the `#[tool_handler]` macro defaults the two tool
/// methods to `Self::tool_router()`).
pub struct PresentServer {
    context: PresentContext,
}

#[tool_router]
impl PresentServer {
    pub fn new(context: PresentContext) -> Self {
        Self { context }
    }

    #[tool(
        description = "Present a temper view (a json-render spec) to the person in a temper-desktop conversation. The spec is checked by the person's desktop against the temper catalog (temper@1.0.0, closed JSON Schema). A rendered answer means the spec passed the check and was mounted as its own tab — never that the person has read it; a reply about the view arrives as the conversation's next message, never in this tool's result. A refused answer names the catalog version and every reason the spec failed."
    )]
    async fn temper_present_view(
        &self,
        Parameters(args): Parameters<PresentViewArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let context = &self.context;
        let outcome = context
            .board
            .present(
                &context.conversation_id,
                Presentation {
                    agent: context.agent.clone(),
                    spec: args.spec,
                },
                &context.sink,
                ANSWER_BOUND,
            )
            .await;
        Ok(tool_result(&outcome))
    }
}

/// The outcome as the agent reads it: one closed json object in a text
/// block. A refusal is a successful call carrying `refused` — the tool
/// worked; the view did not pass.
fn tool_result(outcome: &PresentOutcome) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(
        serde_json::to_string(outcome).unwrap_or_else(|e| format!("present result failed: {e}")),
    )])
}

#[tool_handler]
impl ServerHandler for PresentServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(rmcp::model::Implementation::new("temper-present", "0.1.0"))
    }

    /// Manual override — `#[tool_handler]` generates `list_tools` only when
    /// the impl lacks one (the door temper-mcp uses for its runtime blob
    /// filter). The catalog projection replaces the router's derived schema,
    /// so the wire carries what the webview validates against.
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut tools: Vec<rmcp::model::Tool> = Self::tool_router().list_all();
        for tool in &mut tools {
            if tool.name == "temper_present_view" {
                tool.input_schema = Arc::new(
                    present_view_input_schema()
                        .as_object()
                        .expect("the projected schema is an object")
                        .clone(),
                );
            }
        }
        // `ttlMs` and `cacheScope` are required on a list result from MCP
        // 2026-07-28 on: Claude Code refuses a tools/list without them and
        // never offers the tool. The same values `server/discover` answers
        // with — no caching (the server lives one conversation), and private
        // (it answers one secret-holding agent).
        Ok(ListToolsResult::with_all_items(tools)
            .with_ttl_ms(0)
            .with_cache_scope(CacheScope::Private))
    }
}

/// One running server. The port is ephemeral and never configured; the
/// secret is generated here, held in memory only, and reaches exactly one
/// agent process by riding that conversation's `session/new`.
pub struct RunningServer {
    /// The full MCP URL, `http://127.0.0.1:<ephemeral>/mcp`.
    pub url: String,
    /// The secret the agent's headers must carry. Never persisted, never
    /// sent to the webview, never logged.
    pub secret: String,
    shutdown: tokio::sync::watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    /// The `session/new` server entry this conversation's agent receives: the
    /// URL and the secret in the wire names the ACP schema declares, built
    /// from the running server's own facts — never restated by a caller.
    pub fn as_mcp_server(&self) -> McpServer {
        McpServer::Http(
            McpServerHttp::new("temper", self.url.clone())
                .headers(vec![HttpHeader::new(SECRET_HEADER, self.secret.clone())]),
        )
    }
}

impl RunningServer {
    /// Binds loopback, generates the secret, and serves until
    /// [`RunningServer::stop`]. Stateless mode with json responses — the
    /// same assembly temper-mcp runs, minus the deployment-specific pieces.
    /// rmcp's loopback host allowlist stays on: rebinding protection is the
    /// right default for a loopback-only server.
    pub async fn start(context: PresentContext) -> Result<Self, String> {
        let secret = new_secret();
        let serve_secret = secret.clone();
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let serve_shutdown = shutdown_rx.clone();

        // A dedicated runtime thread: the core's calls are async, but the
        // server's serve loop is a long-lived task of its own, and a block-on
        // in someone else's worker would park it.
        let (url_tx, url_rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
        std::thread::spawn(move || {
            let secret = serve_secret;
            let shutdown_rx = serve_shutdown;
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    let _ = url_tx.send(Err(format!("the presentation server's runtime: {e}")));
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                    Ok(l) => l,
                    Err(e) => {
                        let _ = url_tx.send(Err(format!(
                            "the presentation server could not bind loopback: {e}"
                        )));
                        return;
                    }
                };
                let addr = match listener.local_addr() {
                    Ok(a) => a,
                    Err(e) => {
                        let _ = url_tx.send(Err(format!(
                            "the presentation server bound but could not read its port: {e}"
                        )));
                        return;
                    }
                };
                let mcp_service = StreamableHttpService::new(
                    move || Ok(PresentServer::new(context.clone())),
                    Arc::new(LocalSessionManager::default()),
                    StreamableHttpServerConfig::default()
                        .with_legacy_session_mode(false)
                        .with_json_response(true),
                );
                let expected: Arc<String> = Arc::new(secret.clone());
                let serve_shutdown = shutdown_rx.clone();
                let app = Router::new()
                    .nest_service("/mcp", mcp_service)
                    .layer(axum::middleware::from_fn_with_state(expected, mcp_gateway));

                let _ = url_tx.send(Ok(format!("http://{addr}/mcp")));
                let mut serve_shutdown = serve_shutdown;
                let _ = axum::serve(listener, app)
                    .with_graceful_shutdown(async move {
                        let _ = serve_shutdown.wait_for(|stopped| *stopped).await;
                    })
                    .await;
            });
        });

        let url = url_rx
            .await
            .map_err(|_| "the presentation server's task died before it bound".to_string())??;
        let handle = tokio::spawn(wait_shutdown(shutdown_rx));
        Ok(Self {
            url,
            secret,
            shutdown: shutdown_tx,
            handle,
        })
    }

    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

/// What closing a conversation leaves: a closed guard's drop shuts the
/// server down — the graceful path's complement, for the arm where the
/// conversation loop is not polled to completion (the agent's process died
/// with the connection future). The signal send is sync; the join is not
/// awaited from drop, so no drop spins or blocks.
pub struct RunningServerGuard {
    running: Option<RunningServer>,
}

impl RunningServerGuard {
    pub fn new(running: RunningServer) -> Self {
        Self {
            running: Some(running),
        }
    }

    /// Whether the guard still holds its server — read by the drop-path
    /// witness only, to name precisely which arm it drove.
    #[cfg(test)]
    fn holds_server(&self) -> bool {
        self.running.is_some()
    }

    /// Relinquishes the server for a graceful, awaited stop — the explicit
    /// close path. The guard's remaining drop then does nothing.
    pub fn take(mut self) -> RunningServer {
        self.running.take().expect("the server is present on take")
    }
}

impl Drop for RunningServerGuard {
    fn drop(&mut self) {
        if let Some(running) = self.running.take() {
            let _ = running.shutdown.send(true);
        }
    }
}

/// The secret: two concatenated uuidv4s — 256 bits, minted in this process.
pub fn new_secret() -> String {
    format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4())
}

/// Whether the presented header value is exactly the secret, compared in
/// constant time by hand: length check plus a per-character XOR fold. No
/// `subtle` dependency for one comparison.
pub fn secret_matches(presented: Option<&str>, secret: &str) -> bool {
    match presented {
        None => false,
        Some(presented) => {
            if presented.len() != secret.len() {
                return false;
            }
            presented
                .bytes()
                .zip(secret.bytes())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                == 0
        }
    }
}

/// The gate wrapped around the MCP service: no secret, no dispatch, and the
/// refusal says nothing about why.
async fn mcp_gateway(
    axum::extract::State(expected): axum::extract::State<Arc<String>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let presented = request
        .headers()
        .get(SECRET_HEADER)
        .and_then(|v| v.to_str().ok());
    if !secret_matches(presented, &expected) {
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}

async fn wait_shutdown(mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
    let _ = shutdown_rx.wait_for(|stopped| *stopped).await;
}

/// A context whose board has no surface and whose sink records nothing:
/// every call through it is refused "no surface to render into" — the bind
/// and auth witnesses need a server, not a webview.
#[cfg(test)]
pub fn surfaceless_context() -> PresentContext {
    PresentContext {
        board: PresentationBoard::default(),
        conversation_id: "test-conversation".to_string(),
        agent: "test-agent".to_string(),
        sink: Arc::new(|_| {}),
    }
}

/// The wire entry one conversation's agent receives in its `session/new`:
/// the ACP `http` shape with the secret in its header, exactly as the
/// schema's own serialization test composes it.
#[cfg(test)]
#[tokio::test(flavor = "multi_thread")]
async fn the_server_rides_session_new_as_the_acp_http_shape() {
    let (shutdown, _) = tokio::sync::watch::channel(false);
    let server = RunningServer {
        url: "http://127.0.0.1:54321/mcp".to_string(),
        secret: "secret-x".to_string(),
        shutdown,
        handle: tokio::spawn(std::future::pending()),
    };
    let McpServer::Http(http) = server.as_mcp_server() else {
        panic!("the entry is the http variant");
    };
    assert_eq!(http.url.as_str(), "http://127.0.0.1:54321/mcp");
    assert_eq!(http.name.as_str(), "temper");
    let headers: Vec<&HttpHeader> = http.headers.iter().collect();
    assert_eq!(headers.len(), 1, "exactly the secret header, nothing else");
    assert_eq!(headers[0].name.as_str(), "x-temper-presentation");
    assert_eq!(headers[0].value.as_str(), "secret-x");
}

/// Two conversations' servers carry distinct secrets and distinct ports: the
/// secret is per conversation at bind time, never shared across sessions.
#[cfg(test)]
#[tokio::test(flavor = "multi_thread")]
async fn two_conversations_carry_distinct_secrets() {
    let a = RunningServer::start(surfaceless_context())
        .await
        .expect("the first server binds");
    let b = RunningServer::start(surfaceless_context())
        .await
        .expect("the second server binds");
    assert_ne!(a.url, b.url, "each bind takes its own ephemeral port");
    assert_ne!(a.secret, b.secret, "each conversation's secret is its own");
    a.stop().await;
    b.stop().await;
}

/// The drop path: a guard dropped without `take` — the agent-death arm —
/// releases the port. Rebinding the SAME ephemeral port is not observable,
/// so the witness is the shutdown signal itself: the watch sees the send,
/// meaning the graceful shutdown has been triggered with the guard gone.
#[cfg(test)]
#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_guard_shuts_the_server_down() {
    use std::time::Duration;
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    // Mirrors RunningServer's fields exactly — the guard's contract is
    // against the signal, and this drives it without a second live bind.
    let running = RunningServer {
        url: "http://127.0.0.1:1/mcp".to_string(),
        secret: new_secret(),
        shutdown: shutdown_tx,
        handle: tokio::spawn(wait_shutdown(shutdown_rx.clone())),
    };
    {
        let guard = RunningServerGuard::new(running);
        assert!(guard.holds_server());
        // Dropped here, mid-scope, with the conversation's loop never polled
        // again — the agent-death shape.
    }
    // The signal has gone out; the serve loop's graceful shutdown runs.
    tokio::time::timeout(
        Duration::from_millis(100),
        shutdown_rx.wait_for(|stopped| *stopped),
    )
    .await
    .expect("the drop shut the server down")
    .expect("the watch is alive");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The backtick-delimited spans of a string, in order: the names a
    /// description puts in code voice.
    fn backtick_tokens(description: &str) -> Vec<&str> {
        description
            .split('`')
            .enumerate()
            .filter(|(i, _)| i % 2 == 1)
            .map(|(_, token)| token)
            .collect()
    }

    /// The names a component's props schema declares: every key under a
    /// `properties` object, and every string `enum`/`const` value, at any
    /// depth. Derived from the file, never enumerated by hand.
    fn declared_names(value: &Value, names: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, v) in map {
                    match key.as_str() {
                        "properties" => {
                            if let Some(props) = v.as_object() {
                                names.extend(props.keys().cloned());
                            }
                        }
                        "enum" => {
                            if let Some(variants) = v.as_array() {
                                names.extend(
                                    variants.iter().filter_map(|v| v.as_str().map(String::from)),
                                );
                            }
                        }
                        "const" => {
                            if let Some(s) = v.as_str() {
                                names.push(s.to_string());
                            }
                        }
                        _ => {}
                    }
                    declared_names(v, names);
                }
            }
            Value::Array(items) => items.iter().for_each(|v| declared_names(v, names)),
            _ => {}
        }
    }

    /// The projection carries every catalog component in `$defs`, closed.
    #[test]
    fn the_schema_projects_every_component_closed() {
        let schema = present_view_input_schema();
        let spec = &schema["properties"]["spec"];
        let defs = schema["$defs"].as_object().expect("$defs is an object");
        let catalog: Value = serde_json::from_str(CATALOG_JSON).unwrap();
        let components = catalog["components"].as_object().unwrap();
        assert_eq!(
            defs.len(),
            components.len(),
            "one $defs entry per component"
        );
        for (name, c) in components {
            let def = &defs[name];
            let mut expected = c["props"].clone();
            if let Some(description) = c["description"].as_str() {
                expected["description"] = json!(description);
            }
            assert_eq!(def, &expected, "props and description carried for {name}");
            assert_eq!(
                def.get("additionalProperties").and_then(Value::as_bool),
                Some(false),
                "{name}'s props are closed on the wire"
            );
        }
        // The element branches reference the defs, one per component.
        let one_of = spec["properties"]["elements"]["additionalProperties"]["oneOf"]
            .as_array()
            .expect("elements is a oneOf over the components");
        assert_eq!(one_of.len(), components.len());
        // Every branch requires what the gate requires — an element without
        // `children` is refused by checkSpec, so the wire must not admit it.
        for branch in one_of {
            assert_eq!(branch["required"], json!(["type", "props", "children"]));
        }
    }

    /// Every component's description reaches the agent verbatim from the
    /// catalog file: a description missing from the file, missing from the
    /// projection, or worded differently than the file's is this test red.
    #[test]
    fn every_component_s_description_rides_the_schema_verbatim() {
        let schema = present_view_input_schema();
        let defs = schema["$defs"].as_object().expect("$defs is an object");
        let catalog: Value = serde_json::from_str(CATALOG_JSON).unwrap();
        for (name, c) in catalog["components"].as_object().unwrap() {
            let description = c["description"]
                .as_str()
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| panic!("{name}'s catalog description is missing or empty"));
            let carried = defs[name]["description"]
                .as_str()
                .unwrap_or_else(|| panic!("{name}'s description is missing from the wire schema"));
            assert_eq!(
                carried, description,
                "{name}'s description differs from the catalog file's"
            );
        }
    }

    /// A description that names a name names one the catalog declares: every
    /// backticked span resolves to the component's own declared vocabulary —
    /// its props, their nested fields and their variants — or another
    /// component's name. A renamed prop that left a description behind turns
    /// this red.
    #[test]
    fn a_component_description_names_only_declared_names() {
        let catalog: Value = serde_json::from_str(CATALOG_JSON).unwrap();
        let components = catalog["components"].as_object().unwrap();
        let component_names: Vec<&str> = components.keys().map(String::as_str).collect();
        for (name, c) in components {
            let description = c["description"]
                .as_str()
                .unwrap_or_else(|| panic!("{name} carries no description"));
            assert_eq!(
                description.matches('`').count() % 2,
                0,
                "{name}'s description balances its backticks"
            );
            let mut declared: Vec<String> = Vec::new();
            declared_names(&c["props"], &mut declared);
            declared.extend(component_names.iter().map(|s| (*s).to_string()));
            let declared: std::collections::HashSet<&str> =
                declared.iter().map(String::as_str).collect();
            for token in backtick_tokens(description) {
                assert!(
                    declared.contains(token),
                    "{name}'s description names `{token}` — nothing by that name is declared in its props or the catalog"
                );
            }
        }
    }

    /// What the agent receives stays bounded. The serialized schema names its
    /// own budget — 64 KiB, about 2.6× the 24,573 bytes measured at
    /// declaration (20,409 of them the props projection the descriptions
    /// joined) — so catalog growth stays headroom, never an open door.
    #[test]
    fn the_projected_schema_stays_within_its_declared_budget() {
        let bytes = serde_json::to_string(&present_view_input_schema())
            .expect("the schema serializes")
            .len();
        let budget = 64 * 1024;
        assert!(
            bytes <= budget,
            "the projected schema is {bytes} bytes, past its {budget}-byte budget"
        );
    }

    /// A prop the catalog does not declare is refused by the wire schema
    /// itself — the schema is the closed vocabulary, not a promise to check.
    #[test]
    fn the_wire_schema_refuses_an_undeclared_prop() {
        // Hand-judged: jsonschema validation in Rust is out of scope here;
        // this asserts the schema's shape carries the closure, which is what
        // a compliant harness's model would be held to.
        let schema = present_view_input_schema();
        for (_, def) in schema["$defs"].as_object().unwrap() {
            assert_eq!(
                def.get("additionalProperties").and_then(Value::as_bool),
                Some(false)
            );
        }
        assert_eq!(
            schema.get("additionalProperties").and_then(Value::as_bool),
            Some(false)
        );
    }

    /// Every `$ref` resolves from the document root, as JSON Schema resolves
    /// it. A dangling ref is a schema a strict harness cannot use: Claude
    /// Code listed the tool and never offered it to its model.
    #[test]
    fn every_ref_resolves_from_the_schema_root() {
        fn refs(value: &Value, found: &mut Vec<String>) {
            match value {
                Value::Object(map) => {
                    if let Some(Value::String(r)) = map.get("$ref") {
                        found.push(r.clone());
                    }
                    map.values().for_each(|v| refs(v, found));
                }
                Value::Array(items) => items.iter().for_each(|v| refs(v, found)),
                _ => {}
            }
        }
        let schema = present_view_input_schema();
        let mut found = Vec::new();
        refs(&schema, &mut found);
        assert!(!found.is_empty(), "the element branches reference the defs");
        for r in found {
            let pointer = r.strip_prefix('#').expect("a local ref");
            assert!(
                schema.pointer(pointer).is_some(),
                "{r} resolves from the root"
            );
        }
    }

    /// The secret: matched exactly, never by prefix, never by absence.
    #[test]
    fn the_secret_matches_exactly_and_nothing_else() {
        let secret = new_secret();
        assert_eq!(secret.len(), 72, "two uuidv4 strings concatenated");
        assert!(secret_matches(Some(&secret), &secret));
        assert!(!secret_matches(None, &secret));
        assert!(!secret_matches(Some(""), &secret));
        // A prefix of the secret, and the secret plus one, both refused.
        assert!(!secret_matches(Some(&secret[..40]), &secret));
        let mut longer = secret.clone();
        longer.push('x');
        assert!(!secret_matches(Some(&longer), &secret));
        assert!(!secret_matches(Some(&secret), &longer));
    }

    /// The version a refusal names is read from the file, so catalog and
    /// server cannot drift.
    #[test]
    fn the_refusal_names_the_catalog_file_s_version() {
        let catalog: Value = serde_json::from_str(CATALOG_JSON).unwrap();
        assert_eq!(
            catalog_version(),
            format!("temper@{}", catalog["version"].as_str().unwrap())
        );
    }

    /// The live bind: loopback-only, ephemeral, and the wire carries the
    /// catalog-projected schema. Requires the tokio runtime the app builds;
    /// run with the lib suite.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_server_binds_loopback_and_serves_the_catalog_schema() {
        let server = RunningServer::start(surfaceless_context())
            .await
            .expect("the presentation server binds");
        // Ephemeral: a real port, unconfigured.
        let port: u16 = server
            .url
            .strip_prefix("http://127.0.0.1:")
            .and_then(|rest| rest.strip_suffix("/mcp"))
            .and_then(|p| p.parse().ok())
            .expect("the url names the ephemeral port");
        assert_ne!(port, 0);

        // No secret: refused before any dispatch, with an empty body.
        let refused = reqwest::Client::new()
            .post(&server.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)
            .send()
            .await
            .expect("the request reached the server");
        assert_eq!(refused.status(), reqwest::StatusCode::UNAUTHORIZED);
        assert!(
            refused.bytes().await.expect("body read").is_empty(),
            "the refusal carries no detail"
        );

        // The wrong secret: the same refusal.
        let wrong = reqwest::Client::new()
            .post(&server.url)
            .header(SECRET_HEADER, "not-the-secret")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)
            .send()
            .await
            .expect("the request reached the server");
        assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED);

        // The right secret: initialize answers, and tools/list carries the
        // catalog projection.
        let client = reqwest::Client::new();
        let post = |body: String| {
            client
                .post(&server.url)
                .header(SECRET_HEADER, &server.secret)
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .body(body)
        };
        let init = post(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}"#.to_string(),
        )
        .send()
        .await
        .expect("initialize reached the server");
        assert_eq!(init.status(), reqwest::StatusCode::OK);
        let init: Value = init.json().await.expect("initialize answered json");
        assert!(
            init.get("result").is_some(),
            "initialize succeeded with the secret: {init}"
        );

        let tools =
            post(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#.to_string())
                .send()
                .await
                .expect("tools/list reached the server");
        let tools: Value = tools.json().await.expect("tools/list answered json");
        // A 2026-07-28 client refuses a list result without these two.
        assert_eq!(tools["result"]["ttlMs"], json!(0), "got: {tools}");
        assert_eq!(tools["result"]["cacheScope"], json!("private"));
        let tool = &tools["result"]["tools"][0];
        assert_eq!(tool["name"], "temper_present_view");
        assert!(
            tool["inputSchema"]["$defs"].is_object(),
            "the wire schema carries the catalog projection, got: {}",
            tool["inputSchema"]
        );

        // The tool call itself: with no room to render into, the board
        // refuses at once — a named reason, never a hang.
        let call = post(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"temper_present_view","arguments":{"spec":{"root":"x","elements":{}}}}}"#.to_string(),
        )
        .send()
        .await
        .expect("tools/call reached the server");
        assert_eq!(call.status(), reqwest::StatusCode::OK);
        let call: Value = call.json().await.expect("tools/call answered json");
        let text = call["result"]["content"][0]["text"].as_str().unwrap_or("");
        let result: Value = serde_json::from_str(text).expect("the tool result parses");
        assert_eq!(result["ok"], "refused");
        assert_eq!(result["catalogVersion"], catalog_version());
        assert_eq!(result["reasons"], json!(["no surface to render into"]));

        server.stop().await;
    }
}
