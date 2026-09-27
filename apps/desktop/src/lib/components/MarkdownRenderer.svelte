<script lang="ts">
	/**
	 * Rendered markdown. Ported from temper's temper-ui (tasker-systems/temper,
	 * packages/temper-ui/src/lib/components/MarkdownRenderer.svelte, at 5344abc) by
	 * copy-with-citation, per the desktop's rendering-baseline design. The mechanics are the
	 * baseline's; the `.md-body` styles are rewritten onto `--tp-*` roles (ruling 3): reading
	 * font for prose, doing font for code, rule/surface/accent roles for structure. Token colours
	 * for highlighted code are `themes/contract/base.css` (`.hljs .hljs-*`), shared with every
	 * other code surface.
	 */
	import { browser } from '$app/environment';
	import { prepareMarkdown } from '$lib/markdown/markdown';
	import RegionState from './RegionState.svelte';

	interface Props {
		markdown: string;
	}

	let { markdown }: Props = $props();

	// The sanitize pass is client-only and gates the {@html} below: while the sanitizer is
	// unavailable — for the instant before the dynamic import resolves — this component renders
	// no body at all. It never falls back to unsanitized output, which is why
	// `prepareMarkdown`'s parse result is safe to hold here. The pass itself (config, the
	// attribute hooks, the withheld-image refusal) lives in `$lib/markdown/sanitize`.
	let sanitizer: ((dirty: string) => string) | null = $state(null);

	if (browser) {
		import('$lib/markdown/sanitize').then((m) => {
			sanitizer = m.sanitizeMarkdownHtml;
		});
	}

	let parsed = $derived(prepareMarkdown(markdown));
</script>

