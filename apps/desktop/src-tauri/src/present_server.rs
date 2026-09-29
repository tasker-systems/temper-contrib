//! The presentation server: the MCP surface an agent calls to put a temper
//! view in front of the person. One tool, `temper_present_view`, whose
//! `inputSchema` is the closed `temper` catalog read from the same file the
//! webview's `checkSpec` validates against — served over streamable HTTP,
//! bound to loopback on an ephemeral port, gated by a per-conversation
//! secret so only the agent process that conversation started can call it.
//!
//! Chunk 1's shape: the server exists and authenticates; the tool's body
//! returns the refused stub until the parked-presentation board (chunk 3)
//! gives it a webview to answer from. Nothing here is reachable from the
//! webview — this module runs in the Rust core, and the app's CSP forbids
//! any `connect-src` addition; the webview reaches answers through Tauri
//! commands and events only.

use std::sync::Arc;

use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, ListToolsResult, PaginatedRequestParams, ServerCapabilities,
    ServerConfig,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
/// Pure and unit-tested; the projection is the only place catalog names are
/// read, so a renamed component surfaces here first.
pub fn present_view_input_schema() -> Value {
    let catalog: Value = serde_json::from_str(CATALOG_JSON).expect("the bundled catalog parses");
    let components = catalog["components"]
        .as_object()
        .expect("the catalog carries components");
    let defs: serde_json::Map<String, Value> = components
        .iter()
        .map(|(name, c)| (name.clone(), c["props"].clone()))
        .collect();
    let element_branches: Vec<Value> = components
        .keys()
        .map(|name| {
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["type", "props"],
                "properties": {
                    "type": { "const": name },
                    "props": { "$ref": format!("#/$defs/{name}") },
                    "children": { "type": "array", "items": { "type": "string" } }
                }
            })
        })
        .collect();
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["spec"],
        "properties": {
            "spec": {
                "type": "object",
                "additionalProperties": false,
                "$defs": defs,
                "required": ["root", "elements"],
                "properties": {
                    "root": { "type": "string" },
                    "elements": {
                        "type": "object",
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

/// The service one conversation's MCP server runs. Fresh per request in
/// stateless mode; the router is not stored as a field (the `#[tool_handler]`
/// macro defaults the two tool methods to `Self::tool_router()`), and the
/// tool body is the chunk-3 stub.
pub struct PresentServer;

#[tool_router]
impl PresentServer {
    pub fn new() -> Self {
        Self
    }

    #[tool(
        description = "Present a temper view (a json-render spec) to the person in a temper-desktop conversation. The spec is checked by the person's desktop against the temper catalog (temper@1.0.0, closed JSON Schema). A rendered answer means the spec passed the check and was mounted as its own tab — never that the person has read it; a reply about the view arrives as the conversation's next message, never in this tool's result. A refused answer names the catalog version and every reason the spec failed."
    )]
    fn temper_present_view(
        &self,
        _args: Parameters<PresentViewArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        refused_not_wired()
    }
}

/// The chunk-3 stub: no parked-presentation board exists yet, so no spec can
/// reach a webview. The end is recorded as refused with a named reason —
/// never a hang, never a partial render.
fn refused_not_wired() -> Result<CallToolResult, ErrorData> {
    let result = json!({
        "ok": "refused",
        "catalogVersion": catalog_version(),
        "reasons": ["not yet wired into a conversation"]
    });
    Ok(CallToolResult::success(vec![ContentBlock::text(
        serde_json::to_string(&result).unwrap_or_else(|e| format!("present result failed: {e}")),
    )]))
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
        Ok(ListToolsResult::with_all_items(tools))
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
    /// Binds loopback, generates the secret, and serves until
    /// [`RunningServer::stop`]. Stateless mode with json responses — the
    /// same assembly temper-mcp runs, minus the deployment-specific pieces.
    /// rmcp's loopback host allowlist stays on: rebinding protection is the
    /// right default for a loopback-only server.
    pub async fn start() -> Result<Self, String> {
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
                    || Ok(PresentServer::new()),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The projection carries every catalog component in `$defs`, closed.
    #[test]
    fn the_schema_projects_every_component_closed() {
        let schema = present_view_input_schema();
        let spec = &schema["properties"]["spec"];
        let defs = spec["$defs"].as_object().expect("$defs is an object");
        let catalog: Value = serde_json::from_str(CATALOG_JSON).unwrap();
        let components = catalog["components"].as_object().unwrap();
        assert_eq!(
            defs.len(),
            components.len(),
            "one $defs entry per component"
        );
        for (name, props) in components {
            let def = &defs[name];
            assert_eq!(def, &props["props"], "props copied verbatim for {name}");
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
    }

    /// A prop the catalog does not declare is refused by the wire schema
    /// itself — the schema is the closed vocabulary, not a promise to check.
    #[test]
    fn the_wire_schema_refuses_an_undeclared_prop() {
        // Hand-judged: jsonschema validation in Rust is out of scope here;
        // this asserts the schema's shape carries the closure, which is what
        // a compliant harness's model would be held to.
        let schema = present_view_input_schema();
        for (_, def) in schema["properties"]["spec"]["$defs"].as_object().unwrap() {
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
        let server = RunningServer::start()
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
        let tool = &tools["result"]["tools"][0];
        assert_eq!(tool["name"], "temper_present_view");
        assert!(
            tool["inputSchema"]["properties"]["spec"]["$defs"].is_object(),
            "the wire schema carries the catalog projection, got: {}",
            tool["inputSchema"]
        );

        // The tool call itself: the chunk's stub speaks the refused end.
        let call = post(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"temper_present_view","arguments":{"spec":{"root":"x","elements":{}}}}}"#.to_string(),
        )
        .send()
        .await
        .expect("tools/call reached the server");
        assert_eq!(call.status(), reqwest::StatusCode::OK);
        let call: Value = call.json().await.expect("tools/call answered json");
        let text = call["result"]["content"][0]["text"].as_str().unwrap_or("");
        let result: Value = serde_json::from_str(text).expect("the stub result parses");
        assert_eq!(result["ok"], "refused");
        assert_eq!(result["catalogVersion"], catalog_version());
        assert!(
            result["reasons"]
                .as_array()
                .map(|r| !r.is_empty())
                .unwrap_or(false),
            "the refusal names its reason"
        );

        server.stop().await;
    }
}
