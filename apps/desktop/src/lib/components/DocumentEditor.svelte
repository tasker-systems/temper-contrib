<script lang="ts">
	/**
	 * The document editor: CodeMirror 6 in markdown source mode over the composed markdown. It
	 * edits bytes directly — never a re-serialized markdown, which would churn block identities
	 * and break the no-op-save property. Byte fidelity is the whole point.
	 *
	 * Spike (slice 3, first): this mounts the editor and nothing more. It proved the two things
	 * the slice gates on, and carries the finding the spike produced:
	 *
	 * **The editor mounts inside a shadow root.** CodeMirror styles itself through `style-mod`,
	 * which writes a runtime style tag when mounted into a document — governed by
	 * `style-src 'self'` and refused by the shipped policy (a naive mount renders unstyled; the
	 * CSP pre-probe showed the refusal). Inside a shadow root, style-mod takes its
	 * constructable-stylesheet path (`adoptedStyleSheets` + `insertRule`), which CSP does not
	 * govern: the editor styles cleanly with no policy change and no nonce. The page has no
	 * honest nonce to hand CodeMirror (Tauri mints per-serve nonces only where
	 * `__TAURI_STYLE_NONCE__` appears in the built assets, and the page cannot read its own
	 * response header), so the nonce route was measured and rejected. The theme's `--tp-*`
	 * custom properties inherit across the shadow boundary, so the editor still themes through
	 * the same roles as the rest of the room.
	 *
	 * Round-trip byte fidelity — what the editor holds is what the room saves — is witnessed in
	 * `DocumentEditor.component.test.ts`, and live against the server in `guarded_save_live`.
	 */
	import { EditorView, keymap } from '@codemirror/view';
	import { EditorState } from '@codemirror/state';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
	import { tags as t } from '@lezer/highlight';
	import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

	let {
		/** The markdown the room holds as its base — the editor composes over it verbatim. */
		initial,
		/** Bound, two-way: the editor's current text, so the room can compare against the base. */
		value = $bindable(initial),
		/** Bound, two-way: whether the editor is focused, for the room's chrome. */
		focused = $bindable(false),
		/** Called once the view exists, and again with `null` when it is torn down. */
		onview
	}: {
		initial: string;
		value?: string;
		focused?: boolean;
		onview?: (view: EditorView | null) => void;
	} = $props();

	let host = $state<HTMLDivElement | null>(null);
	let view: EditorView | null = null;

	/**
	 * The editor's token colours. Markdown's own structure reads as the page's typography —
	 * headings in the reading font, emphasis as emphasis, code spans in the doing font — and
	 * every tag inside a fence maps onto the same `--tp-code-*` roles the rendered fences use,
	 * so the editor and the read view agree on what a string, a keyword or a comment looks
	 * like. The style rides the highlighter's class generation (`.cm-…`), never an inline
	 * style attribute, so the shipped CSP governs nothing here it did not already.
	 */
	const HIGHLIGHTS = HighlightStyle.define([
		// — Markdown structure —
		{ tag: t.heading1, color: 'var(--tp-text)', fontFamily: 'var(--tp-font-reading)', fontSize: '1.2em', fontWeight: '400' },
		{ tag: t.heading2, color: 'var(--tp-text)', fontFamily: 'var(--tp-font-reading)', fontWeight: '500' },
		{ tag: t.heading, color: 'var(--tp-text)', fontFamily: 'var(--tp-font-reading)' },
		{ tag: t.emphasis, fontStyle: 'italic', color: 'var(--tp-text)' },
		{ tag: t.strong, fontWeight: '600', color: 'var(--tp-text)' },
		{ tag: t.link, color: 'var(--tp-accent)', textDecoration: 'underline' },
		{ tag: t.url, color: 'var(--tp-text-faint)' },
		{ tag: t.monospace, fontFamily: 'var(--tp-font-doing)', color: 'var(--tp-code-key)' },
		{ tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--tp-text-faint)' },
		{ tag: t.quote, color: 'var(--tp-text-muted)', fontStyle: 'italic' },
		{ tag: t.list, color: 'var(--tp-text)' },
		{ tag: t.contentSeparator, color: 'var(--tp-text-faint)' },
		// — Inside fences: the same roles the hljs theme gives the rendered body —
		{ tag: t.keyword, color: 'var(--tp-code-number)' },
		{ tag: t.controlKeyword, color: 'var(--tp-code-number)' },
		{ tag: t.moduleKeyword, color: 'var(--tp-code-number)' },
		{ tag: t.string, color: 'var(--tp-code-string)' },
		{ tag: t.number, color: 'var(--tp-code-number)' },
		{ tag: t.bool, color: 'var(--tp-code-number)' },
		{ tag: t.atom, color: 'var(--tp-code-number)' },
		{ tag: t.comment, color: 'var(--tp-code-comment)', fontStyle: 'italic' },
		{ tag: [t.propertyName, t.attributeName], color: 'var(--tp-code-key)' },
		{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--tp-text)' },
		{ tag: t.typeName, color: 'var(--tp-code-number)' },
		{ tag: t.tagName, color: 'var(--tp-code-key)' },
		{ tag: t.meta, color: 'var(--tp-code-key)' },
		{ tag: t.processingInstruction, color: 'var(--tp-text-faint)' },
		{ tag: t.regexp, color: 'var(--tp-code-string)' },
		{ tag: t.escape, color: 'var(--tp-code-string)' }
	]);

	/** The editor's own styles live inside the shadow root: scoped styles do not reach in. */
	const EDITOR_CSS = `
		:host { display: block; }
		.cm-editor { height: 100%; outline: none; }
		.cm-scroller { font-family: inherit; overflow: auto; }
		.cm-gutters { border-right: 1px solid var(--tp-rule); color: var(--tp-text-faint); }
		.cm-activeLine { background: var(--tp-accent-wash); }
		.cm-content { caret-color: var(--tp-accent); }
		.cm-cursor { border-left-color: var(--tp-accent); }
		.cm-selectionBackground { background: var(--tp-accent-line-soft) !important; }
	`;

	$effect(() => {
		if (!host) return;
		const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(EDITOR_CSS);
		shadow.adoptedStyleSheets = [sheet];

		const state = EditorState.create({
			doc: initial,
			extensions: [
				history(),
				markdown({ base: markdownLanguage }),
				syntaxHighlighting(HIGHLIGHTS),
				keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
				EditorView.lineWrapping,
				EditorView.updateListener.of((u) => {
					if (u.docChanged) {
						value = u.state.doc.toString();
					}
				})
			]
		});
		const v = new EditorView({ state, parent: shadow });
		view = v;
		onview?.(v);
		return () => {
			v.destroy();
			view = null;
			onview?.(null);
			sheet.replaceSync('');
		};
	});

	$effect(() => {
		if (focused && view && !view.hasFocus) view.focus();
	});
</script>

<div class="editor" bind:this={host}></div>

<style>
	/* The frame is the host's: everything inside the shadow root is styled by the editor's own
	   adopted stylesheet above. */
	.editor {
		display: block;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		color: var(--tp-text);
		min-height: 24rem;
		max-height: 60vh;
		overflow: hidden;
		font-family: var(--tp-font-doing);
		font-size: 0.95rem;
		line-height: 1.6;
		tab-size: 2;
	}
</style>