{#if markdown}
	{#if sanitizer}
		<div class="md-body">
			{@html sanitizer(parsed)}
		</div>
	{/if}
{:else}
	<RegionState state="empty" label="content" />
{/if}

<style>
	.md-body {
		font: 1rem/1.7 var(--tp-font-reading);
		color: var(--tp-text-muted);
		overflow-wrap: anywhere;
	}

	/* ── Headings ─────────────────────────────────────────────────────── */

	.md-body :global(h1),
	.md-body :global(h2),
	.md-body :global(h3),
	.md-body :global(h4),
	.md-body :global(h5),
	.md-body :global(h6) {
		font-family: var(--tp-font-reading);
		color: var(--tp-text);
		line-height: 1.3;
	}

	.md-body :global(h1) {
		font-size: 1.5rem;
		font-weight: 400;
		margin: 2rem 0 0.7rem;
	}

	.md-body :global(h2) {
		font-size: 1.25rem;
		font-weight: 400;
		margin: 1.8rem 0 0.6rem;
		padding-bottom: 0.3rem;
		border-bottom: 1px solid var(--tp-rule);
	}

	.md-body :global(h3) {
		font-size: 1.05rem;
		font-weight: 600;
		margin: 1.5rem 0 0.4rem;
	}

	.md-body :global(h4),
	.md-body :global(h5),
	.md-body :global(h6) {
		font-size: 0.95rem;
		font-weight: 600;
		margin: 1.2rem 0 0.3rem;
	}

	.md-body :global(:is(h1, h2, h3, h4, h5, h6):first-child) {
		margin-top: 0;
	}

	/* ── Body text ────────────────────────────────────────────────────── */

	.md-body :global(p) {
		margin: 0 0 0.9rem;
	}

	.md-body > :global(:last-child) {
		margin-bottom: 0;
	}

	.md-body :global(strong) {
		color: var(--tp-text);
		font-weight: 600;
	}

	/* ── Links ────────────────────────────────────────────────────────── */

	.md-body :global(a) {
		color: var(--tp-accent);
		text-decoration: none;
		border-bottom: 1px solid var(--tp-accent-line-soft);
		transition: border-color var(--tp-motion-quick) var(--tp-motion-easing);
	}

	.md-body :global(a:hover) {
		border-bottom-color: var(--tp-accent);
	}

	/* ── Lists ────────────────────────────────────────────────────────── */

	.md-body :global(ul),
	.md-body :global(ol) {
		margin: 0 0 0.9rem;
		padding-left: 1.5rem;
	}

	.md-body :global(li) {
		margin-bottom: 0.25rem;
	}

	.md-body :global(li::marker) {
		color: var(--tp-accent);
	}

	.md-body :global(ul > li) {
		list-style-type: disc;
	}

	.md-body :global(ol > li) {
		list-style-type: decimal;
	}

	.md-body :global(li > ul),
	.md-body :global(li > ol) {
		margin-top: 0.25rem;
		margin-bottom: 0;
	}

	/* ── Inline code ──────────────────────────────────────────────────── */

	.md-body :global(code) {
		font-family: var(--tp-font-doing);
		font-size: 0.82em;
		color: var(--tp-text);
		background: var(--tp-surface-raised);
		padding: 0.12em 0.35em;
		border-radius: var(--tp-radius-chip);
	}

	/* ── Code blocks ──────────────────────────────────────────────────── */

	.md-body :global(pre) {
		background: var(--tp-surface-raised);
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-chip);
		padding: 0.8rem 1rem;
		margin: 0 0 0.9rem;
		overflow-x: auto;
	}

	.md-body :global(pre code) {
		background: none;
		padding: 0;
		color: var(--tp-text-muted);
		font-size: 0.8rem;
		line-height: 1.6;
		overflow-wrap: normal;
	}

	/* ── Blockquotes ──────────────────────────────────────────────────── */

	.md-body :global(blockquote) {
		border-left: 2px solid var(--tp-accent-line-soft);
		margin: 0 0 0.9rem;
		padding: 0.3rem 0 0.3rem 1.1rem;
		color: var(--tp-text-subtle);
		font-style: italic;
	}

	.md-body :global(blockquote p:last-child) {
		margin-bottom: 0;
	}

	/* ── Horizontal rules ─────────────────────────────────────────────── */

	.md-body :global(hr) {
		border: none;
		border-top: 1px solid var(--tp-rule);
		margin: 1.6rem 0;
	}

	/* ── Tables ───────────────────────────────────────────────────────── */

	.md-body :global(table) {
		display: block;
		max-width: 100%;
		overflow-x: auto;
		border-collapse: collapse;
		margin: 0 0 0.9rem;
		font: 0.85rem/1.5 var(--tp-font-ui);
	}

	.md-body :global(th) {
		text-align: left;
		padding: 0.45rem 0.7rem;
		border-bottom: 1px solid var(--tp-rule-strong);
		font: 0.62rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-strip);
		text-transform: uppercase;
		color: var(--tp-text-subtle);
	}

	.md-body :global(td) {
		padding: 0.4rem 0.7rem;
		border-bottom: 1px solid var(--tp-rule);
	}

	.md-body :global(tr:last-child td) {
		border-bottom: none;
	}

	/* ── Refusals ─────────────────────────────────────────────────────── */

	/* Both arrive through `{@html}` — REFUSAL_HTML from the parse gate, `md-withheld` from the
	   sanitizer's image arm — so the rules must be :global to reach them. A verdict, not an
	   alarm: the muted register, with the gave-up role's marker. */
	.md-body :global(.md-refusal) {
		color: var(--tp-text-subtle);
		font-style: italic;
	}

	.md-body :global(.md-withheld) {
		display: inline-block;
		padding: 0.1rem 0.5rem;
		border: 1px dashed var(--tp-region-gave-up);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-region-gave-up-wash);
		color: var(--tp-region-gave-up);
		font: 0.75rem var(--tp-font-doing);
	}

	.md-body :global(.md-withheld::before) {
		content: '⊘ ';
	}

	/* ── Images ───────────────────────────────────────────────────────── */

	.md-body :global(img) {
		max-width: 100%;
		border-radius: var(--tp-radius-chip);
		margin: 0.4rem 0 0.9rem;
	}
</style>
