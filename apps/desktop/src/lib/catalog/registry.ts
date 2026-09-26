/** Catalog component name → the Svelte component json-render renders for it. */
import { defineRegistry } from '@json-render/svelte';
import { temperCatalog } from './catalog';
import RegionState from './adapters/RegionState.svelte';
import BoundedList from './adapters/BoundedList.svelte';
import ResourceRef from './adapters/ResourceRef.svelte';

export const { registry: temperRegistry } = defineRegistry(temperCatalog, {
	components: { RegionState, BoundedList, ResourceRef }
});
