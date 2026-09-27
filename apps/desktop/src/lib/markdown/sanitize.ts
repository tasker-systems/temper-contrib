// Ported from temper's temper-ui (tasker-systems/temper, packages/temper-ui/src/lib/sanitize.ts, at
// 5344abc) by copy-with-citation, per the desktop's rendering-baseline design (ruling 2):
// temper-ui is not a package and contrib ships no temper code. Any desktop adaptation is marked
// "Desktop:"; everything else is the baseline as it stands.
//
// sanitize.ts — the client-only DOMPurify pass for rendered markdown.
//
// markdown.ts stays DOM-FREE; this module owns the browser-only DOM dependency and the one-time
// hook registration, so MarkdownRenderer's dynamic import under `if (browser)` never double-adds
// the hook across remounts.
//
// Two attribute channels can carry author-controlled styling into the rendered document; both
// are closed here, in one pass:
//
// • style — FORBID_ATTR. Desktop: the ruled static CSP carries no `style-src-attr` at all (the
//   desktop sets no inline style attributes), so the CSP is a backstop here; the sanitizer is
//   still the gate, and strips the attribute rather than leaving a refused one in the document.
//
// • class — filtered to the prefixes the markdown pipeline legitimately emits. The CSP has no
//   lever for this channel: a class value is neither a style attribute nor a fetch. But the
//   desktop is Tailwind v4 too, so its utilities ship in the stylesheet and a surviving class
//   value still styles the rendered document. The allowlist is exhaustive over the pipeline's
//   own output: `hljs` / `hljs-*` (highlight.js theme hook and token spans), `language-*`
//   (marked's langPrefix, also what copy affordances key on), and `md-refusal` (the static
//   REFUSAL_HTML). Deliberately NOT `FORBID_ATTR: ['class']`, which would strip those wholesale.
//   The `.md-body` wrapper is added by the component outside the sanitized string and needs no
//   entry.
//
// Desktop: remote images are withheld, as a declared refusal. The ruled CSP admits `img-src`
// from `data:` and bundled assets only, so a remote `<img>` would otherwise land as a silent
// broken glyph. After the pass, every image whose source is not an embedded `data:image/` URI is
// replaced by a `md-withheld` span that says so, keeping its alt text and naming the source on
// hover. The CSP is the backstop; this is the gate. `md-withheld` is deliberately NOT in the
// class allowlist: it is added after sanitizing, so authored content cannot forge a refusal.
import DOMPurify from 'dompurify';

const keepClass = (value: string): boolean =>
	value === 'hljs' ||
	value.startsWith('hljs-') ||
	value.startsWith('language-') ||
	value === 'md-refusal';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	if (!(node instanceof Element) || !node.hasAttribute('class')) return;
	const kept = (node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).filter(keepClass);
	if (kept.length) node.setAttribute('class', kept.join(' '));
	else node.removeAttribute('class');
});

export const SANITIZE_CONFIG = { FORBID_ATTR: ['style'] };

/** Words for a withheld image; exported so the witnesses and the component agree. */
export const WITHHELD_IMAGE = 'remote image withheld';

const embedded = (src: string | null): boolean => /^data:image\//i.test(src?.trim() ?? '');

function withheld(img: HTMLImageElement): HTMLSpanElement {
	const span = img.ownerDocument.createElement('span');
	span.className = 'md-withheld';
	const alt = img.getAttribute('alt')?.trim();
	span.textContent = alt ? `${WITHHELD_IMAGE}: ${alt}` : WITHHELD_IMAGE;
	const src = img.getAttribute('src')?.trim();
	if (src) span.title = src;
	return span;
}

export function sanitizeMarkdownHtml(dirty: string): string {
	const fragment = DOMPurify.sanitize(dirty, { ...SANITIZE_CONFIG, RETURN_DOM_FRAGMENT: true });
	for (const img of fragment.querySelectorAll('img')) {
		if (!embedded(img.getAttribute('src'))) img.replaceWith(withheld(img));
	}
	const holder = document.createElement('div');
	holder.append(fragment);
	return holder.innerHTML;
}
