"""The CSP witness: drives a production build of the desktop in its real webview and checks the
Content-Security-Policy in tauri.conf.json both ways.

1. The app is whole under the policy: every route renders styled, with its bundled fonts, IPC
   answering, and no `securitypolicyviolation` raised while moving between them.
2. The policy is a backstop: an injected inline script, eval, an inline event handler, an inline
   style attribute, a remote image and a remote fetch are each refused, and each refusal is seen
   as a violation naming its directive. Styling through the CSSOM, which Svelte's `style:`
   directive uses and CSP does not govern, still applies.
3. The capability boundary holds: the `__TAURI__` global is not exposed, event listening is
   granted, and a command outside `capabilities/default.json` (or from the dropped opener) is
   refused.

Production build, never the dev server: `tauri dev` runs under `devCsp`, which is looser by design.

    npx tauri build --debug --no-bundle          # in apps/desktop: embeds the built frontend
    uv run --with selenium scripts/csp-witness.py [path/to/binary]

Needs `tauri-driver` (cargo install tauri-driver) and, on Linux, `WebKitWebDriver`
(webkit2gtk-driver) plus a display (xvfb-run). `cargo make desktop-csp-witness` runs all of it.
Exits non-zero, naming what failed, when either half does not hold.
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
DEFAULT_BINARY = APP / "src-tauri" / "target" / "debug" / "desktop"
DRIVER_PORT = 4444
REMOTE = "https://example.com"

# Recorded on the document, which survives client-side navigation between routes.
LISTEN = """
window.__csp = window.__csp || [];
if (!window.__cspListening) {
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({
    directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, sample: e.sample
  }));
  window.__cspListening = true;
}
"""

# A route is whole when theme roles resolved, the bundled reading font loaded and the room frame
# rendered. Blocked stylesheets or fonts fail the first two; a blocked script renders nothing.
HEALTH = """
const done = arguments[arguments.length - 1];
document.fonts.ready.then(() => {
  const root = getComputedStyle(document.documentElement);
  done({
    path: location.pathname,
    ground: root.getPropertyValue('--tp-ground').trim(),
    background: root.backgroundColor,
    readingFont: document.fonts.check('16px "Source Serif 4 Variable"'),
    fontsLoaded: [...document.fonts].filter((f) => f.status === 'loaded').length,
    masthead: !!document.querySelector('header a[href="/"]'),
    text: document.body.innerText.slice(0, 400)
  });
});
"""

PROBES = """
const done = arguments[arguments.length - 1];
const out = {};
const marker = document.createElement('div');
document.body.append(marker);

const inline = document.createElement('script');
inline.textContent = 'window.__injected = true;';
document.body.append(inline);
out.inlineScriptRan = window.__injected === true;

try { eval('window.__evaluated = true'); } catch (e) { out.evalError = String(e); }
out.evalRan = window.__evaluated === true;

marker.setAttribute('onclick', 'window.__handler = true');
marker.click();
out.inlineHandlerRan = window.__handler === true;

const before = getComputedStyle(marker).outlineStyle;
marker.setAttribute('style', 'outline: 3px solid;');
out.styleAttrApplied = getComputedStyle(marker).outlineStyle !== before;

// Svelte's `style:` directive writes through the CSSOM (style.setProperty / cssText), which CSP
// does not govern: components that style that way must keep working under the policy.
marker.style.setProperty('outline-style', 'dotted');
out.cssomStyleApplied = getComputedStyle(marker).outlineStyle === 'dotted';

const img = new Image();
const imageSettled = new Promise((resolve) => {
  img.onload = () => resolve('loaded');
  img.onerror = () => resolve('error');
});
img.src = arguments[0] + '/csp-witness.png';

const fetched = fetch(arguments[0]).then(() => 'fetched', (e) => 'refused: ' + e);

