//! The harness-fidelity probe: a minimal MCP streamable-HTTP server that
//! advertises one tool, `temper_present_view`, whose `inputSchema` comes
//! from the real presentation server's projection. It answers one question:
//! does each ACP harness pass that schema through to its model faithfully
//! enough that the model constructs closed-catalog-conforming specs, or
//! does it mangle `$defs` / `oneOf` / `additionalProperties: false`?
//!
//! The tool's schema and result vocabulary are the server's own — the probe
//! projects nothing of its own and names no catalog constant, so what the
//! harnesses see is byte-for-byte what the shipped server serves.

use std::sync::{Arc, Mutex};

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
use serde_json::{json, Value};

use crate::present_server::{
    catalog_version, present_view_input_schema, PresentViewArgs, CATALOG_JSON,
};

/// The probe's service: the presentation server's tool, recorded. The
/// `ToolRouter` is not stored as a field — under rmcp ≥ 1.4 the
/// `#[tool_handler]` macro defaults `list_tools`/`call_tool` to
/// `Self::tool_router()`, so storing it would double the routes.
struct PresentProbe {
    calls: Arc<Mutex<Vec<Value>>>,
}

#[tool_router]
impl PresentProbe {
    fn new(calls: Arc<Mutex<Vec<Value>>>) -> Self {
        Self { calls }
    }

    #[tool(
        description = "Present a temper view (a json-render spec) to the person in a temper-desktop conversation. The spec is checked against the temper catalog (temper@1.0.0, closed JSON Schema). A rendered answer means the spec passed the check and was mounted — never that the person has read it; a reply about a view arrives as the conversation's next message. A refused answer names the catalog version and every reason the spec failed."
    )]
    fn temper_present_view(
        &self,
        raw: Parameters<PresentViewArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // The raw args, before any projection: what the harness's model
        // actually sent is what the fidelity witness judges, unnormalized.
        self.calls
            .lock()
            .unwrap()
            .push(serde_json::to_value(raw.0.clone()).unwrap_or(Value::Null));
        // The probe's own closed-catalog check — the same shape the webview's
        // checkSpec judges, run here so the verdict a call earns is what the
        // witness reads.
        let checked = check_spec(&raw.0.spec);
        let result = match checked {
            Ok(()) => json!({ "ok": "rendered", "catalogVersion": catalog_version() }),
            Err(errors) => json!({
                "ok": "refused",
                "catalogVersion": catalog_version(),
                "reasons": errors
            }),
        };
        Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string(&result).unwrap_or_else(|e| format!("probe result failed: {e}")),
        )]))
    }
}

/// The tool `inputSchema` on the wire: the catalog projection the shipped
/// server serves — the probe names no schema of its own.
fn tools_with_catalog_schema() -> Vec<rmcp::model::Tool> {
    PresentProbe::tool_router()
        .list_all()
        .into_iter()
        .map(|mut tool| {
            if tool.name == "temper_present_view" {
                tool.input_schema = Arc::new(
                    present_view_input_schema()
                        .as_object()
                        .expect("the projected schema is an object")
                        .clone(),
                );
            }
            tool
        })
        .collect()
}

#[tool_handler]
impl ServerHandler for PresentProbe {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            rmcp::model::Implementation::new("temper-present-probe", "0.1.0"),
        )
    }

    /// Manual override — `#[tool_handler]` generates `list_tools` only when
    /// the impl lacks one (the same door temper-mcp uses to filter its blob
    /// doors at the wire). The schema on the wire is the catalog projection
    /// the shipped server serves.
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tools_with_catalog_schema()))
    }
}

