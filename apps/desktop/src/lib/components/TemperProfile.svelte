<script lang="ts">
	import { ageWords, temperViews } from '$lib/temper-views.svelte';

	/**
	 * The profile-and-status piece: who temper says the person is, and temper's
	 * connection state, as words. The words temper has not declared get no
	 * rendering — and nothing here is ever a payload. With temper unreachable
	 * the piece shows the cached identity and says its age; unknown shows
	 * nothing rather than a state nobody named.
	 */
	const v = temperViews;

	const age = $derived(v.profileFetchedAt === null ? '' : ageWords(v.profileFetchedAt));
</script>

<span class="piece">
	{#if v.profileIdentity}
		<span class="identity">
			{v.profileIdentity.displayName}{#if v.profileIdentity.handle}
				<span class="handle">@{v.profileIdentity.handle}</span>{/if}
		</span>
		{#if !v.profileFresh}
			<span class="age">from cache, {age}</span>
		{/if}
	{/if}
	{#if v.connected === false}
		<span class="state" title={v.connectError ?? undefined}
			>Not connected{#if v.connectError} — {v.connectError}{/if}.</span
		>
	{:else if v.connected === true && v.profileIdentity}
		<span class="state">connected</span>
	{:else if v.connected === true}
		<span class="state" title={v.profileError || undefined}
			>identity not read{#if v.profileError} — {v.profileError}{/if}.</span
		>
	{/if}
</span>

<style>
	.piece {
		display: inline-flex;
		align-items: baseline;
		gap: 0.6rem;
		font: 0.85rem var(--tp-font-doing);
	}
	.identity {
		color: var(--tp-text);
	}
	.handle,
	.state {
		color: var(--tp-text-muted);
	}
	.age {
		font: italic 0.8rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
</style>
