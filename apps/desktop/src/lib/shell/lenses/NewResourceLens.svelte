<script lang="ts">
	/**
	 * Core's new-resource place: creating a resource in one named context — opened from that
	 * context's room, never on the app's behalf.
	 */
	import NewResourceRoom from '$lib/components/NewResourceRoom.svelte';
	import type { LensProps } from '../lenses';

	let { subject, tab }: LensProps = $props();
</script>

<NewResourceRoom {tab} context={subject.kind === 'place' ? subject.context : undefined} />
