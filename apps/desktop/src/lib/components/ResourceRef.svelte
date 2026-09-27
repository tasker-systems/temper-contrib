<script lang="ts">
	/**
	 * A resource reference, resolved from its id. The title shown is the one temper holds; a
	 * `titleHint` shows only while resolving, and an id that does not resolve reads as
	 * unresolved — never as the hint — so no author can make a ref that reads as one resource
	 * and is another.
	 *
	 * A resolved reference is a link into the document room at the address temper gave it.
	 * Resolving, unresolved and failed references stay inert: a link to what temper did not
	 * answer for would overstate itself. `hrefFor` lets a room carry its walk into the link. A long
	 * title is truncated to one line, so the tooltip leads with the whole title, then the home and
	 * the decorated ref.
	 */
	import { roomHref } from '$lib/document';
	import { getRefResolver, type Resolution } from '$lib/refs';

	let {
		id,
		titleHint,
		block,
		hrefFor = (decoratedRef: string) => roomHref(decoratedRef)
	}: {
		id: string;
		titleHint?: string | null;
		block?: string | null;
		hrefFor?: (decoratedRef: string) => string;
	} = $props();

	const resolver = getRefResolver();
	let resolution = $state<Resolution | null>(null);

	$effect(() => {
		const asked = id;
		resolution = null;
		resolver.resolve(asked).then((r) => {
			if (asked === id) resolution = r;
		});
	});

	const DOC_TYPES = new Set(['research', 'task', 'session', 'concept', 'goal', 'decision', 'memory']);
	const typeColour = (docType: string) =>
		DOC_TYPES.has(docType) ? `var(--tp-doctype-${docType})` : 'var(--tp-text-subtle)';
</script>

{#if resolution === null}
	<span class="ref arriving" role="status" title={id}>
		<span class="type" aria-hidden="true">◌</span>
		<span class="title">{titleHint ?? 'resolving reference'}…</span>
	</span>
{:else if resolution.state === 'resolved'}
	<a
		class="ref"
		href={hrefFor(resolution.decoratedRef)}
		title={[resolution.title, resolution.contextRef, resolution.decoratedRef].filter(Boolean).join('\n')}
	>
		<span class="type" style:color={typeColour(resolution.docType)}>{resolution.docType}</span>
		<span class="title">{resolution.title}</span>
		{#if block}<span class="block">¶ {block}</span>{/if}
	</a>
{:else if resolution.state === 'unresolved'}
	<span class="ref unresolved" title={id}>
		<span class="type" aria-hidden="true">⊘</span>
		<span class="title">Unresolved reference — {resolution.reason}</span>
	</span>
{:else}
	<span class="ref failed" role="alert" title={resolution.message}>
		<span class="type" aria-hidden="true">!</span>
		<span class="title">Reference unavailable — nothing was read</span>
	</span>
{/if}

<style>
	.ref {
		display: inline-flex;
		align-items: baseline;
		gap: 0.45rem;
		max-width: 100%;
		padding: 0.3rem 0.55rem;
		border: 1px solid var(--tp-rule);
		background: var(--tp-surface-raised);
		border-radius: var(--tp-radius-chip);
	}
	a.ref {
		text-decoration: none;
		transition: border-color var(--tp-motion-quick) var(--tp-motion-easing);
	}
	a.ref:hover {
		border-color: var(--tp-accent-line);
	}
	.type {
		flex: none;
		font: 0.56rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-label);
		text-transform: uppercase;
	}
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: italic 0.88rem var(--tp-font-reading);
		color: var(--tp-text);
	}
	.block {
		flex: none;
		font: 0.6rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	.arriving .type {
		color: var(--tp-region-arriving);
	}
	.arriving .title {
		color: var(--tp-text-subtle);
	}
	.unresolved {
		border-style: dashed;
		border-color: var(--tp-rule-strong);
		background: none;
	}
	.unresolved .type,
	.unresolved .title {
		color: var(--tp-text-subtle);
	}
	.failed {
		border-color: var(--tp-region-failed);
		background: var(--tp-region-failed-wash);
	}
	.failed .type,
	.failed .title {
		color: var(--tp-region-failed);
		font-style: normal;
	}
</style>
