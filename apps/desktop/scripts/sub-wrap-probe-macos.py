"""The macOS sub-wrap probe: the resume rows' `.sub` ("in its home lens, N days ago") at the
narrowest width the app renders — does the text still word-per-line, as Pete flagged?

A probe, not a witness: it measures and reports, judging nothing. Read the numbers, pick the
fix, and only then give it a witness.

Run: uv run --with selenium python scripts/sub-wrap-probe-macos.py
"""

from __future__ import annotations

import json
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
PORT = 4448

# The resume section's rows: chip box, sub box, sub's text line boxes, and each line's word count.
SCRIPT = """
const active = document.querySelector('.tab-body:not([hidden])');
if (!active) return { error: 'no active tab body' };
const resume = active.querySelector('[data-resume]');
if (!resume) return { error: 'no resume card on home' };
const card = resume.closest('.rows')?.parentElement ?? resume.parentElement;
const rows = [...active.querySelectorAll('.row')].filter(r => r.querySelector('.sub'));
if (!rows.length) return { error: 'no resume rows with a .sub' };
return {
  rows: rows.map((row) => {
    const sub = row.querySelector('.sub');
    const ref = row.querySelector('.ref');
    const rowR = row.getBoundingClientRect(), subR = sub.getBoundingClientRect();
    const refR = ref.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(sub);
    const rects = [...range.getClientRects()];
    const tops = [...new Set(rects.map(x => Math.round(x.top)))];
    // per-line width sums: word-per-line = many lines of tiny width
    const lines = {};
    for (const r of rects) {
      const top = Math.round(r.top);
      (lines[top] ??= []).push(r);
    }
    const lineShapes = Object.values(lines).map(rs =>
      rs.map(r => (r.width < 40 ? 'W' : 'T')).join(''));  // W=tiny word T=text run
    return {
      rowW: Math.round(rowR.width),
      chipW: Math.round(refR.width),
      chipTop: Math.round(refR.top),
      subW: Math.round(subR.width),
      subTop: Math.round(subR.top),
      textLines: tops.length,
      lineShapes,
      subRight: Math.round(subR.right),
      rowRight: Math.round(rowR.right),
    };
  }),
  windowW: innerWidth,
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


def main() -> int:
    if not BINARY.exists():
        raise SystemExit(
            f"no build at {BINARY}; run: bunx tauri build --debug --no-bundle --features webdriver"
        )
    app = subprocess.Popen(
        [str(BINARY)], env={"TAURI_WEBDRIVER_PORT": str(PORT), "PATH": "/usr/bin:/bin"}
    )
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
            driver.execute_script(
                "localStorage.removeItem('temper-shell-tabs-v1'); location.reload();"
            )
            WebDriverWait(driver, 30).until(
                lambda d: (
                    d.execute_script("return document.readyState") == "complete"
                    and d.find_elements(By.CSS_SELECTOR, 'header a[href="/"]')
                )
            )
            time.sleep(2.5)

            at_default = driver.execute_script(SCRIPT)
            print(json.dumps({"at-default-window": at_default}, indent=2))

            # The narrowest: window shrunk to the minimum the app still renders.
            driver.set_window_size(900, 800)
            time.sleep(1.0)
            at_narrow = driver.execute_script(SCRIPT)
            print(json.dumps({"at-900px-window": at_narrow}, indent=2))
            driver.set_window_size(560, 800)
            time.sleep(1.0)
            at_min = driver.execute_script(SCRIPT)
            print(json.dumps({"at-560px-window": at_min}, indent=2))
        finally:
            driver.quit()
    except WebDriverException as e:
        print(f"webdriver: {e.msg}", file=sys.stderr)
        return 1
    finally:
        app.terminate()
        app.wait(timeout=10)
    return 0


if __name__ == "__main__":
    sys.exit(main())
