/** Catalog component name → the Svelte component json-render renders for it. */
import { defineRegistry } from '@json-render/svelte';
import Accordion from './adapters/Accordion.svelte';
import BoundedList from './adapters/BoundedList.svelte';
import Chart from './adapters/Chart.svelte';
import Grid from './adapters/Grid.svelte';
import Heading from './adapters/Heading.svelte';
import RegionState from './adapters/RegionState.svelte';
import ResourceRef from './adapters/ResourceRef.svelte';
import Section from './adapters/Section.svelte';
import Stack from './adapters/Stack.svelte';
import Stat from './adapters/Stat.svelte';
import Table from './adapters/Table.svelte';
import Tabs from './adapters/Tabs.svelte';
import Tag from './adapters/Tag.svelte';
import Text from './adapters/Text.svelte';
import Timeline from './adapters/Timeline.svelte';
import { temperCatalog } from './catalog';

export const { registry: temperRegistry } = defineRegistry(temperCatalog, {
	components: {
		RegionState,
		BoundedList,
		ResourceRef,
		Stack,
		Grid,
		Heading,
		Text,
		Tag,
		Stat,
		Timeline,
		Table,
		Chart,
		Section,
		Accordion,
		Tabs
	}
});