Promise.all([imageSettled, fetched]).then(([image, fetch]) => {
  out.remoteImage = image;
  out.remoteFetch = fetch;
  setTimeout(() => done(out), 500);
});
"""

# The capability boundary, probed through the IPC internals Tauri always injects (the public
# `window.__TAURI__` global is off). Listening to events is the one plugin permission granted;
# anything else — a core plugin command, the dropped opener — must be refused.
IPC = """
const done = arguments[arguments.length - 1];
const ipc = window.__TAURI_INTERNALS__;
const attempt = (cmd, args) => ipc.invoke(cmd, args).then(() => 'allowed', (e) => 'refused: ' + e);
const handler = ipc.transformCallback(() => {});
Promise.all([
  attempt('plugin:event|listen', { event: 'csp-witness', target: { kind: 'Any' }, handler }),
  attempt('plugin:app|version', {}),
  attempt('plugin:opener|open_url', { url: 'https://example.com' })
]).then(([listen, appVersion, opener]) => done({
  globalTauri: typeof window.__TAURI__,
  listen, appVersion, opener
}));
"""

CAPABILITIES = {
    "the __TAURI__ global is not exposed": lambda i: i["globalTauri"] == "undefined",
    "event listening is granted": lambda i: i["listen"] == "allowed",
    "a core command outside the capability is refused": lambda i: i["appVersion"].startswith(
        "refused"
    ),
    "the opener is gone": lambda i: i["opener"].startswith("refused"),
}

HELD = {
    "inline script is refused": lambda p, v: not p["inlineScriptRan"] and "script-src" in v,
    "eval is refused": lambda p, v: not p["evalRan"] and "evalError" in p,
    "inline event handler is refused": lambda p, v: not p["inlineHandlerRan"],
    "inline style attribute is refused": lambda p, v: not p["styleAttrApplied"],
    "remote image is refused": lambda p, v: p["remoteImage"] == "error" and "img-src" in v,
    "CSSOM styling (Svelte style: directives) still applies": lambda p, v: p["cssomStyleApplied"],
    "remote fetch is refused": lambda p, v: (
        p["remoteFetch"].startswith("refused") and "connect-src" in v
    ),
}


def wait_for_port(port: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise SystemExit(f"tauri-driver did not listen on :{port}")


def healthy(h: dict) -> list[str]:
    problems = []
    if not h["ground"]:
        problems.append("theme roles did not resolve (a stylesheet was refused?)")
    if not h["readingFont"]:
        problems.append("the bundled reading font did not load (font-src?)")
    if not h["masthead"]:
        problems.append("the room frame did not render (a script was refused?)")
    return problems


def main() -> int:
    binary = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_BINARY
    if not binary.exists():
        raise SystemExit(f"no build at {binary}; run: npx tauri build --debug --no-bundle")
    if not shutil.which("tauri-driver"):
        raise SystemExit("tauri-driver not on PATH; run: cargo install tauri-driver --locked")

    driver_proc = subprocess.Popen(
        ["tauri-driver", "--port", str(DRIVER_PORT)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    failures: list[str] = []
    report: dict = {}
    try:
        wait_for_port(DRIVER_PORT)
        options = ArgOptions()
        options.set_capability("browserName", "wry")
        options.set_capability("tauri:options", {"application": str(binary)})
        driver = webdriver.Remote(f"http://127.0.0.1:{DRIVER_PORT}", options=options)
        driver.set_script_timeout(20)
        try:
            WebDriverWait(driver, 20).until(
                lambda d: d.find_elements(By.CSS_SELECTOR, 'header a[href="/"]')
            )
            driver.execute_script(LISTEN)

            # IPC answers under connect-src: the connection line settles to a verdict either way.
            WebDriverWait(driver, 20).until(
                lambda d: "onnected" in d.find_element(By.TAG_NAME, "body").text
            )

            routes = []
            for href in ["/settings", "/"]:
                driver.find_element(By.CSS_SELECTOR, f'header a[href="{href}"]').click()
                WebDriverWait(driver, 10).until(
                    lambda d, h=href: d.execute_script("return location.pathname") == h
                )
                health = driver.execute_async_script(HEALTH)
                routes.append(health)
                failures += [f"{href}: {p}" for p in healthy(health)]

            clean = driver.execute_script("return window.__csp")
            if clean:
                failures.append(f"violations while rendering routes: {json.dumps(clean)}")

            probes = driver.execute_async_script(PROBES, REMOTE)
            violations = driver.execute_script("return window.__csp")
            directives = " ".join(v["directive"] for v in violations)
            held = {name: bool(check(probes, directives)) for name, check in HELD.items()}
            failures += [f"backstop did not hold: {name}" for name, ok in held.items() if not ok]

            ipc = driver.execute_async_script(IPC)
            capabilities = {name: bool(check(ipc)) for name, check in CAPABILITIES.items()}
            failures += [f"capability: {name}" for name, ok in capabilities.items() if not ok]

            report = {
                "binary": str(binary),
                "routes": routes,
                "violations_while_rendering": clean,
                "probes": probes,
                "violations_from_probes": violations,
                "held": held,
                "ipc": ipc,
                "capabilities": capabilities,
            }
        finally:
            driver.quit()
    except WebDriverException as e:
        failures.append(f"webdriver: {e.msg}")
    finally:
        driver_proc.terminate()
        driver_proc.wait(timeout=10)

    print(json.dumps(report, indent=2))
    if failures:
        print("\nCSP witness FAILED:", *failures, sep="\n  - ", file=sys.stderr)
        return 1
    print(
        "\nCSP witness held: routes whole with no violations; every probe refused;"
        " the capability boundary holds."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
