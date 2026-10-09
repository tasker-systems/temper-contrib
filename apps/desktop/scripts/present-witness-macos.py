"""The macOS presentation witness: a presented view lands its tab in the strip, unfocused,
in the running app, and reopens from its temper record.

Chunk 4's gate named this running-app extension and named its obstacle: the harness would
have to stage a rendered answer that the running app records in a real temper context. The
stub agent clears it. The witness hand-configures `scripts/acp-present-stub.py` as an ACP
agent in the settings room and starts a conversation with it; the stub declares MCP HTTP
support, so the core starts the presentation server and hands its URL and per-conversation
secret to the stub inside `session/new` — the only delivery an agent process ever receives.
The stub writes that endpoint to a file; the harness reads it and calls
`temper_present_view` over HTTP itself, speaking the same MCP an HTTP-capable agent would.
From there the app does the work: the webview checks the spec, answers rendered, the record
lands in temper, and the store opens the view's tab in the background.

What it asserts:
1. The tool answers `rendered`, and the record's tab lands in the strip while the active
   tab does not change (`aria-selected` stays where it was).
2. The transcript's presented line reads "checked and rendered", and opening it through the
   line's own affordance focuses the presented tab, whose lens reads the record back from
   temper (`present_read`) and renders it — the agent's name and the view's own content.

Bite property: sever the background open — make `openPresentedTabs` in
`src/lib/agent/session.svelte.ts` activate the tab (call `tabs.activate` on the opened id) —
and assertion 1 fails: the presented tab steals the active tab. Revert, and it holds.

Containment: the whole run happens with the app's person context switched to
`temper-desktop-witness` (the settings room's raw editor; the record path resolves or
creates it), so the person's real context is never written. Resource rooms are the only
leaves the hub writer reports and the witness enters none, so nothing else queues. Cleanup
restores the person context, removes the stub agent, and deletes the witness context's
`Presented views` hubs through the temper CLI — the live record witness's pattern.

Needs the binary built with the plugin (`bunx tauri build --debug --no-bundle --features
webdriver`), selenium (`uv run --with 'selenium>=4.20,<5'`), and the temper CLI
authenticated as the person for cleanup. Screenshots land in `apps/desktop/tmp/`. Exits
non-zero, naming what failed.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from selenium import webdriver
from selenium.common.exceptions import NoSuchElementException, TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.options import ArgOptions
from selenium.webdriver.support.ui import WebDriverWait

APP = Path(__file__).resolve().parent.parent
BINARY = APP / "src-tauri" / "target" / "debug" / "desktop"
STUB = APP / "scripts" / "acp-present-stub.py"
SHOTS = APP / "tmp"
ENDPOINT_FILE = Path("/tmp/temper-present-witness-endpoint.json")
AGENT_KEY = "present-witness"
WITNESS_CONTEXT = os.environ.get("TEMPER_WITNESS_CONTEXT", "temper-desktop-witness")
WITNESS_HUB_TITLE = "Presented views"

# The spec the harness presents: the live record witness's own conforming view
# (src-tauri/src/presentation.rs, `conforming`), one RegionState, nothing else.
SPEC = {
    "root": "r",
    "elements": {
        "r": {
            "type": "RegionState",
            "props": {"state": "failed", "label": "history"},
            "children": [],
        }
    },
}


def wait_for_port(port: int, timeout: float = 60.0) -> None:
    # A cold debug first-launch has taken ~16 s to bind; give it room.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise SystemExit(f"the app did not listen on :{port}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def go_to(driver, path: str) -> None:
    """A client-side navigate through the app's own router: an injected link click,
    the macOS CSP witness's way. A `driver.get` to an http origin goes nowhere here —
    the app's origin is `tauri://localhost` — and a full load re-inits the stores."""
    driver.execute_script(
        """
        const link = document.createElement('a');
        link.href = arguments[0];
        link.textContent = 'witness link';
        document.querySelector('.tab-body:not([hidden])').append(link);
        link.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true, button: 0
        }));
        link.remove();
        """,
        path,
    )
    time.sleep(1.5)


def page_state(driver) -> dict:
    """What the page actually shows when a phase fails: the route, the strip's tabs,
    the signed-out corner, and every field label — the witness names what it saw."""
    return driver.execute_script(
        """
        return {
          path: location.pathname,
          tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()),
          signedOutCorner: !!document.querySelector('a.connect'),
          fields: [...document.querySelectorAll('label.field .t-strip')]
            .map((s) => s.textContent.trim()),
          notices: [...document.querySelectorAll('[role="alert"]')]
            .map((n) => n.textContent.trim().slice(0, 200))
        };
        """
    )


