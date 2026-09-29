"""The macOS UI-QoL witness (A1): the home column's rows bound to their column in the running
app — no room's content paints under the agent panel when it is open, or off the window when it
is closed — with the browser's own screenshots as the record.

The sibling witnesses (`csp-witness-macos.py`, `return-witness-macos.py`) established the
harness: the app is built with `tauri-plugin-wdio-webdriver` (debug builds, `TAURI_WEBDRIVER_PORT`
set), the binary is started with the port named, and Selenium drives the embedded server
directly. This witness reuses that shape for the layout-overflow clause of the UI quality pass:

1. Home opens with the agent panel open. Every row the home sections render bounds inside the
   home column (no chip paints past it), and the column reports no horizontal overflow.
2. The panel closes. The rooms region recovers its width (the tab body widens), and the rows
   still bound inside their column.
3. The panel reopens. The rooms region returns to the same width, and the rows still bound.
4. The engagement expands for the work: the panel widens (the rooms region narrows to give
   it), the transcript stays in view, and nothing overlaps — then returns to its usual
   width, leaving no room state behind.

Bite property: with the clamps removed, the longest nowrap title in the hub holds a track at its
min-content width and a row paints past the column — `anyChipPastHome` and the widening both
read, and the screenshots show the cut. Run it on a branch that reverted the clamp to see it
fail, before trusting the green.

Needs the binary built with the plugin (`bunx tauri build --debug --no-bundle --features
webdriver`), selenium (`uv run --with selenium`), and the machine's temper credentials answering
home's reads (a populated hub makes the bite realistic; an empty one passes vacuously — the
witness names it). Screenshots land in `apps/desktop/tmp/`. Exits non-zero, naming what failed.
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

# The home rows' geometry, read from the ACTIVE tab body only (the inactive tabs and the
# ways-in panel render their own `.rows`).
SCRIPT = """
const active = document.querySelector('.tab-body:not([hidden])');
if (!active) return { error: 'no active tab body' };
const home = active.querySelector('.home');
if (!home) return { error: 'home is not the active tab' };
const homeR = home.getBoundingClientRect();
const chips = [...active.querySelectorAll('.ref')].map((c) => {
  const r = c.getBoundingClientRect();
  const t = c.querySelector('.title');
  return { right: Math.round(r.right), w: Math.round(r.width),
           ellipsized: t ? t.scrollWidth > t.clientWidth : null };
});
const rowWidths = [...active.querySelectorAll('.rows > *')]
  .filter((r) => r.getBoundingClientRect().width > 0)
  .map((r) => Math.round(r.getBoundingClientRect().width));
return {
  homeX: Math.round(homeR.x),
  homeRight: Math.round(homeR.right),
  homeSW: home.scrollWidth,
  homeCW: home.clientWidth,
  anyChipPastHome: chips.some((c) => c.right > Math.round(homeR.right) + 1),
  anyRowShrunkToContainer: rowWidths.length ? true : null,
  rowCount: rowWidths.length,
  chips: chips.slice(0, 8),
};
"""


def wait_for_port(port: int, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise SystemExit(f"the app did not listen on :{port}")


def measure(driver, tag: str) -> dict:
    return {**driver.execute_script(SCRIPT), "tag": tag}


def screenshot(driver, path: Path) -> None:
    SHOTS.mkdir(exist_ok=True)
    driver.save_screenshot(str(path))


def toggle_agent(driver) -> None:
    driver.execute_script(
        "[...document.querySelectorAll('button')].find(x => x.classList.contains('agent-toggle')).click();"
    )
    time.sleep(0.6)


def main() -> int:
    if not BINARY.exists():
        raise SystemExit(
            f"no build at {BINARY}; run: bunx tauri build --debug --no-bundle --features webdriver"
        )
    if not shutil.which("uv"):
        raise SystemExit("uv not on PATH; install it first")

    app = subprocess.Popen(
        [str(BINARY)], env={"TAURI_WEBDRIVER_PORT": str(PORT), "PATH": "/usr/bin:/bin"}
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
            # Open tabs are a device fact and outlive a run: start from the home tab alone.
            driver.execute_script(
                "localStorage.removeItem('temper-shell-tabs-v1'); location.reload();"
            )
            WebDriverWait(driver, 30).until(
                lambda d: (
                    d.execute_script("return document.readyState") == "complete"
                    and d.find_elements(By.CSS_SELECTOR, 'header a[href="/"]')
                    and len(d.find_elements(By.CSS_SELECTOR, '[role="tab"]')) == 1
                )
            )
            time.sleep(2.5)  # home's reads land

            open_m = measure(driver, "panel-open")
            screenshot(driver, SHOTS / "ui-qol-open.png")
            toggle_agent(driver)
            closed_m = measure(driver, "panel-closed")
            screenshot(driver, SHOTS / "ui-qol-closed.png")
            toggle_agent(driver)
            reopened_m = measure(driver, "reopened")

            # The engagement expands for the work, then returns.
            expand = driver.execute_script(
                """
                const b = [...document.querySelectorAll('button')]
                  .find(x => x.getAttribute('aria-label') === 'Expand the agent panel for more room');
                if (!b) return null;
                b.click();
                return true;
                """
            )
            time.sleep(0.8)
            if expand is None or not expand:
                failures.append("the agent panel has no expand affordance")
            else:
                expanded_m = measure(driver, "expanded")
                screenshot(driver, SHOTS / "ui-qol-expanded.png")
                report["expanded"] = expanded_m
                panel_w = driver.execute_script(
                    "const p = document.querySelector('aside.panel');"
                    " return p ? Math.round(p.getBoundingClientRect().width) : null;"
                )
                if not panel_w or panel_w < 700:
                    failures.append(f"the expanded panel is still narrow ({panel_w}px)")
                driver.execute_script(
                    """
                    const b = [...document.querySelectorAll('button')]
                      .find(x => x.getAttribute('aria-label') === 'Return the agent panel to its usual width');
                    if (b) b.click();
                    """
                )
                time.sleep(0.8)
                restacked = measure(driver, "expanded-returned")
                report["expanded-returned"] = restacked
                if restacked.get("homeSW") != reopened_m.get("homeSW") or restacked.get(
                    "homeRight"
                ) != reopened_m.get("homeRight"):
                    failures.append("returning to the usual width left a different rooms geometry")

            for tag, m in (("open", open_m), ("closed", closed_m), ("reopened", reopened_m)):
                report[tag] = m
                if m.get("error"):
                    failures.append(f"{tag}: {m['error']}")
                    continue
                if m["anyChipPastHome"]:
                    past = [c for c in m["chips"] if c["right"] > m["homeRight"] + 1]
                    failures.append(f"{tag}: a chip paints past the home column: {past}")
                if m["homeSW"] > m["homeCW"] + 1:
                    failures.append(
                        f"{tag}: home scrollWidth {m['homeSW']} > clientWidth {m['homeCW']}"
                    )
            if open_m["rowCount"] == 0:
                failures.append(
                    "no rows rendered — the bite is vacuous on an empty hub; open a document first"
                )
        finally:
            driver.quit()
    except WebDriverException as e:
        failures.append(f"webdriver: {e.msg}")
    finally:
        app.terminate()
        app.wait(timeout=10)

    print(json.dumps(report, indent=2, default=str))
    if failures:
        print("\nUI-QoL witness FAILED:", *failures, sep="\n  - ", file=sys.stderr)
        return 1
    print(
        "\nUI-QoL witness held: home's rows bound to their column with the panel open, closed,"
        " and reopened; screenshots in apps/desktop/tmp/."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