/// The closed spec check, run here exactly as the webview's `checkSpec` will
/// judge after the real server lands: element types must be catalog names,
/// props must satisfy the component's closed schema, and the root must name
/// an element. Row-count invariants are catalog-only and not probed here.
/// The spec shape is json-render's own — `{ root, elements }` directly, the
/// same shape the webview's `checkSpec` reads at `catalog.ts:65-68` — not
/// the tool-args envelope around it.
fn check_spec(spec: &Value) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let catalog: Value = serde_json::from_str(CATALOG_JSON).expect("the bundled catalog parses");
    let components = catalog["components"]
        .as_object()
        .expect("the catalog carries components");

    let Some(elements) = spec.get("elements").and_then(Value::as_object) else {
        return Err(vec!["spec has no elements".to_string()]);
    };
    for (key, element) in elements {
        let Some(el_type) = element.get("type").and_then(Value::as_str) else {
            errors.push(format!("elements/{key}: no type"));
            continue;
        };
        let Some(props) = components.get(el_type) else {
            errors.push(format!(
                "elements/{key}: component {el_type} outside the catalog"
            ));
            continue;
        };
        if let Err(props_errors) = check_props(&element["props"], &props["props"], el_type) {
            for e in props_errors {
                errors.push(format!("elements/{key}/props: {e}"));
            }
        }
    }
    // The root must name an element that exists, so a refusal is never a
    // silently-hidden branch.
    let root = spec.get("root").and_then(Value::as_str);
    if let Some(root) = root {
        if !elements.contains_key(root) {
            errors.push(format!("root: \"{root}\" is not an element"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// The probe's own check, exposed for the witness: the same function the
/// tool handler runs, so a call's verdict in the witness is the verdict the
/// tool returned.
pub fn check_spec_public(spec: &Value) -> SpecVerdict {
    match check_spec(spec) {
        Ok(()) => SpecVerdict::Conforming,
        Err(errors) => SpecVerdict::Refused(errors),
    }
}

/// What the probe's check said about one call, in words the finding table
/// can carry.
pub enum SpecVerdict {
    Conforming,
    Refused(Vec<String>),
}

impl SpecVerdict {
    pub fn describe(&self) -> String {
        match self {
            SpecVerdict::Conforming => "conforming to the closed catalog".to_string(),
            SpecVerdict::Refused(errors) => format!("refused: {}", errors.join("; ")),
        }
    }
}

/// One component's props against its schema: required present, no property
/// the schema does not declare, and an enum-valued prop among its variants.
fn check_props(props: &Value, schema: &Value, component: &str) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let Some(props) = props.as_object() else {
        return Err(vec![format!("{component} carries no props object")]);
    };
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for r in required {
            let name = r.as_str().expect("required entries are strings");
            if !props.contains_key(name) {
                errors.push(format!("{component} omits required prop {name}"));
            }
        }
    }
    let declared = schema.get("properties").and_then(Value::as_object);
    if let Some(declared) = declared {
        for (name, _value) in props {
            if !declared.contains_key(name) {
                errors.push(format!(
                    "{component} carries prop {name} that its schema does not declare"
                ));
            }
        }
        for (name, prop_schema) in declared {
            if let Some(value) = props.get(name) {
                if let Some(variants) = prop_schema.get("enum").and_then(Value::as_array) {
                    if !variants.iter().any(|v| v == value) {
                        errors.push(format!(
                            "{component} prop {name} does not match its declared variants"
                        ));
                    }
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// What the probe binds and serves. The port is ephemeral (`:0`); the caller
/// reads it back and hands the URL to the harness.
pub struct ProbeServer {
    pub base_url: String,
    calls: Arc<Mutex<Vec<Value>>>,
    shutdown: tokio::sync::watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl ProbeServer {
    /// Binds loopback and serves the tool over streamable HTTP until
    /// [`ProbeServer::stop`]. Stateless mode, json responses, and rmcp's
    /// loopback host allowlist left ON (this is a local fixture; rebinding
    /// protection is the right default here) — mirroring temper-mcp's
    /// `StreamableHttpService` assembly, minus the deployment-specific pieces.
    /// The port is ephemeral by default; `TEMPER_PROBE_PORT` pins it for a
    /// manual wire-level probe of what a harness sends the URL.
    pub async fn start() -> Result<Self, String> {
        let calls: Arc<Mutex<Vec<Value>>> = Arc::default();
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let listener = match std::env::var("TEMPER_PROBE_PORT") {
            Ok(port) if !port.is_empty() => {
                tokio::net::TcpListener::bind(("127.0.0.1", port.parse::<u16>().unwrap_or(0))).await
            }
            _ => tokio::net::TcpListener::bind("127.0.0.1:0").await,
        };
        let listener = listener.map_err(|e| format!("the probe could not bind loopback: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("the probe bound but could not read its port: {e}"))?;

        let mcp_service = StreamableHttpService::new(
            // Stateless mode builds a fresh service per request, so the
            // factory is a plain constructor — but the call record is shared,
            // cloned here, so the witness reads every harness's calls.
            {
                let calls = calls.clone();
                move || Ok(PresentProbe::new(calls.clone()))
            },
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default()
                .with_legacy_session_mode(false)
                .with_json_response(true),
        );
        let app = Router::new().nest_service("/mcp", mcp_service);

        let handle = tokio::spawn(async move {
            let mut rx = shutdown_rx;
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = rx.wait_for(|stopped| *stopped).await;
                })
                .await;
        });

        Ok(Self {
            base_url: format!("http://{addr}/mcp"),
            calls,
            shutdown: shutdown_tx,
            handle,
        })
    }

    /// Every `temper_present_view` call the harness's models have made, as
    /// their serialized args — what the fidelity witness asserts over.
    pub fn recorded_calls(&self) -> Vec<Value> {
        self.calls.lock().unwrap().clone()
    }

    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}
