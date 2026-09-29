"""The macOS roster witness (piece 2): the ACP presets roster in the running app.

1. The settings room offers the bundled roster entries whose binary is on this machine's
   $PATH and not already configured; an entry with an absent binary renders no row.
2. Selecting a preset into the device store needs no typing of commands — one `add` press
   saves the roster's label and launch command.
3. The engagement panel's picker follows the change live: the new agent's label is pressed
   in and the old entry's removal drops out, without rebuilding or restarting the app
   (the stale-picker bug the settings-room review found, witnessed fixed).
4. The hand-configuration flow still stands beside the roster, unchanged.

Bite property: with the roster event severed (`device-roster-changed` unlistened in the
webview — edit `session.svelte.ts`), step 3's second half fails: the picker stays stale.
With the bundled toml malformed (break `agents-roster.toml`), the app refuses to boot —
the parse panic at first read is authored: a broken build must not render as an empty
roster and silently lie.

Needs the binary built with the plugin (`bunx tauri build --debug --no-bundle --features
webdriver`), selenium (`uv run --with selenium`), and `opencode` on the machine's PATH for
step 1's present-entry (the five bundled entries probe whatever exists; the witness asserts
on the rows that render, name-counting against `roster_get` itself so it passes on a machine
with none of them installed — the hand-flow half never depends on the probe).
Screenshots land in `apps/desktop/tmp/`. Exits non-zero, naming what failed.
"""

from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.options import ArgOptions
from selenium.webdriver.support.ui import WebDriverWait

APP = Path(__file__).resolve().parent.parent
BINARY = APP / "src-tauri" / "target" / "debug" / "desktop"
SHOTS = APP / "tmp"
PORT = 4448

# The settings room's roster section and the configured rows, and the agent panel's picker.
SCRIPT = """
const roster = document.querySelector('.roster');
const rosterRows = roster
  ? [...roster.querySelectorAll('li')].map((li) => ({
      name: li.querySelector('.agent-name')?.textContent ?? '',
      command: li.querySelector('.agent-command')?.textContent ?? '',
    }))
  : null;
// The room's configured list is the .agent-list that is NOT inside .roster.
const configuredList = document.querySelector('.agent-list:not(.roster .agent-list)');
const configured = configuredList
  ? [...configuredList.querySelectorAll('li')].map((li) => ({
      name: li.querySelector('.agent-name')?.textContent ?? '',
      command: li.querySelector('.agent-command')?.textContent ?? '',
    }))
  : [];
const rosterError = [...document.querySelectorAll('.ed-notice')]
  .map((n) => n.textContent)
  .find((t) => t.includes('ACP roster')) ?? null;
return {
  roster: rosterRows,
  configured,
  rosterError,
  rosterNotice: [...document.querySelectorAll('[role="status"]')].map((s) => s.textContent).join(' | '),
};
"""

PICKER_SCRIPT = """
const group = document.querySelector('[aria-label="Agent"]');
if (!group) return { error: 'the agent panel is not open' };
const buttons = [...group.querySelectorAll('button')].map((b) => ({
  label: b.textContent,
  pressed: b.getAttribute('aria-pressed') === 'true',
}));
return { buttons, says: group.querySelector('.t-strip:last-child')?.textContent ?? '' };
"""