def tab_rows(driver) -> list:
    """The strip's tabs as rows — through the protocol, never script eval."""
    return [
        {"text": t.text.strip(), "selected": t.get_attribute("aria-selected")}
        for t in driver.find_elements(By.CSS_SELECTOR, '[role="tab"]')
    ]


def field_input(driver, name: str, timeout: float = 20.0):
    """The input of the field whose exact label reads `name`, waited for until the
    route's own mount lands. XPath through the WebDriver protocol, never script
    eval — the eval channel wedges under automation, and a wedged channel turns
    every wait into its own timeout."""
    return WebDriverWait(driver, timeout).until(
        lambda d: (
            d.find_elements(
                By.XPATH,
                f"//label[contains(@class, 'field')][.//span[normalize-space(text())='{name}']]"
                "//input",
            )
            or None
        )
    )[0]


def set_value(element, value: str) -> None:
    """A Svelte `bind:value` input: real key events through the protocol fire the
    input events the binding listens for — never a synthetic event over eval."""
    element.clear()
    element.send_keys(value)


def section_button(driver, label_span: str, button_text: str, timeout: float = 20.0):
    """A button inside the section whose rail carries `label_span`, waited for the
    way `field_input` waits."""
    return WebDriverWait(driver, timeout).until(
        lambda d: (
            d.find_elements(
                By.XPATH,
                f"//section[contains(@class, 'ed-rail')]"
                f"[.//span[normalize-space(text())='{label_span}']]"
                f"//button[normalize-space(text())='{button_text}']",
            )
            or None
        )
    )[0]


def read_endpoint(timeout: float = 20.0) -> dict:
    """The stub's capture of `session/new`'s mcpServers — the http entry for `temper`."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if ENDPOINT_FILE.exists():
            payload = json.loads(ENDPOINT_FILE.read_text())
            for server in payload.get("servers", []):
                if server.get("type") == "http" and server.get("name") == "temper":
                    secret = next(
                        h["value"]
                        for h in server.get("headers", [])
                        if h.get("name") == "x-temper-presentation"
                    )
                    return {"url": server["url"], "secret": secret}
            time.sleep(0.2)
        time.sleep(0.2)
    raise SystemExit("the stub never captured the presentation server's endpoint")


def mcp_post(url: str, secret: str, body: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "x-temper-presentation": secret,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())


def clear_endpoint() -> None:
    """A capture from an earlier run must never satisfy this run's poll."""
    if ENDPOINT_FILE.exists():
        ENDPOINT_FILE.unlink()


