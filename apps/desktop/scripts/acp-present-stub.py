"""The presentation witness's stub ACP agent.

A real agent process, speaking ACP over stdio, that exists to hand the running-app
witness the one thing only an agent process ever receives: the presentation server's
URL and per-conversation secret, delivered inside `session/new`'s `mcpServers`.

It answers the three requests the desktop's conversation loop sends —
`initialize` (declaring MCP HTTP support, so the presentation gate starts the
server for this conversation), `session/new` (capturing the MCP server entry to a
fixed file), and `session/prompt` (`end_turn`, immediately; the stub never calls a
tool itself). Anything else is ignored, so `session/cancel` and notifications cost
nothing.

The captured endpoint lands at `/tmp/temper-present-witness-endpoint.json`,
written by rename so a reader never sees a half-written file. The witness reads it
and calls the presentation server directly, speaking MCP over HTTP — exactly what
an HTTP-capable agent would do with the same `session/new` delivery.

Run by the app, never by hand: the witness hand-configures it in the settings room
as `python3 <this file>`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ENDPOINT_FILE = Path("/tmp/temper-present-witness-endpoint.json")


def answer(request: dict) -> dict | None:
    """The reply for one JSON-RPC request, or None for a notification."""
    if "id" not in request:
        return None
    method = request.get("method")
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": {
                # `protocolVersion` is a bare number on the wire (schema version.rs).
                "protocolVersion": 1,
                "agentCapabilities": {"mcpCapabilities": {"http": True}},
                "agentInfo": {"name": "present-witness", "version": "0"},
            },
        }
    if method == "session/new":
        servers = (request.get("params") or {}).get("mcpServers") or []
        staging = ENDPOINT_FILE.with_suffix(".json.tmp")
        staging.write_text(json.dumps({"servers": servers}))
        staging.replace(ENDPOINT_FILE)
        return {
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": {"sessionId": "witness-session"},
        }
    if method == "session/prompt":
        return {
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": {"stopReason": "end_turn"},
        }
    return {
        "jsonrpc": "2.0",
        "id": request["id"],
        "error": {"code": -32601, "message": f"method not supported: {method}"},
    }


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        reply = answer(request)
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
