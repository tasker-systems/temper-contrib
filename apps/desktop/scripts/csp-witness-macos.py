"""The macOS CSP witness: drives a debug build of the desktop in its real WKWebView — the engine
the app ships on this platform — and asserts the shipped CSP holds with the editor mounted.

The shipped witness (`scripts/csp-witness.py`) runs under tauri-driver, which has no WKWebView
driver for macOS. This witness fills that gap: the app is built with `tauri-plugin-wdio-webdriver`
(debug builds only, and only when `TAURI_WEBDRIVER_PORT` is set), the binary is started with the
port named, and Selenium drives the embedded server directly — no tauri-driver, no WebKitWebDriver,
no display server. On Linux CI the shipped witness remains the authority; this one covers macOS
locally, the platform the other cannot.

What it asserts, with the editor mounted in a document tab:
1. The app is whole under the policy: theme roles resolved, the bundled reading font loaded, the
   shell and its agent panel rendered, and no `securitypolicyviolation` while it is driven —
   including the document opened in a tab and the editor mounted inside its shadow root.
2. The policy is a backstop: an injected inline script and an inline style attribute are each
   refused.
3. The editor is styled: CodeMirror's base theme applies inside the shadow root (the spike's
   finding — constructable stylesheets, outside `style-src`), the document text is visible, and
   a one-word edit lands in the bound draft state.
4. The view catalog renders every component under the policy and paints only from theme roles,
   in every theme (`catalog_paint.py`).

Needs the binary built with the plugin (`bunx tauri build --debug --no-bundle`) and selenium
(`uv run --with selenium scripts/csp-witness-macos.py`). Exits non-zero, naming what failed.
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

from catalog_paint import witness_catalog
from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.options import ArgOptions
from selenium.webdriver.support.ui import WebDriverWait

APP = Path(__file__).resolve().parent.parent
BINARY = APP / "src-tauri" / "target" / "debug" / "desktop"
PORT = 4446
REMOTE = "https://example.com"

# Recorded on the document, which lives as long as the window.
LISTEN = """
window.__csp = window.__csp || [];
if (!window.__cspListening) {
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({
    directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, sample: e.sample
  }));
  window.__cspListening = true;
}
"""

# A document, addressed by a well-formed reference. The witness opens a real document — the
# machine's temper credentials answer the read — so the room renders whole and offers Edit.
# `TEMPER_WITNESS_REF` names a readable resource; the scratch the save witnesses use is fine.

PROBES = """
const done = arguments[arguments.length - 1];
const out = {};
const marker = document.createElement('div');
document.body.append(marker);

const inline = document.createElement('script');
inline.textContent = 'window.__injected = true;';
document.body.append(inline);
out.inlineScriptRan = window.__injected === true;

const before = getComputedStyle(marker).outlineStyle;
marker.setAttribute('style', 'outline: 3px solid;');
out.styleAttrApplied = getComputedStyle(marker).outlineStyle !== before;

