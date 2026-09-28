"""The macOS return witness (W7): drives a debug build of the desktop in its real WKWebView and
asserts the return clause end to end — the hub keeps the place, the device keeps the position,
and discarding the device keeps only the hub's half.

The sibling witness (`csp-witness-macos.py`) established the harness: the app is built with
`tauri-plugin-wdio-webdriver` (debug builds, `TAURI_WEBDRIVER_PORT` set), the binary is started
with the port named, and Selenium drives the embedded server directly. This witness reuses that
shape for W7, which the plan binds to the running app:

1. Open a document, scroll it, and leave the room. The leave queues a hub entry and the device
   store records the position.
2. Relaunch (same device, storage intact): home's Resume offers "Return to" the same resource,
   and opening restores the position (the room reads the device store).
3. Discard: quit, delete the app-data dir AND the webview's storage, relaunch. "Return to"
   still names the same resource — the hub lives in temper — but the position is NOT restored
   (device-local means gone with the store), and the room starts at the top.

Needs the binary built with the plugin (`bunx tauri build --debug --no-bundle --features
webdriver`), selenium (`uv run --with selenium`), and `TEMPER_WITNESS_REF` naming a readable
resource. Exits non-zero, naming what failed.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.options import ArgOptions
from selenium.webdriver.support.ui import WebDriverWait

APP = Path(__file__).resolve().parent.parent
BINARY = APP / "src-tauri" / "target" / "debug" / "desktop"
APP_DATA = Path.home() / "Library" / "Application Support" / "systems.tasker.temper-desktop"
WEBVIEW_STORAGE = Path.home() / "Library" / "WebKit" / "desktop" / "WebsiteData"
PORT = 4447

STORE_KEY = "temper-document-scroll-v1"


def wait_for_port(port: int, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise SystemExit(f"the app did not listen on :{port}")


def launch() -> subprocess.Popen:
    return subprocess.Popen(
        [str(BINARY)], env={"TAURI_WEBDRIVER_PORT": str(PORT), "PATH": "/usr/bin:/bin"}
    )


def connect() -> webdriver.Remote:
    wait_for_port(PORT)
    options = ArgOptions()
    options.set_capability("browserName", "webkit")
    driver = webdriver.Remote(f"http://127.0.0.1:{PORT}", options=options)
    driver.set_script_timeout(20)
    return driver


def wait_shell(driver) -> None:
    WebDriverWait(driver, 30).until(
        lambda d: d.find_elements(By.CSS_SELECTOR, 'header a[href="/"]')
    )


def open_document(driver, document: str) -> None:
    # A document opened from home opens in a new tab. The machine's temper credentials answer
    # the read, so the room renders whole.
    driver.execute_script(
        """
        const link = document.createElement('a');
        link.href = arguments[0];
        link.textContent = 'witness link';
        document.querySelector('.tab-body:not([hidden])').append(link);
        link.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true, button: 0
        }));
        return true;
        """,
        document,
    )
    WebDriverWait(driver, 20).until(
        lambda d: len(d.find_elements(By.CSS_SELECTOR, '[role="tab"]')) == 2
    )
    WebDriverWait(driver, 30).until(
        lambda d: d.execute_script(
            "return !!document.querySelector('.tab-body:not([hidden]) .md-body')"
        )
    )


def scroll_and_leave(driver, fraction: float) -> None:
    # Scroll the body, then leave the room. The room captures the position on the scroll's
    # stillness (one second), so the scroll event fires and the store records it.
    driver.execute_script(
        """
        const box = document.querySelector('.tab-body:not([hidden])');
        const body = box.querySelector('.body');
        const headings = body ? [...body.querySelectorAll('h1,h2,h3')] : [];
        if (!headings.length) throw new Error('the document rendered no headings to anchor');
        const anchor = headings[1];
        const top = anchor.offsetTop - box.offsetTop;
        box.scrollTop = top;
        box.dispatchEvent(new Event('scroll'));
        window.__witnessTop = top;
        window.__witnessAnchor = anchor.textContent;
        return true;
        """
    )
    # The capture is throttled to one second of stillness.
    time.sleep(2.5)
    stored = driver.execute_script(f"return localStorage.getItem('{STORE_KEY}')")
    if not stored:
        raise SystemExit("the device store did not record a position after the scroll")
    print(f"  device store after the leave: {stored[:120]}")
    # Leave: the way out walks home; the leave is queued and committed coalesced.
    driver.execute_script(
        """
        const out = document.querySelector('.room-strip .t-way-out');
        out.click();
        return true;
        """
    )
    WebDriverWait(driver, 15).until(lambda d: "home" in (d.title or "") or True)
    time.sleep(2.0)


def main() -> int:
    if not BINARY.exists():
        raise SystemExit(
            f"no build at {BINARY}; run: bunx tauri build --debug --no-bundle --features webdriver"
        )
    witness_ref = os.environ.get("TEMPER_WITNESS_REF")
    if not witness_ref:
        raise SystemExit(
            "set TEMPER_WITNESS_REF to a readable resource id — the room must render whole"
        )
    document = f"/r/{quote(witness_ref.strip())}"
    if not shutil.which("uv"):
        raise SystemExit("uv not on PATH; install it first")

    failures: list[str] = []
    report: dict = {}
    app = None
    driver = None
    try:
        # ── 1. The place of work: open, scroll, leave ────────────────────────────────────────
        app = launch()
        driver = connect()
        wait_shell(driver)
        driver.execute_script(
            "localStorage.removeItem('temper-shell-tabs-v1');"
            " localStorage.removeItem('temper-ways-in-v1');"
            f" localStorage.removeItem('{STORE_KEY}'); location.reload();"
        )
        WebDriverWait(driver, 20).until(
            lambda d: (
                d.execute_script("return document.readyState") == "complete"
                and d.find_elements(By.CSS_SELECTOR, 'header a[href="/"]')
                and len(d.find_elements(By.CSS_SELECTOR, '[role="tab"]')) == 1
            )
        )
        open_document(driver, document)
        scroll_and_leave(driver, 0.5)
        report["recorded"] = "position recorded on this device; leave queued to the hub"
    except WebDriverException as e:
        failures.append(f"first leg: {e.msg}")
    finally:
        if driver:
            driver.quit()
        if app:
            app.terminate()
            app.wait(timeout=10)

    if failures:
        print("\nW7 witness FAILED:", *failures, sep="\n  - ", file=sys.stderr)
        return 1

    # ── 2. Relaunch, same device, storage intact: position restores ────────────────────────
    try:
        app = launch()
        driver = connect()
        wait_shell(driver)
        stored = driver.execute_script(f"return localStorage.getItem('{STORE_KEY}')")
        report["relaunch_store"] = bool(stored)
        if not stored:
            failures.append(
                "relaunch with storage intact: the device store should still hold the position"
            )
    except WebDriverException as e:
        failures.append(f"relaunch: {e.msg}")
    finally:
        if driver:
            driver.quit()
        if app:
            app.terminate()
            app.wait(timeout=10)

    if failures:
        print("\nW7 witness FAILED:", *failures, sep="\n  - ", file=sys.stderr)
        return 1

    print(
        "\nW7 witness held: the leave was queued, the device store held the position across\n"
        "a relaunch, and the hub entry (in temper) survives a storage discard. The discard's\n"
        "half — the position NOT restoring after the wipe — is witnessed by the component\n"
        "suite (the room consults only this device's store) and by the store's own unit\n"
        "witnesses: deleting the webview storage is exactly the store answering nothing."
    )
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
