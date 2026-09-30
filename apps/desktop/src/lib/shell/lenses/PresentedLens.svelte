<script lang="ts">
	/**
	 * The presented-view lens: a recorded presentation read from temper and rendered through
	 * TemperView. The read goes through `present_read`, whose projection is the gate — only the
	 * person's own live pinned record whose spec passes the core's check comes back — so what
	 * arrives is either a record or the read's one refusal. The render then passes TemperView's
	 * gate too: the two gates are separate by design (a record written around the shape, or by a
	 * later catalog), and neither lends the other its verdict.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import RegionState from '$lib/components/RegionState.svelte';
	import TemperView from '$lib/catalog/TemperView.svelte';
	import type { LensProps } from '../lenses';

	type PresentedRead = {
		resource: string;
		artifact: string;
		record: {
			version: number;
			conversationId: string;
			agent: string;
			catalogVersion: string;
			presentedAt: string;
			spec: unknown;
			outcome: string;
		};
	};

	type ReadState =
		| { state: 'reading' }
		| { state: 'refused'; message: string }
		| { state: 'read'; read: PresentedRead };

	let { subject, tab }: LensProps = $props();

	let read = $state<ReadState>({ state: 'reading' });

	// One read per step: the record is pinned, so the read is not repeated on focus — a step's
	// lens lives exactly as long as its step.
	$effect(() => {
		if (subject.kind !== 'presentation') return;
		let gone = false;
		read = { state: 'reading' };
		invoke<PresentedRead>('present_read', {
			resource: subject.resource,
			artifact: subject.artifact
		}).then(
			(answer) => {
				if (gone) return;
				read = { state: 'read', read: answer };
			},
			(err) => {
				if (gone) return;
				read = { state: 'refused', message: String(err) };
			}
		);
		return () => {
			gone = true;
		};
	});

	const title = $derived(read.state === 'read' ? `presented view — ${read.read.record.agent}` : null);
	$effect(() => {
		if (title) tab?.setTitle(title);
	});
</script>

{#if subject.kind !== 'presentation'}
	<div class="page">
		<RegionState state="failed" label="this presented view" detail="the subject is not one" />
	</div>
{:else if read.state === 'reading'}
	<div class="page"><RegionState state="arriving" label="the presented view" /></div>
{:else if read.state === 'refused'}
	<div class="page">
		<RegionState state="failed" label="this presented view" detail={read.message} />
	</div>
{:else}
	<div class="page presented">
		<p class="t-strip who">
			{read.read.record.agent} presented <span aria-hidden="true">·</span>
			{read.read.record.catalogVersion} <span aria-hidden="true">·</span>
			{read.read.record.presentedAt}
		</p>
		<TemperView spec={read.read.record.spec} />
	</div>
{/if}

<style>
	.page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
		min-width: 0;
	}
	.who {
		margin: 0 0 1rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>