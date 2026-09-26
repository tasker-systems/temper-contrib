use agent_client_protocol::schema::v1::{
    InitializeRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SessionNotification,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo};
use std::str::FromStr;

/// Spawns an ACP agent subprocess and completes the `initialize` handshake.
///
/// Returns the agent's reported protocol version and capabilities. This is
/// the desktop acting as ACP client; prompts and session management build on
/// this in the chat work.
#[tauri::command]
pub async fn acp_initialize(command: String) -> Result<serde_json::Value, String> {
    let agent = AcpAgent::from_str(&command).map_err(|e| e.to_string())?;

    Client.builder()
        .on_receive_notification(
            async |notification: SessionNotification, _cx| {
                eprintln!("acp: notification {:?}", notification.update);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async |request: RequestPermissionRequest, responder, _connection| {
                // The mechanical skeleton never approves anything on the
                // person's behalf; a permission request with no UI to ask in
                // is declined.
                eprintln!("acp: declining permission request {request:?}");
                responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            let init = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            serde_json::to_value(&init)
                .map_err(|e| agent_client_protocol::util::internal_error(e.to_string()))
        })
        .await
        .map_err(|e| e.to_string())
}

/// Witness for the handshake clause: spawns `opencode acp` and asserts the
/// agent answered `initialize`. Ignored by default — it needs the agent
/// binary, which CI runners do not have. Run locally:
/// `cargo test -p desktop-lib -- --ignored`
#[cfg(test)]
mod tests {
    #[tokio::test]
    #[ignore = "requires opencode on PATH"]
    async fn opencode_answers_initialize() {
        let result = super::acp_initialize("opencode acp".to_string())
            .await
            .expect("initialize handshake with opencode acp");
        assert!(
            result.get("protocolVersion").is_some(),
            "agent should report a protocol version, got: {result}"
        );
    }
}
