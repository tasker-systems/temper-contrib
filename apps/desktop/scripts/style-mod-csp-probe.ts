#!/usr/bin/env bun
/**
 * The style-mod CSP probe: the exact mechanism the editor spike turns on, exercised in a real
 * engine (Playwright's Chromium) under a nonce'd `style-src`, the shape Tauri serves.
 *
 * Verified from source before this probe was written:
 * - CodeMirror mounts into the document (no shadow root), so style-mod takes the <style>-tag
 *   path — its constructable-stylesheet path fires only for a ShadowRoot
 *   (`!root.head && root.adoptedStyleSheets`).
 * - A runtime-inserted <style> is governed by style-src; without a nonce it is refused.
 * - CodeMirror reads EditorView.cspNonce and hands it to style-mod, which sets it on the tag.
 * - Tauri substitutes __TAURI_STYLE_NONCE__ per serve in the CSP sources and in asset <style>
 *   tags; a runtime tag can only be allowed through a nonce the page knows.
 *
 * This probe answers the one thing reading source cannot: what the shipped policy does when the
 * editor mounts. Two pages, one policy:
 *   A. the editor mounts with no nonce — expected: the style tag is refused (violation,
 *      style-src) and the editor renders unstyled;
 *   B. the editor mounts with a nonce the page's own CSP admits — the style tag applies.
 *
 * Verdict B holds is the finding the spike needs: a nonce channel exists and works. The real
 * webview proof (the binary, WKWebView on macOS, WebKitGTK in CI) rides the shipped witness.
 */
import { chromium } from 'playwright-core';

const NONCE = 'R4nd0mNoncE';
const POLICY =
	`default-src 'none'; script-src 'self' 'nonce-${NONCE}'; style-src 'self' 'nonce-${NONCE}'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script type="module" nonce="${NONCE}">
import { StyleModule } from '/mod/style-mod.js';

window.__result = {};
const violations = [];
document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
window.__violations = violations;

// A. Mount the way CodeMirror does — into the document, no nonce.
// (The first mount's violation fires as a console error here — style-mod sets textContent on
// the tag rather than an attribute, so the engine reports it once, sometimes without raising
// the event; the styled check below is the assertion, the event is corroboration.)
const mod1 = new StyleModule({ '.cm-probe-1': { 'outline-style': 'dotted' } });
StyleModule.mount(document, [mod1]);
const probe1 = document.createElement('div');
probe1.className = 'cm-probe-1';
document.body.append(probe1);
window.__result.caseA = {
  styled: getComputedStyle(probe1).outlineStyle === 'dotted',
  violations: violations.slice()
};
violations.length = 0;

// B. Mount again with a nonce the page's CSP admits.
const mod2 = new StyleModule({ '.cm-probe-2': { 'outline-style': 'dashed' } });
StyleModule.mount(document, [mod2], { nonce: '${NONCE}' });
const probe2 = document.createElement('div');
probe2.className = 'cm-probe-2';
document.body.append(probe2);
window.__result.caseB = {
  styled: getComputedStyle(probe2).outlineStyle === 'dashed',
  tagHasNonce: (document.querySelector('style[nonce]')?.getAttribute('nonce') ?? null),
  violations: violations.slice()
};
violations.length = 0;

// C. The plan's mechanism: mount inside a shadow root, where style-mod takes the
// constructable-stylesheet path (CSSOM insertRule) — outside CSP's style-src entirely.
const host = document.createElement('div');
document.body.append(host);
const shadow = host.attachShadow({ mode: 'open' });
const mod3 = new StyleModule({ '.cm-probe-3': { 'outline-style': 'double' } });
StyleModule.mount(shadow, [mod3]);
const probe3 = document.createElement('div');
probe3.className = 'cm-probe-3';
shadow.append(probe3);
window.__result.caseC = {
  styled: getComputedStyle(probe3).outlineStyle === 'double',
  adopted: shadow.adoptedStyleSheets?.length ?? 0,
  violations: violations.slice()
};
</script></body></html>`;

const server = Bun.serve({
	port: 4199,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === '/') {
			return new Response(HTML, {
				headers: { 'Content-Security-Policy': POLICY, 'Content-Type': 'text/html' }
			});
		}
		if (url.pathname === '/mod/style-mod.js') {
			return new Response(Bun.file('node_modules/style-mod/src/style-mod.js'), {
				headers: { 'Content-Type': 'text/javascript' }
			});
		}
		return new Response('not found', { status: 404 });
	}
});
await server.ready;
try {
	const browser = await chromium.launch();
	const page = await browser.newPage();
	page.on('console', (m) => console.log('[page]', m.type(), m.text()));
	page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
	await page.goto('http://127.0.0.1:4199/', { waitUntil: 'load' });
	await page.waitForFunction(() => (window as any).__result?.caseB, null, { timeout: 10_000 });
	const result = await page.evaluate(() => (window as any).__result);
	console.log(JSON.stringify(result, null, 2));
	await browser.close();
} finally {
	server.stop(true);
}