def cleanup_hubs_via_cli(failures: list[str]) -> None:
    """Delete the witness context's `Presented views` hubs — the record and the artifacts
    on it go with the resource, the way the live record witness cleans up."""
    if not shutil.which("temper"):
        failures.append("the temper CLI is not on PATH — cleanup cannot delete the witness hub")
        return
    listing = subprocess.run(
        [
            "temper",
            "resource",
            "list",
            "--type",
            "hub",
            "--context",
            f"@me/{WITNESS_CONTEXT}",
            "--all",
            "--fields",
            "ref,title",
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if listing.returncode != 0:
        # A context the record path never created is nothing to clean.
        if "not found" in listing.stdout:
            return
        failures.append(f"temper listing the witness context failed: {listing.stderr.strip()}")
        return
    rows = json.loads(listing.stdout)
    for row in rows.get("rows", []):
        if WITNESS_HUB_TITLE not in (row.get("title") or ""):
            continue
        deleted = subprocess.run(
            ["temper", "resource", "delete", row["ref"], "--force"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if deleted.returncode != 0:
            failures.append(
                f"deleting the witness hub {row['ref']} failed: {deleted.stderr.strip()}"
            )


def main() -> int:
    if not BINARY.exists():
        raise SystemExit(
            f"no build at {BINARY}; run: bunx tauri build --debug --no-bundle --features webdriver"
        )
    if not STUB.exists():
        raise SystemExit(f"no stub agent at {STUB}")
    if not shutil.which("uv"):
        raise SystemExit("uv not on PATH; install it first")

    port = free_port()
    cwd = tempfile.mkdtemp(prefix="temper-present-witness-cwd-")
    clear_endpoint()
    SHOTS.mkdir(exist_ok=True)

    app = subprocess.Popen(
        [str(BINARY)], env={"TAURI_WEBDRIVER_PORT": str(port), "PATH": "/usr/bin:/bin"}
    )
    failures: list[str] = []
    report: dict = {}
    driver = None
    prior_context: str | None = None
    agent_configured = False
    try:
        wait_for_port(port)
        options = ArgOptions()
        options.set_capability("browserName", "webkit")
        driver = webdriver.Remote(f"http://127.0.0.1:{port}", options=options)
        driver.set_script_timeout(30)
        WebDriverWait(driver, 30).until(
            lambda d: d.find_elements(By.CSS_SELECTOR, 'header a[href="/"]')
        )
        # Open tabs are a device fact and outlive a run: start from the home tab alone,
        # so "the active tab does not change" is asserted from a known state.
        driver.execute_script(
            "localStorage.removeItem('temper-shell-tabs-v1');"
            " localStorage.removeItem('temper-ways-in-v1'); location.reload();"
        )
        WebDriverWait(driver, 20).until(
            lambda d: (
                d.execute_script("return document.readyState") == "complete"
                and d.find_elements(By.CSS_SELECTOR, 'header a[href="/"]')
                and len(d.find_elements(By.CSS_SELECTOR, '[role="tab"]')) == 1
            )
        )
        report["tabs-before"] = tab_rows(driver)

        # ── The settings room: witness person context, the stub agent ──
        go_to(driver, "/settings")
        try:
            context_input = field_input(driver, "Person context")
        except TimeoutException:
            failures.append(
                "the settings room's Person context field never rendered;"
                f" page state: {page_state(driver)}"
            )
            raise
        prior_context = context_input.get_attribute("value")
        report["prior-context"] = prior_context
        set_value(context_input, WITNESS_CONTEXT)
        section_button(driver, "Person context", "Save").click()
        WebDriverWait(driver, 10).until(
            lambda d: (
                d.find_elements(
                    By.XPATH,
                    "//section[contains(@class, 'ed-rail')]"
                    "[.//span[normalize-space(text())='Person context']]//"
                    "*[@role='status']",
                )
                or None
            ),
            "the Person context save never answered with its saved status",
        )

        agent_form = WebDriverWait(driver, 20).until(
            lambda d: (
                d.find_elements(By.CSS_SELECTOR, '.agent-form[aria-label="Add or change an agent"]')
                or None
            ),
            "the agent form never rendered in the settings room",
        )[0]
        set_value(field_input(driver, "Key"), AGENT_KEY)
        set_value(field_input(driver, "Launch command"), f"python3 {STUB}")
        agent_form.find_element(By.XPATH, ".//button[normalize-space(text())='Save agent']").click()
        WebDriverWait(driver, 10).until(
            lambda d: (
                d.find_elements(
                    By.XPATH,
                    f"//ul[contains(@class, 'agent-list')]//"
                    f"span[normalize-space(text())='{AGENT_KEY}']",
                )
                or None
            ),
            "the configured agent list never carried the stub agent",
        )
        agent_configured = True
        driver.save_screenshot(str(SHOTS / "present-settings.png"))

        # ── Start the conversation: the panel claims the surface ──
        go_to(driver, "/")
        agent_picker = WebDriverWait(driver, 20).until(
            lambda d: (
                d.find_elements(By.CSS_SELECTOR, '.agents[role="group"][aria-label="Agent"]')
                or None
            ),
            "the panel's start section never rendered",
        )[0]
        try:
            agent_picker.find_element(
                By.XPATH, f".//button[normalize-space(text())='{AGENT_KEY}']"
            ).click()
        except NoSuchElementException:
            failures.append(
                f"the panel's agent picker does not carry {AGENT_KEY};"
                f" page state: {page_state(driver)}"
            )
            raise
        set_value(field_input(driver, "Working directory"), cwd)
        driver.find_element(
            By.XPATH, "//button[normalize-space(text())='Start conversation']"
        ).click()
        WebDriverWait(driver, 30).until(
            lambda d: d.find_elements(By.CSS_SELECTOR, ".composer input") or None,
            "the conversation never became live — the composer never rendered",
        )
        report["conversation"] = "started"

        # ── Present: the harness speaks MCP with the stub's captured endpoint ──
        endpoint = read_endpoint()
        report["endpoint"] = endpoint["url"]
        mcp_post(
            endpoint["url"],
            endpoint["secret"],
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": AGENT_KEY, "version": "0"},
                },
            },
        )
        call = mcp_post(
            endpoint["url"],
            endpoint["secret"],
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "temper_present_view", "arguments": {"spec": SPEC}},
            },
        )
        text = call["result"]["content"][0]["text"]
        answer = json.loads(text)
        report["tool-answer"] = answer
        if answer.get("ok") != "rendered":
            failures.append(f"the tool refused instead of rendering: {text}")

        # ── The tab lands in the strip; the active tab does not change ──
        # The strip already carries the home and settings tabs (routes open as
        # tabs), so the assertions key on the active tab's identity, not a count.
        active_before = next((r["text"] for r in tab_rows(driver) if r["selected"] == "true"), None)
        WebDriverWait(driver, 15).until(
            lambda d: any("presented view" in r["text"] for r in tab_rows(d)),
            "the presented view's tab never landed in the strip",
        )
        tabs_after = tab_rows(driver)
        report["tabs-after"] = tabs_after
        presented_tabs = [t for t in tabs_after if "presented view" in t["text"]]
        if len(presented_tabs) != 1:
            failures.append(f"exactly one presented tab expected in the strip: {tabs_after}")
        elif presented_tabs[0]["selected"] != "false":
            failures.append("the presented tab took focus — a background open must never activate")
        still_active = next((r["text"] for r in tabs_after if r["selected"] == "true"), None)
        if still_active != active_before:
            failures.append(
                f"the active tab changed when the view landed: {active_before!r} -> {still_active!r}"
            )
        driver.save_screenshot(str(SHOTS / "present-landed.png"))

        # ── The transcript line reads the resolution; opening it reads the record ──
        transcript_link = WebDriverWait(driver, 15).until(
            lambda d: (
                d.find_elements(
                    By.XPATH,
                    "//button[contains(@class, 'tab-link')]"
                    "[contains(normalize-space(text()), 'checked and rendered')]",
                )
                or None
            ),
            "the transcript line never read the presentation as checked and rendered",
        )[0]
        transcript_link.click()
        WebDriverWait(driver, 15).until(
            lambda d: (
                any(
                    t.get_attribute("aria-selected") == "true"
                    for t in d.find_elements(By.CSS_SELECTOR, '[role="tab"]')
                    if "presented view" in t.text
                )
                and d.find_elements(By.CSS_SELECTOR, ".page.presented")
            ),
            "opening the transcript line never focused the presented tab's lens",
        )
        lens_page = driver.find_element(By.CSS_SELECTOR, ".page.presented")
        says = " ".join(lens_page.text.split())
        # The spec's RegionState is state:"failed", label:"history" — its failure arm is
        # what the record's own view looks like rendered: "<label> unavailable".
        history_leaves = lens_page.find_elements(By.XPATH, ".//*[count(*) = 0]")
        renders_history = any("unavailable" in el.text for el in history_leaves)
        report["presented-lens"] = {"says": says[:200], "history": renders_history}
        if AGENT_KEY not in says:
            failures.append(f"the presented lens does not name the presenting agent: {says}")
        if not renders_history:
            failures.append("the presented lens does not render the record's own view")
        driver.save_screenshot(str(SHOTS / "present-opened.png"))

    except WebDriverException as e:
        failures.append(f"webdriver: {type(e).__name__}: {e.msg!r}")
    finally:
        # ── UI cleanup, best effort, while the app still runs ──
        if driver is not None:
            try:
                if agent_configured:
                    go_to(driver, "/settings")
                    rows = WebDriverWait(driver, 20).until(
                        lambda d: (
                            [
                                li
                                for li in d.find_elements(By.CSS_SELECTOR, ".agent-list li")
                                if li.find_elements(
                                    By.XPATH,
                                    f".//span[normalize-space(text())='{AGENT_KEY}']",
                                )
                            ]
                            or None
                        ),
                        "the stub agent's row never rendered for removal",
                    )[0]
                    rows.find_element(
                        By.XPATH, ".//button[normalize-space(text())='remove']"
                    ).click()
                    time.sleep(1.0)
                if prior_context is not None:
                    context_input = field_input(driver, "Person context")
                    set_value(context_input, prior_context)
                    section_button(driver, "Person context", "Save").click()
                    time.sleep(1.0)
            except (WebDriverException, Exception) as e:  # noqa: BLE001 — cleanup reports, never raises
                failures.append(f"cleanup in the running app failed: {e}")
            try:
                driver.quit()
            except WebDriverException:
                pass
        app.terminate()
        app.wait(timeout=10)
        cleanup_hubs_via_cli(failures)

    print(json.dumps(report, indent=2, default=str))
    if failures:
        print("\nPresentation witness FAILED:", *failures, sep="\n  - ", file=sys.stderr)
        return 1
    print(
        "\nPresentation witness held: the running app recorded the view and its tab landed"
        " in the strip unfocused; the transcript line opened it from its temper record."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