setTimeout(() => done(out), 500);
"""

HELD = {
    "inline script is refused": lambda p: not p["inlineScriptRan"],
    "inline style attribute is refused": lambda p: not p["styleAttrApplied"],
}


def wait_for_port(port: int, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise SystemExit(f"the app did not listen on :{port}")


def editor_health(shadow) -> list[str]:
    problems = []
    content = shadow.find_element(By.CSS_SELECTOR, ".cm-content")
    if not content.text.strip():
        problems.append("the editor shows no content")
    line = shadow.find_element(By.CSS_SELECTOR, ".cm-line")
    # The base theme applies when the computed style is not the UA default — measure a
    # property style-mod itself sets rather than one the engine could default.
    if line.value_of("css") == "":
        problems.append("the editor's base theme did not apply")
    return problems


def main() -> int:
    if not BINARY.exists():
        raise SystemExit(f"no build at {BINARY}; run: bunx tauri build --debug --no-bundle")
    witness_ref = os.environ.get("TEMPER_WITNESS_REF")
    if not witness_ref:
        raise SystemExit(
            "set TEMPER_WITNESS_REF to a readable resource id — the room must render whole to"
            " offer Edit"
        )
    document = f"/r/{quote(witness_ref.strip())}"
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
            WebDriverWait(driver, 20).until(
                lambda d: d.find_elements(By.CSS_SELECTOR, 'header a[href="/"]')
            )
            # Open tabs are a device fact and outlive a run: start from the home tab alone.
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
            driver.execute_script(LISTEN)

            # A document opened from home opens in a new tab. The machine's temper credentials
            # answer the read, so the room renders whole and offers Edit.
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
            WebDriverWait(driver, 10).until(
                lambda d: len(d.find_elements(By.CSS_SELECTOR, '[role="tab"]')) == 2
            )
            # The room is the active tab's body.
            WebDriverWait(driver, 10).until(
                lambda d: d.execute_script(
                    "return !!document.querySelector('.tab-body:not([hidden])')"
                )
            )

            # Mount the editor through the room's own Edit affordance: the person's path.
            WebDriverWait(driver, 20).until(
                lambda d: d.execute_script(
                    """
                    const body = document.querySelector('.tab-body:not([hidden])');
                    return [...(body?.querySelectorAll('button') ?? [])].some(
                      (b) => b.textContent.trim() === 'Edit'
                    );
                    """
                )
            )
            driver.execute_script(
                """
                const body = document.querySelector('.tab-body:not([hidden])');
                const edit = [...body.querySelectorAll('button')].find(
                  (b) => b.textContent.trim() === 'Edit'
                );
                edit.click();
                """
            )
            WebDriverWait(driver, 10).until(
                lambda d: d.execute_script(
                    """
                    const body = document.querySelector('.tab-body:not([hidden])');
                    const host = body.querySelector('.editor');
                    return !!(host && host.shadowRoot &&
                              host.shadowRoot.querySelector('.cm-content'));
                    """
                )
            )

            # The editor's health, read through the shadow root.
            shadow = driver.execute_script(
                """
                const body = document.querySelector('.tab-body:not([hidden])');
                const host = body.querySelector('.editor');
                const shadow = host.shadowRoot;
                const content = shadow.querySelector('.cm-content');
                const line = shadow.querySelector('.cm-line');
                const style = line ? getComputedStyle(line) : null;
                return {
                  content: content ? content.textContent.slice(0, 100) : null,
                  docBytes: content ? content.textContent.length : 0,
                  // The base theme sets padding on lines: its presence is what the CSP turns on.
                  linePadding: style ? style.paddingLeft : null,
                  // style-mod's stylesheet is adopted, not a refused tag.
                  adopted: shadow.adoptedStyleSheets.length
                };
                """
            )
            report["editor"] = shadow
            if not shadow["docBytes"]:
                failures.append("the editor's shadow root shows no document text")
            if shadow["linePadding"] in (None, "", "0px"):
                failures.append("the editor's base theme did not apply")

            # The view catalog, opened as a tab: every component under the policy, painting
            # only from theme roles, in every theme.
            def open_catalog(d) -> None:
                d.execute_script(
                    """
                    const link = document.createElement('a');
                    link.href = '/catalog';
                    document.querySelector('.tab-body:not([hidden])').append(link);
                    link.dispatchEvent(new MouseEvent('click', {
                      bubbles: true, cancelable: true, button: 0, metaKey: true
                    }));
                    link.remove();
                    """
                )

            report["catalog"], catalog_failures = witness_catalog(driver, open_catalog)
            failures.extend(catalog_failures)

            # No violation was raised while driving, before the deliberate probes: snapshot the
            # count first, and read only what arrived before the probes.
            before_probes = driver.execute_script("return (window.__csp ?? []).length")
            probes = driver.execute_async_script(PROBES, REMOTE)
            report["probes"] = probes
            for name, check in {
                "inline script is refused": lambda p: not p["inlineScriptRan"],
                "inline style attribute is refused": lambda p: not p["styleAttrApplied"],
            }.items():
                if not check(probes):
                    failures.append(f"backstop did not hold: {name}")

            clean = driver.execute_script(
                "return (window.__csp ?? []).slice(0, arguments[0]);", before_probes
            )
            report["violations_while_driving"] = clean
            if clean:
                failures.append(f"violations while driving: {json.dumps(clean)}")
        finally:
            driver.quit()
    except WebDriverException as e:
        # A session that dies before its first command answers carries an empty message;
        # the class and the raw error are what name it then.
        failures.append(f"webdriver: {type(e).__name__}: {e.msg!r}")
    finally:
        app.terminate()
        app.wait(timeout=10)

    print(json.dumps(report, indent=2))
    if failures:
        print("\nmacOS CSP witness FAILED:", *failures, sep="\n  - ", file=sys.stderr)
        return 1
    print(
        "\nmacOS CSP witness held: the app whole with the editor mounted and styled; the view"
        " catalog painted from theme roles in every theme; no violations; the backstop probes"
        " refused."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
