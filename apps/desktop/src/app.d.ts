// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		interface PageData {
			/** The room's declared identity, read by the layout's frame. The root declares no way out. */
			room?: { title?: string; wayOut?: { href: string; label: string } };
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
