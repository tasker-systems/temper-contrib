/** Catalog component name → the Svelte component json-render renders for it. */
import { defineRegistry } from '@json-render/svelte';
import BoundedList from './adapters/BoundedList.svelte';
import RegionState from './adapters/RegionState.svelte';
import ResourceRef from './adapters/ResourceRef.svelte';
import { temperCatalog } from './catalog';

export const { registry: temperRegistry } = defineRegistry(temperCatalog, {
	components: { RegionState, BoundedList, ResourceRef }
});
