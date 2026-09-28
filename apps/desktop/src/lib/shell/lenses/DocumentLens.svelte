<script lang="ts">
	/** Core's document lens: the document room, over the answer its tab read on opening. */
	import DocumentRoom from '$lib/components/DocumentRoom.svelte';
	import type { LensProps } from '../lenses';

	let { subject, opened, tab }: LensProps = $props();
	const id = $derived(subject.kind === 'resource' ? subject.id : '');
</script>

<DocumentRoom {id} {opened} {tab} />
