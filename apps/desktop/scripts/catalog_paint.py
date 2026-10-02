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
4. Both graphs are drawn, side by side on one page, and their nodes are painted with the
   doc-type and categorical roles their specs named.
5. The table draws everything its props carry beyond rows — sortable headers and the active
   order, the pager, facet counts and list cells — so the second assertion covers them too. The
   catalog lens hands it the view-action handlers a host would. Every header and cell stays a
   table cell: a component's style that reaches one breaks the columns, and only layout shows it.
6. The graphs are anchored and grammared: every drawn node is either an SVG anchor naming its
   resource or a bare node (a specimen's vocabulary node carries no resource), never a third
   shape; every anchor names `/r/<resource>`; lines, arrowheads, captions and legend entries are
   all drawn, so the colour assertion above covers them too.
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
// An error thrown in the callback would never call done, and read as a timeout: name it instead.
requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => { try {
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
  const role = (name) => Object.keys(roles).find((v) => roles[v].includes(`--tp-${name}`));
  const cat = (n) => role(`cat-${n}`);
  const graphs = [...page.querySelectorAll('[data-component="Graph"] svg')];
  const nodeFill = (tint) => [...page.querySelectorAll(`[data-component="Graph"] svg .node[data-tint="${tint}"] .mark`)]
    .map((m) => getComputedStyle(m).fill);
  done({
    theme,
    components: [...page.querySelectorAll('[data-component]')].map((s) => s.dataset.component),
    refused: [...page.querySelectorAll('.refused')].map((r) => r.closest('[data-component]')?.dataset.component),
    chartMarks: page.querySelectorAll('[data-component="Chart"] svg path, [data-component="Chart"] svg rect').length,
    roleColours: Object.keys(roles).length,
    seriesPainted: { 'cat-1': painted.has(cat(1)), 'cat-3': painted.has(cat(3)) },
    graphs: graphs.map((g) => ({ nodes: g.querySelectorAll('.node').length,
      edges: g.querySelectorAll('.edge').length, ids: g.querySelectorAll('[id]').length })),
    nodesPainted: Object.fromEntries(['doctype-goal', 'doctype-task', 'cat-1', 'cat-5'].map((t) =>
      [t, nodeFill(t).length > 0 && nodeFill(t).every((f) => f === role(t))])),
    tableParts: Object.fromEntries(Object.entries({
      sortControls: 'th button.sort', activeSort: 'th[aria-sort]', pager: 'nav.pager button',
      facetCounts: '.facets .count', listCells: 'td.list .tag'
    }).map(([k, sel]) => [k, page.querySelectorAll(`[data-component="Table"] ${sel}`).length])),
    // A cell a component style turned into something else leaves the table's layout.
    cellsNotCells: [...page.querySelectorAll('[data-component="Table"] th, [data-component="Table"] td')]
      .filter((c) => getComputedStyle(c).display !== 'table-cell').map(label),
    graphParts: Object.fromEntries(Object.entries({
      marks: 'svg .node .mark', anchored: 'svg a.node[href]', bare: 'svg g.node .mark',
      lines: 'svg .edge line', heads: 'svg .edge .head', captions: 'svg .captions text',
      captionAnchors: 'svg .captions a[href]', legend: '.legend .entry'
    }).map(([k, sel]) => [k, page.querySelectorAll(`[data-component="Graph"] ${sel}`).length])),
    // An anchor that names anything but its resource is a lie about where a click lands.
    strayAnchors: [...page.querySelectorAll('[data-component="Graph"] svg a[href]')]
      .filter((a) => !a.getAttribute('href').startsWith('/r/')).length,
    offenders: offenders.slice(0, 40),
    offenderCount: offenders.length
  });
} catch (e) { done({ error: `the paint probe threw: ${e}` }); } }, 300)));
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
            if len(r["graphs"]) != 2 or not all(g["nodes"] and g["edges"] for g in r["graphs"]):
                failures.append(f"{where}: the two graphs were not both drawn {r['graphs']}")
            if any(g["ids"] for g in r["graphs"]):
                failures.append(f"{where}: a graph carries ids another could answer for")
            if not all(r["nodesPainted"].values()):
                failures.append(f"{where}: nodes not painted with their roles {r['nodesPainted']}")
            gp = r["graphParts"]
            missing_graph = [
                k for k in ("marks", "lines", "heads", "captions", "legend") if not gp[k]
            ]
            if missing_graph:
                failures.append(f"{where}: the graphs drew no {', '.join(missing_graph)}")
            if gp["anchored"] + gp["bare"] != gp["marks"] or gp["anchored"] + gp["bare"] == 0:
                failures.append(
                    f"{where}: {gp['marks']} marks but {gp['anchored']} anchored + {gp['bare']} bare"
                )
            if not gp["anchored"]:
                failures.append(
                    f"{where}: no drawn node is an anchor naming its resource "
                    f"(the catalog's example models a core fill, and every one of its nodes is a resource)"
                )
            if gp["captionAnchors"] > gp["captions"]:
                failures.append(
                    f"{where}: {gp['captionAnchors']} caption anchors over {gp['captions']} captions"
                )
            if r["strayAnchors"]:
                failures.append(
                    f"{where}: {r['strayAnchors']} anchors name something but a resource"
                )
            missing = [k for k, n in r["tableParts"].items() if not n]
            if missing:
                failures.append(f"{where}: the table drew no {', '.join(missing)}")
            if r["cellsNotCells"]:
                failures.append(
                    f"{where}: table cells out of the table's layout {r['cellsNotCells']}"
                )
            if r["offenderCount"]:
                failures.append(
                    f"{where}: {r['offenderCount']} colours not from a --tp-* role:"
                    f" {json.dumps(r['offenders'][:8])}"
                )
    finally:
        driver.execute_script("document.documentElement.dataset.theme = arguments[0]", original)
    return reports, failures
