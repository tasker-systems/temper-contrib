// Testing Library's default entry registers its hooks against the global `beforeEach`/`afterEach`,
// which vitest does not install without `globals`. The `/vitest` entry imports them from `vitest`
// and installs both halves — `cleanup` after each test, and the `act`/`flushSync` wrappers that
// make `waitFor` flush Svelte updates. (Carried from temper-ui's `src/test/component-setup.ts`.)
import '@testing-library/svelte/vitest';

// jsdom has no matchMedia; the theme store prefers the OS scheme when no
// setting exists. A stub matches nothing — the stored theme always wins.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false
		})
	});
}
