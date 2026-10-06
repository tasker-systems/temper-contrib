<script lang="ts">
	/**
	 * Core's connection place: the temper connection's setup and edit, opened
	 * as a tab — or chained onto at first run, when the machine carries no
	 * config to enter at.
	 */
	import ConnectionRoom from '$lib/components/ConnectionRoom.svelte';
	import type { LensProps } from '../lenses';

	// The room takes the tab handle: the first-run chain moves on to the setup
	// room through the one door when apply and sign-in land.
	let props: LensProps = $props();
</script>

<ConnectionRoom tab={props.tab} />
