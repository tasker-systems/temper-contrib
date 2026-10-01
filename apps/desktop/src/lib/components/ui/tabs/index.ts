// bits-ui's tabs, copied into the repo the way shadcn-svelte copies its parts: the primitive's
// behaviour (roving focus, ARIA, selection) is bits-ui's; the appearance is ours, read from
// theme roles.
import { Tabs } from 'bits-ui';
import Content from './tabs-content.svelte';
import List from './tabs-list.svelte';
import Trigger from './tabs-trigger.svelte';

export const Root = Tabs.Root;
export { Content, List, Trigger };
