// bits-ui's accordion, copied into the repo the way shadcn-svelte copies its parts: the
// primitive's behaviour (keyboard, ARIA, open state) is bits-ui's; the appearance is ours, read
// from theme roles. Root is the primitive's own; Item composes header, trigger and content.
import { Accordion } from 'bits-ui';
import Item from './accordion-item.svelte';

export const Root = Accordion.Root;
export { Item };
