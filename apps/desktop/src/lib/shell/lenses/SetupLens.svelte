<script lang="ts">
	/** Core's setup place: choosing the person context, opened as a tab — never on the app's behalf. */
	import SetupRoom from '$lib/components/SetupRoom.svelte';
	import type { LensProps } from '../lenses';

	// A place lens takes the props every lens is handed and needs none of them.
	let _props: LensProps = $props();
</script>

<SetupRoom />