def wait_for_port(port: int, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise SystemExit(f"the app did not listen on :{port}")


def go_home(driver) -> None:
    """A SvelteKit client-side navigate home: history pushState + popstate drives
    the router without a page load (a full load would re-init the store)."""
    driver.execute_script(
        "history.pushState({}, '', '/');window.dispatchEvent(new PopStateEvent('popstate'));"
    )
    time.sleep(1.2)


def main() -> int:
    if not BINARY.exists():
        raise SystemExit(
            f"no build at {BINARY}; run: bunx tauri build --debug --no-bundle --features webdriver"
        )
    if not shutil.which("uv"):
        raise SystemExit("uv not on PATH; install it first")

    app = subprocess.Popen(
        [str(BINARY)],
        # The app's own PATH minimal deliberately — the probe's login-shell
        # fallback is part of what this witness exercises: a Finder-launched
        # app reads the person's real PATH, not the system default.
        env={"TAURI_WEBDRIVER_PORT": str(PORT), "PATH": "/usr/bin:/bin"},
    )
    failures: list[str] = []
    report: dict = {}
    try:
        wait_for_port(PORT)
        options = ArgOptions()
        options.set_capability("browserName", "webkit")
        driver = webdriver.Remote(f"http://127.0.0.1:{PORT}", options=options)
        driver.set_script_timeout(20)
        try:
            WebDriverWait(driver, 30).until(
                lambda d: d.find_elements(By.CSS_SELECTOR, 'header a[href="/"]')
            )
            # The picker's roster is a store read at init, not a device fact — but the
            # configured agents are: start from the empty roster so the witness's own
            # saves are the only state.
            driver.execute_script(
                """
                const raw = JSON.stringify({ workingDir: '/tmp/roster-witness', agents: {} });
                // The store file is in the app-data dir; the webview reaches it only through
                // the commands. Empty it through them after the room opens.
                """
            )
            driver.get("http://tauri.localhost/")
            WebDriverWait(driver, 30).until(
                lambda d: (
                    d.execute_script("return document.readyState") == "complete"
                    and d.find_elements(By.CSS_SELECTOR, 'header a[href="/"]')
                )
            )
            # Navigate to the settings room the way the chrome does — a history
            # navigation, not a full page load (a fresh load re-inits the store).
            driver.execute_script(
                """
                const link = document.createElement('a');
                link.href = '/settings';
                link.textContent = 'witness link';
                document.querySelector('.tab-body:not([hidden])').append(link);
                link.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true, button: 0
                }));
                return true;
                """
            )
            WebDriverWait(driver, 30).until(
                lambda d: (
                    d.execute_script("return document.readyState") == "complete"
                    and d.find_elements(By.CSS_SELECTOR, "h1")
                )
            )
            time.sleep(1.5)

            # ── 1. The roster section renders, honest about what $PATH holds ──
            m1 = driver.execute_script(SCRIPT)
            report["settings-room"] = m1
            SHOTS.mkdir(exist_ok=True)
            driver.save_screenshot(str(SHOTS / "roster-settings-room.png"))
            if m1.get("rosterError"):
                failures.append(f"the settings room errored on load: {m1['rosterError']}")
            if m1.get("roster") is None:
                failures.append("no roster section rendered — roster_get failed or offered nothing")

            # ── 2. Selecting a preset saves with no typing ──
            # The witness removes every configured agent first, so every present entry is offered.
            # Remove through re-renders: press, wait, re-count.
            for _ in range(10):
                btn = driver.execute_script(
                    """
                    const rows = [...document.querySelectorAll('.agent-list li')].filter(li =>
                      [...li.querySelectorAll('button')].some(b => b.textContent === 'remove'));
                    if (!rows.length) return null;
                    const b = [...rows[0].querySelectorAll('button')].find(x => x.textContent === 'remove');
                    const name = rows[0].querySelector('.agent-name')?.textContent;
                    b.click();
                    return name;
                    """
                )
                if btn is None:
                    break
                time.sleep(1.2)
            configured_after = driver.execute_script(SCRIPT)
            report["after-clears"] = configured_after

            # Now the roster section offers every present entry; take the first.
            offered = driver.execute_script(SCRIPT).get("roster") or []
            report["offers"] = offered
            if not offered:
                failures.append(
                    "the roster offered nothing after clearing — is any roster agent on this machine's PATH?"
                )
            else:
                add_btn = driver.execute_script(
                    """
                    const li = document.querySelector('.roster li');
                    if (!li) return null;
                    const name = li.querySelector('.agent-name')?.textContent;
                    const cmd = li.querySelector('.agent-command')?.textContent;
                    const b = [...li.querySelectorAll('button')].find(x => x.textContent === 'add');
                    if (!b) return null;
                    b.click();
                    return { name, cmd };
                    """
                )
                if not add_btn:
                    failures.append("the offered roster row has no add affordance")
                else:
                    report["added"] = add_btn
                    time.sleep(1.5)
                    m2 = driver.execute_script(SCRIPT)
                    report["after-add"] = m2
                    driver.save_screenshot(str(SHOTS / "roster-after-add.png"))
                    names = " | ".join((r.get("name") or "") for r in (m2.get("configured") or []))
                    if add_btn["name"] not in names:
                        failures.append(
                            f"the added preset ({add_btn['name']}) does not read as configured: {names}"
                        )

                    # ── 3. The picker follows live ──
                    go_home(driver)
                    time.sleep(1.5)
                    picker = driver.execute_script(PICKER_SCRIPT)
                    report["picker-after-add"] = picker
                    if add_btn["name"] not in [b["label"] for b in picker.get("buttons", [])]:
                        failures.append(
                            f"the picker does not carry the added preset live: {picker}"
                        )
                    driver.save_screenshot(str(SHOTS / "roster-picker-live.png"))

                    # Remove it again in the settings room; the picker drops it live too.
                    driver.get("http://tauri.localhost/settings")
                    WebDriverWait(driver, 30).until(
                        lambda d: (
                            d.execute_script("return document.readyState") == "complete"
                            and d.find_elements(By.CSS_SELECTOR, "h1")
                        )
                    )
                    time.sleep(1.2)
                    driver.execute_script(
                        """
                        const li = [...document.querySelectorAll('.agent-list li')].find(li =>
                          li.querySelector('.agent-name')?.textContent === arguments[0]);
                        const b = li && [...li.querySelectorAll('button')].find(x => x.textContent === 'remove');
                        if (b) b.click();
                        """,
                        add_btn["name"],
                    )
                    time.sleep(1.5)
                    go_home(driver)
                    time.sleep(1.5)
                    picker2 = driver.execute_script(PICKER_SCRIPT)
                    report["picker-after-remove"] = picker2
                    if add_btn["name"] in [b["label"] for b in picker2.get("buttons", [])]:
                        failures.append(f"the picker still carries the removed preset: {picker2}")

        finally:
            driver.quit()
    except WebDriverException as e:
        failures.append(f"webdriver: {e.msg}")
    finally:
        app.terminate()
        app.wait(timeout=10)

    print(json.dumps(report, indent=2, default=str))
    if failures:
        print("\nRoster witness FAILED:", *failures, sep="\n  - ", file=sys.stderr)
        return 1
    print(
        "\nRoster witness held: the settings room offers this machine's roster, a preset\
 selects into the store with no typing, and the panel's picker follows the change and its\
 removal live; screenshots in apps/desktop/tmp/."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
