"""The view catalog in the running app: every catalog component rendered under the shipped CSP,
painting only from theme roles, in every theme. Shared by the CSP witnesses (`csp-witness.py`
under tauri-driver, `csp-witness-macos.py` in WKWebView), which open the catalog lens and call
`witness_catalog`; violations raised while it renders are caught by the witness's own listener.

What it asserts, per theme:
1. The lens is whole: a specimen for every component the catalog file names, none refused, and
   the chart drawn (LayerChart measured its container and painted marks).
2. Every colour painted inside the lens — text, backgrounds, borders, SVG fills and strokes — is
   the computed value of a `--tp-*` role in that theme. A library palette, a colour mixed from a
   role, or a literal all fail it, named by element and property.
3. The chart's series are painted with the categorical roles their spec named.
"""

from __future__ import annotations

import json
from pathlib import Path

from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

CATALOG = Path(__file__).resolve().parent.parent / "src" / "lib" / "catalog" / "temper.catalog.json"
THEMES = ["quiet-instrument", "quiet-instrument-paper"]

# A colour no theme uses: a role that is not a colour resolves to it by inheritance and is
# dropped, so only colour roles enter the set.
PAINT = """
const done = arguments[arguments.length - 1];
const theme = arguments[0];
document.documentElement.dataset.theme = theme;
// Two frames: the theme's rules apply, then LayerChart's effects settle.
requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
  const page = document.querySelector('.tab-body:not([hidden]) .page');
  if (!page) return done({ error: 'no catalog page in the active tab' });

  const names = new Set();
  const collect = (rules) => {
    for (const rule of rules) {
      if (rule.cssRules) collect(rule.cssRules);
      if (!rule.style) continue;
      for (let i = 0; i < rule.style.length; i++)
        if (rule.style[i].startsWith('--tp-')) names.add(rule.style[i]);
    }
  };
  for (const sheet of document.styleSheets) {
    try { collect(sheet.cssRules); } catch (e) { /* a sheet not ours to read */ }
  }
  const SENTINEL = 'rgb(1, 2, 3)';
  const holder = document.createElement('div');
  holder.style.setProperty('color', SENTINEL);
  const probe = document.createElement('span');
  holder.append(probe);
  page.append(holder);
  const roles = {};
  for (const name of names) {
    probe.style.setProperty('color', `var(${name})`);
    const value = getComputedStyle(probe).color;
    if (value !== SENTINEL) (roles[value] ??= []).push(name);
  }
  holder.remove();

  const transparent = (v) => !v || v === 'none' || v === 'transparent' || /rgba\\(.*,\\s*0\\)$/.test(v)
    || v.startsWith('url(');
  const FILLS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'text',
    'tspan', 'textpath']);
  const offenders = [];
  const painted = new Set();
  const label = (el) => el.tagName.toLowerCase() + (el.getAttribute('class')
    ? '.' + el.getAttribute('class').trim().split(/\\s+/).slice(0, 3).join('.') : '');
  for (const el of page.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const props = ['color', 'background-color'];
    for (const side of ['top', 'right', 'bottom', 'left'])
      if (cs.getPropertyValue(`border-${side}-style`) !== 'none'
          && parseFloat(cs.getPropertyValue(`border-${side}-width`)) > 0)
        props.push(`border-${side}-color`);
    // SVG paints only through its shapes and text, and only the channels they draw: a group's
    // fill is an inherited default, a line has no fill area, a zero-width stroke paints nothing,
    // and nothing under defs or a clip path is painted where it stands.
    if (el instanceof SVGElement) {
      if (el.closest('defs, clipPath, mask')) continue;
      const tag = el.tagName.toLowerCase();
      if (FILLS.has(tag) && parseFloat(cs.fillOpacity) > 0) props.push('fill');
      if ((FILLS.has(tag) || tag === 'line') && parseFloat(cs.strokeWidth) > 0
          && parseFloat(cs.strokeOpacity) > 0) props.push('stroke');
      if (!FILLS.has(tag) && tag !== 'line') props.length = 0;
    }
    for (const prop of props) {
      const value = cs.getPropertyValue(prop);
      if (transparent(value)) continue;
      if (roles[value]) { if (el instanceof SVGElement) painted.add(value); continue; }
      offenders.push({ element: label(el), prop, value,
        component: el.closest('[data-component]')?.getAttribute('data-component') ?? null });
    }
  }
  const cat = (n) => Object.keys(roles).find((v) => roles[v].includes(`--tp-cat-${n}`));
  done({
    theme,
    components: [...page.querySelectorAll('[data-component]')].map((s) => s.dataset.component),
    refused: [...page.querySelectorAll('.refused')].map((r) => r.closest('[data-component]')?.dataset.component),
    chartMarks: page.querySelectorAll('[data-component="Chart"] svg path, [data-component="Chart"] svg rect').length,
    roleColours: Object.keys(roles).length,
    seriesPainted: { 'cat-1': painted.has(cat(1)), 'cat-3': painted.has(cat(3)) },
    offenders: offenders.slice(0, 40),
    offenderCount: offenders.length
  });
}, 300)));
"""


def witness_catalog(driver, open_catalog) -> tuple[list[dict], list[str]]:
    """Open the catalog lens with `open_catalog(driver)`, then check it in every theme. Returns
    the per-theme reports and the failures, worded for the witness's summary."""
    expected = sorted(json.loads(CATALOG.read_text())["components"])
    open_catalog(driver)
    WebDriverWait(driver, 15).until(
        lambda d: (
            len(d.find_elements(By.CSS_SELECTOR, ".tab-body:not([hidden]) .page [data-component]"))
            == len(expected)
        )
    )
    original = driver.execute_script("return document.documentElement.dataset.theme")
    reports, failures = [], []
    try:
        for theme in THEMES:
            r = driver.execute_async_script(PAINT, theme)
            reports.append(r)
            where = f"catalog ({theme})"
            if "error" in r:
                failures.append(f"{where}: {r['error']}")
                continue
            if sorted(r["components"]) != expected:
                failures.append(f"{where}: specimens {sorted(r['components'])} != {expected}")
            if r["refused"]:
                failures.append(f"{where}: refused specimens {r['refused']}")
            if not r["chartMarks"]:
                failures.append(f"{where}: the chart drew no marks")
            if not all(r["seriesPainted"].values()):
                failures.append(
                    f"{where}: series not painted with their roles {r['seriesPainted']}"
                )
            if r["offenderCount"]:
                failures.append(
                    f"{where}: {r['offenderCount']} colours not from a --tp-* role:"
                    f" {json.dumps(r['offenders'][:8])}"
                )
    finally:
        driver.execute_script("document.documentElement.dataset.theme = arguments[0]", original)
    return reports, failures
