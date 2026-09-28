<script lang="ts">
	/**
	 * Home's Resume: the places the person last worked, drawn from the hub — the newest as the
	 * card to return to, then a few more. One gesture returns: the tab already showing the place
	 * is focused, else a new one opens through the lens the place was seen through.
	 *
	 * Titles come from temper, never from the hub (which holds none). What the hub cannot say is
	 * not said: no "what's next" is invented here — the handoff beside this section quotes the
	 * session that said it. A place left on another device says which.
	 */
	import BoundedList from '$lib/components/BoundedList.svelte';
	import RegionState from '$lib/components/RegionState.svelte';
	import ResourceRef from '$lib/components/ResourceRef.svelte';
	import { getRefResolver, type Resolution } from '$lib/refs';
	import { ageWords } from '$lib/temper-views.svelte';
	import { enabled } from '../../contributions';
	import { homeReads, type RecentWorkEntry } from '../../home-reads.svelte';
	import { type LensProps, lensById } from '../../lenses';
	import { tabs } from '../../tabs.svelte';

	let { shown = 0 }: LensProps = $props();

	/** How many places follow the card. */
	const MORE = 4;

	$effect(() => {
		homeReads.readRecent(shown);
	});

	const read = $derived(homeReads.recent);
	const entries = $derived(read.state === 'present' ? read.data.entries : []);
	const thisDevice = $derived(read.state === 'present' ? read.data.thisDevice : undefined);
	const queued = $derived(read.state === 'present' ? read.data.queued : 0);
	const primary = $derived(entries[0] ?? null);
	const more = $derived(entries.slice(1, 1 + MORE));

	// The card needs to know whether its place still resolves: a place temper no longer answers
	// for offers no way back.
	const resolver = getRefResolver();
	let resolution = $state<Resolution | null>(null);
	$effect(() => {
		const asked = primary?.resource;
		resolution = null;
		if (!asked) return;
		resolver.resolve(asked).then((r) => {
			if (asked === primary?.resource) resolution = r;
		});
	});

	const lensName = (entry: RecentWorkEntry) => lensById(entry.room, enabled)?.name ?? entry.room;

	/** Where and when, in words: the lens, how long ago, and the device when it isn't this one. */
	function whereWhen(entry: RecentWorkEntry): string {
		const left = Date.parse(entry.leftAt);
		const age = Number.isNaN(left) ? 'at an unknown time' : ageWords(left);
		const elsewhere = thisDevice && entry.device !== thisDevice ? ` on ${entry.device}` : '';
		return `in its ${lensName(entry)} lens, ${age}${elsewhere}`;
	}

	function returnTo(entry: RecentWorkEntry): void {
		tabs.focusOrOpen({ kind: 'resource', id: entry.resource }, entry.room);
	}
</script>

{#if read.state === 'arriving'}
	<RegionState state="arriving" label="where you last worked" />
{:else if read.state === 'failed'}
	<RegionState state="failed" label="where you last worked" detail={read.message} />
{:else if !primary}
	<RegionState
		state="empty"
		label="places of work recorded yet"
		detail="Places you work appear here. Open something from the ways-in panel, or start a session."
	/>
{:else}
	<div class="card" data-resume={primary.resource}>
		<ResourceRef id={primary.resource} />
		<p class="when">You were {whereWhen(primary)}.</p>
		{#if resolution?.state === 'resolved'}
			<button class="t-action return" onclick={() => returnTo(primary)}>
				return <span aria-hidden="true">→</span>
			</button>
		{/if}
	</div>

	{#if entries.length > 1}
		<BoundedList
			label="earlier places of work"
			scope="earlier places of work"
			state="present"
			total={entries.length - 1}
			shown={more.length}
		>
			{#each more as entry (entry.resource)}
				<span class="row">
					<ResourceRef id={entry.resource} />
					<span class="sub">{whereWhen(entry)}</span>
					<button class="t-action" onclick={() => returnTo(entry)}>return</button>
				</span>
			{/each}
		</BoundedList>
	{/if}

	{#if queued > 0}
		<p class="queued">
			{queued === 1 ? 'One place' : `${queued} places`} here {queued === 1 ? 'is' : 'are'} kept on this device
			until temper has {queued === 1 ? 'it' : 'them'}.
		</p>
	{/if}
{/if}

<style>
	.card {
		display: grid;
		gap: 0.5rem;
		justify-items: start;
		padding: 1rem 1.1rem;
		border: 1px solid var(--tp-accent-line-soft);
		border-radius: var(--tp-radius-panel);
		background: var(--tp-surface);
	}
	.when {
		margin: 0;
		font: italic 0.9rem var(--tp-font-reading);
		color: var(--tp-text-muted);
	}
	.return {
		padding: 0;
	}
	.row {
		flex-wrap: wrap;
	}
	.sub {
		flex: 1;
		font-size: 0.8rem;
		color: var(--tp-text-subtle);
	}
	.queued {
		margin: 0;
		font: italic 0.8rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
</style>
