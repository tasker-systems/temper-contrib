<script lang="ts">
	/** Core's settings place: the device's preferences, opened as a tab. */
	import SettingsRoom from '$lib/components/SettingsRoom.svelte';
	import type { LensProps } from '../lenses';

	// A place lens takes the props every lens is handed and needs none of them.
	let _props: LensProps = $props();
</script>

<SettingsRoom />
