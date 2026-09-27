<script lang="ts">
	import DocumentRoom from '$lib/components/DocumentRoom.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<!-- One room per address: walking to another document starts its reads afresh. -->
{#key data.ident}
	<DocumentRoom ident={data.ident} walk={data.walk} />
{/key}
