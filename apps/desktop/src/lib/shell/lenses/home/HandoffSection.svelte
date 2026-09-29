<script lang="ts">
	/**
	 * temper-workflows' latest handoff, pinned to home under Resume: the newest session the person
	 * wrote, and the next steps it recorded, quoted as written. Two reads per show — the session,
	 * then its body — and nothing summarised: a session with no "Next" heading shows as a link and
	 * nothing more.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import RegionState from '$lib/components/RegionState.svelte';
	import ResourceRef from '$lib/components/ResourceRef.svelte';
	import type { DocOpened } from '$lib/document';
	import { ageWords, type TemperRecentPage, type TemperRecentRow } from '$lib/temper-views.svelte';
	import type { LensProps } from '../../lenses';
	import { type NextSection, nextSection } from '../../next-section';

	let { shown = 0 }: LensProps = $props();

	type Handoff =
		| { state: 'arriving' }
		| { state: 'none' }
		| { state: 'present'; session: TemperRecentRow; next: NextSection | null }
		| { state: 'failed'; message: string };

	let handoff = $state<Handoff>({ state: 'arriving' });
	let lastShow = -1;

	async function read(show: number): Promise<void> {
		try {
			const page = await invoke<TemperRecentPage>('temper_list_resources', {
				filter: { docType: 'session', owner: '@me' },
				limit: 1,
				offset: 0
			});
			const session = page.rows[0];
			if (!session) {
				if (show === lastShow) handoff = { state: 'none' };
				return;
			}
			const opened = await invoke<DocOpened>('doc_open', { id: session.id });
			const next = opened.state === 'opened' ? nextSection(opened.markdown) : null;
			if (show === lastShow) handoff = { state: 'present', session, next };
		} catch (e) {
			// A read that fails after one landed keeps what landed.
			if (show === lastShow && handoff.state !== 'present') {
				handoff = { state: 'failed', message: String(e) };
			}
		}
	}

	$effect(() => {
		if (shown === lastShow) return;
		lastShow = shown;
		void read(shown);
	});
</script>

{#if handoff.state === 'arriving'}
	<RegionState state="arriving" label="your latest handoff" />
{:else if handoff.state === 'failed'}
	<RegionState state="failed" label="your latest handoff" detail={handoff.message} />
{:else if handoff.state === 'none'}
	<RegionState
		state="empty"
		label="sessions recorded yet"
		detail="Sessions you record with an agent appear here, and their next steps with them."
	/>
{:else}
	<div class="handoff">
		<p class="t-strip">
			latest handoff <span aria-hidden="true">·</span> session <span aria-hidden="true">·</span>
			{ageWords(Date.parse(handoff.session.updated))}
		</p>
		<ResourceRef id={handoff.session.id} titleHint={handoff.session.title} />
		{#if handoff.next}
			<figure class="next">
				<figcaption class="t-strip">excerpt · {handoff.next.heading}</figcaption>
				<blockquote>{handoff.next.text}</blockquote>
				{#if handoff.next.truncated}
					<p class="continues">… continues in the session.</p>
				{/if}
			</figure>
		{/if}
	</div>
{/if}

<style>
	.handoff {
		display: grid;
		gap: 0.45rem;
		justify-items: start;
		padding: 0.9rem 1.1rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-panel);
		background: var(--tp-surface);
		/* Track clamp: this section bounds the rows it holds; a nowrap title inside must
		   not widen the column past the room. */
		min-width: 0;
	}
	.handoff > .t-strip {
		margin: 0;
	}
	.next {
		display: grid;
		gap: 0.3rem;
		margin: 0.2rem 0 0;
	}
	.next figcaption {
		margin: 0;
	}
	blockquote {
		margin: 0;
		padding-left: 0.8rem;
		border-left: 2px solid var(--tp-accent-line-soft);
		white-space: pre-line;
		font: italic 0.92rem var(--tp-font-reading);
		color: var(--tp-text);
	}
	.continues {
		margin: 0;
		font: italic 0.8rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
</style>
