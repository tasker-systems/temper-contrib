import type { PageLoad } from './$types';

/** The home room declares its identity. It declares no way out: the root has nowhere to exit to, and an exit that cannot complete is a false affordance. */
export const load: PageLoad = () => ({ room: { title: 'home' } });
