"""The CSP witness: drives a production build of the desktop in its real webview and checks the
Content-Security-Policy in tauri.conf.json both ways.

1. The app is whole under the policy: the shell renders styled, with its bundled fonts and IPC
   answering, and no `securitypolicyviolation` is raised while it is driven — a document opened
   in a tab, a second tab on the bound table lens, a switch between them (the room kept, not
   remounted), a switch to a lens that is not built yet, the palette (opened by its trigger and by Ctrl-K, a lens switched
   from it), the ways-in panel opened from the menu chip and closed and reopened from the
   panel's own ×, settings and setup opened as tabs, the view catalog in every theme painting
   only from theme roles (`catalog_paint.py`), and home again.
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
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

from catalog_paint import witness_catalog
from selenium import webdriver
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.options import ArgOptions
from selenium.webdriver.support.ui import WebDriverWait

APP = Path(__file__).resolve().parent.parent
DEFAULT_BINARY = APP / "src-tauri" / "target" / "debug" / "desktop"
DRIVER_PORT = 4444
REMOTE = "https://example.com"

# Recorded on the document, which lives as long as the window: the shell never navigates.
LISTEN = """
window.__csp = window.__csp || [];
if (!window.__cspListening) {
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({
    directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, sample: e.sample
  }));
  window.__cspListening = true;
}
"""

# A step is whole when theme roles resolved, the bundled reading font loaded, the masthead and
# the agent panel rendered, and the active tab has a body. Blocked stylesheets or fonts fail the
# first two; a blocked script renders nothing.
HEALTH = """
const done = arguments[arguments.length - 1];
// Ask for the bundled reading face by name: a font is fetched only when something needs it, so
// the load is what puts `font-src` to the test. A refused font leaves the face unloaded.
document.fonts.load('16px "Source Serif 4 Variable"').catch(() => []).then(() => document.fonts.ready).then(() => {
  const root = getComputedStyle(document.documentElement);
  const active = document.querySelector('.tab-body:not([hidden])');
  done({
    tab: document.querySelector('[role="tab"][aria-selected="true"]')?.innerText ?? null,
    ground: root.getPropertyValue('--tp-ground').trim(),
    background: root.backgroundColor,
    readingFont: document.fonts.check('16px "Source Serif 4 Variable"'),
    fontsLoaded: [...document.fonts].filter((f) => f.status === 'loaded').length,
    masthead: !!document.querySelector('header a[href="/"]'),
    agentPanel: !!document.querySelector('aside[aria-label="Agent"]'),
    tabs: document.querySelectorAll('[role="tab"]').length,
    body: active ? active.innerText.slice(0, 300) : null
  });
});
"""

# A document, addressed by a well-formed reference that names nothing: the room must render whole
# whatever temper answers, including when nothing answers at all.
DOCUMENT = "/r/00000000-0000-7000-8000-000000000000"
CONTEXT = "/q?context=%2Btemper-dev%2Fcontrib"

# Links stay links: the witness places an in-app link inside the shell and clicks it, so the move
# goes through the shell's own delegated handler. `modified` stands for a ⌘/Ctrl-click.
FOLLOW_LINK = """
const link = document.createElement('a');
link.href = arguments[0];
link.textContent = 'witness link';
document.querySelector('.tab-body:not([hidden])').append(link);
link.dispatchEvent(new MouseEvent('click', {
  bubbles: true, cancelable: true, button: 0, ctrlKey: arguments[1], metaKey: arguments[1]
}));
link.remove();
"""

ACTIVE_ROOM = "return document.querySelector('.tab-body:not([hidden]) > *')"

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


# Home's pinned sections as the shipped contributions declare them (core and temper-workflows).
HOME_SECTIONS = 6


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
        problems.append("the masthead did not render (a script was refused?)")
    if not h.get("agentPanel"):
        problems.append("the agent panel did not render (a script was refused?)")
    if not h.get("body"):
        problems.append("the active tab has no body")
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
        # The app is spawned by tauri-driver and its stderr flows through here: a session
        # that never answers is diagnosed by what the app said on its way out, so keep it.
        stderr=open("tauri-driver.log", "w"),
    )
    os.environ.setdefault("RUST_BACKTRACE", "1")
    failures: list[str] = []
    report: dict = {}
    try:
        wait_for_port(DRIVER_PORT)
        options = ArgOptions()
        options.set_capability("browserName", "wry")
        options.set_capability("tauri:options", {"application": str(binary)})
        driver = webdriver.Remote(f"http://127.0.0.1:{DRIVER_PORT}", options=options)
        # The catalog step walks computed styles over every element of every specimen — the
        # graph example alone carries 200 nodes and 600 edges. A 20s budget predates that
        # page; the step's real cost is over a minute on a slow machine.
        driver.set_script_timeout(120)
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

            # IPC answers under connect-src: the connection line settles to a verdict either way.
            WebDriverWait(driver, 20).until(
                lambda d: "onnected" in d.find_element(By.TAG_NAME, "body").text
            )

            steps = []

            def step(name: str) -> None:
                health = driver.execute_async_script(HEALTH)
                health["step"] = name
                steps.append(health)
                failures.extend(f"{name}: {p}" for p in healthy(health))

            def tab_count(n: int):
                return lambda d: len(d.find_elements(By.CSS_SELECTOR, '[role="tab"]')) == n

            def active_text(text: str):
                # Rendered text: case follows the stylesheet, so compare without it.
                return lambda d: any(
                    text.lower() in e.text.lower()
                    for e in d.find_elements(By.CSS_SELECTOR, ".tab-body:not([hidden])")
                )

            # Home is its pinned sections: every one renders, built or named as unbuilt.
            WebDriverWait(driver, 10).until(
                lambda d: (
                    len(d.find_elements(By.CSS_SELECTOR, ".tab-body:not([hidden]) [data-section]"))
                    == HOME_SECTIONS
                )
            )
            step("home")

            # A document opened from home opens in a new tab. Without temper credentials the room
            # renders its failure regions, and must still be whole.
            driver.execute_script(FOLLOW_LINK, DOCUMENT, False)
            WebDriverWait(driver, 10).until(tab_count(2))
            WebDriverWait(driver, 10).until(active_text("document"))
            step("a document in a tab")
            document_tab = driver.find_element(
                By.CSS_SELECTOR, '[role="tab"][aria-selected="true"]'
            )
            document_room = driver.execute_script(ACTIVE_ROOM)

            # A second tab, by a modified click on a context: it opens on the bound table lens. The
            # core fills it from temper's listing; without temper credentials the read fails, and
            # the lens says nothing was read rather than drawing an empty table.
            driver.execute_script(FOLLOW_LINK, CONTEXT, True)
            WebDriverWait(driver, 10).until(tab_count(3))
            WebDriverWait(driver, 10).until(
                lambda d: (
                    active_text("nothing was read")(d)
                    or d.find_elements(By.CSS_SELECTOR, ".tab-body:not([hidden]) table")
                )
            )
            step("a second tab, on the table lens")

            # Back to the document's tab: the same room node, so it was kept, not remounted.
            document_tab.click()
            WebDriverWait(driver, 10).until(active_text("document"))
            if driver.execute_script(ACTIVE_ROOM) != document_room:
                failures.append("switching back to a tab remounted its room")
            step("switched back")

            # A lens switch, to one that is not built yet.
            driver.find_element(
                By.XPATH,
                '//nav[@aria-label="This room"]//button[starts-with(normalize-space(), "graph")]',
            ).click()
            WebDriverWait(driver, 10).until(active_text("graph lens"))
            step("switched lens")

            # The palette, from its trigger: it filters what the desktop holds, and a lens switch
            # run from it keeps the tab's subject.
            driver.find_element(By.CSS_SELECTOR, ".palette-trigger").click()
            palette = WebDriverWait(driver, 10).until(
                lambda d: d.find_element(By.CSS_SELECTOR, '[role="dialog"] input')
            )
            palette.send_keys("document lens")
            palette.send_keys(Keys.ENTER)
            WebDriverWait(driver, 10).until(
                lambda d: not d.find_elements(By.CSS_SELECTOR, '[role="dialog"]')
            )
            WebDriverWait(driver, 10).until(active_text("about this document"))
            step("lens switched from the palette")

            # Ctrl-K opens it from anywhere; Escape closes it.
            ActionChains(driver).key_down(Keys.CONTROL).send_keys("k").key_up(
                Keys.CONTROL
            ).perform()
            WebDriverWait(driver, 10).until(
                lambda d: d.find_elements(By.CSS_SELECTOR, '[role="dialog"] input')
            )
            step("the palette open")
            driver.find_element(By.CSS_SELECTOR, '[role="dialog"] input').send_keys(Keys.ESCAPE)
            WebDriverWait(driver, 10).until(
                lambda d: not d.find_elements(By.CSS_SELECTOR, '[role="dialog"]')
            )

            # The ways-in panel opens from the menu chip's entry, closes and reopens from the
            # panel's own ×: hidden, never remounted. (The panel is closed by default — the
            # room is the first thing the window offers.)
            ways = driver.execute_script(
                "return document.querySelector('nav[aria-label=\"Ways in\"]')"
            )
            if ways is not None:
                failures.append("the ways-in panel rendered while closed by default")
            driver.find_element(By.CSS_SELECTOR, ".chrome-menu .trigger").click()
            WebDriverWait(driver, 10).until(
                lambda d: d.find_elements(By.CSS_SELECTOR, ".chrome-menu .entry-action")
            )
            driver.find_element(By.CSS_SELECTOR, ".chrome-menu .entry-action").click()
            WebDriverWait(driver, 10).until(
                lambda d: not d.execute_script("return document.querySelector('.ways').hidden")
            )
            ways_open = driver.execute_script(
                "return document.querySelector('nav[aria-label=\"Ways in\"]')"
            )
            # The panel closes from its own ×, and reopening it re-reads nothing.
            driver.find_element(
                By.CSS_SELECTOR,
                'nav[aria-label="Ways in"] button[aria-label="Close the ways-in panel"]',
            ).click()
            WebDriverWait(driver, 10).until(
                lambda d: d.execute_script("return document.querySelector('.ways').hidden")
            )
            driver.find_element(By.CSS_SELECTOR, ".chrome-menu .trigger").click()
            WebDriverWait(driver, 10).until(
                lambda d: d.find_elements(By.CSS_SELECTOR, ".chrome-menu .entry-action")
            )
            driver.find_element(By.CSS_SELECTOR, ".chrome-menu .entry-action").click()
            WebDriverWait(driver, 10).until(
                lambda d: not d.execute_script("return document.querySelector('.ways').hidden")
            )
            if (
                driver.execute_script(
                    "return document.querySelector('nav[aria-label=\"Ways in\"]')"
                )
                != ways_open
            ):
                failures.append("reopening the ways-in panel remounted it")
            # The menu is open from the reopen; a synthetic outside pointerdown closes it (its
            # own document listener; synthetic, so nothing else receives it).
            driver.execute_script(
                "document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));"
            )
            WebDriverWait(driver, 10).until(
                lambda d: not d.find_elements(By.CSS_SELECTOR, ".chrome-menu .entries")
            )
            step("the ways-in panel closed and reopened")

            # Settings and setup open as tabs, from the chrome menu — the way a person does.
            for href, words in [("/settings", "settings room"), ("/setup", "setup room")]:
                driver.find_element(By.CSS_SELECTOR, "header .chrome-menu button").click()
                driver.find_element(
                    By.CSS_SELECTOR, f'header .chrome-menu a[href="{href}"]'
                ).click()
                WebDriverWait(driver, 10).until(active_text(words))
                step(href.strip("/"))

            # The view catalog, opened in a tab: every component under the policy, painting only
            # from theme roles, in every theme.
            catalog, catalog_failures = witness_catalog(
                driver, lambda d: d.execute_script(FOLLOW_LINK, "/catalog", True)
            )
            failures.extend(catalog_failures)
            step("the view catalog")

            driver.find_element(By.CSS_SELECTOR, 'header a[href="/"]').click()
            WebDriverWait(driver, 10).until(
                lambda d: (
                    "home"
                    in d.find_element(
                        By.CSS_SELECTOR, '[role="tab"][aria-selected="true"]'
                    ).text.lower()
                )
            )
            step("home again")

            clean = driver.execute_script("return window.__csp")
            if clean:
                failures.append(f"violations while driving the shell: {json.dumps(clean)}")

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
                "steps": steps,
                "catalog": catalog,
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
        # A session that dies before its first command answers carries an empty message;
        # the class and the raw error are what name it then.
        failures.append(f"webdriver: {type(e).__name__}: {e.msg!r}")
    finally:
        driver_proc.terminate()
        driver_proc.wait(timeout=10)
        # What the app said on its way out — or while hanging — is the diagnosis a named
        # timeout still lacks. Alive-at-teardown is recorded beside it: a hang and a crash
        # name different suspects.
        tail = Path("tauri-driver.log")
        if tail.exists() and tail.stat().st_size > 0:
            print("\ntauri-driver and app output (tail):", file=sys.stderr)
            sys.stderr.write(tail.read_text(errors="replace")[-4000:] + "\n")
        alive = subprocess.run(["pgrep", "-af", binary.name], capture_output=True, text=True)
        if alive.stdout.strip():
            print(f"the app was still running at teardown:\n{alive.stdout}", file=sys.stderr)

    print(json.dumps(report, indent=2))
    if failures:
        print("\nCSP witness FAILED:", *failures, sep="\n  - ", file=sys.stderr)
        return 1
    print(
        "\nCSP witness held: the shell whole with no violations; every probe refused;"
        " the capability boundary holds."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
