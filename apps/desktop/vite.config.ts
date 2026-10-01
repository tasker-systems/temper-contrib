import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// The theme contract and themes live at the repository root (`themes/`) and are read in place,
// never copied: one source for every consumer. Vite resolves this against the project root.
const themes = '../../themes';

// The dev server's Content-Security-Policy. The shipped policy lives in tauri.conf.json
// (`app.security.csp`) and Tauri applies it to the bundled assets; under `tauri dev` on desktop the
// webview loads this server directly, so Tauri applies no policy and `devCsp` would be inert.
// This header is the dev policy instead: the shipped one, loosened only where Vite's dev runtime
// needs it — inline bootstrap scripts and injected <style> tags, and the HMR websocket.
const hmrHost = host || 'localhost';
const devCsp = [
	"default-src 'none'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self'",
	"img-src 'self' data:",
	`connect-src 'self' ipc: http://ipc.localhost ws://${hmrHost}:1420 ws://${hmrHost}:1421`,
	"base-uri 'none'",
	"form-action 'none'"
].join('; ');

// Set on every dev response. Vite's `server.headers` does not reach the pages SvelteKit's
// middleware serves, and the page is the document the policy has to govern.
const devCspHeader: Plugin = {
	name: 'temper-dev-csp',
	apply: 'serve',
	configureServer(server) {
		server.middlewares.use((_req, res, next) => {
			res.setHeader('Content-Security-Policy', devCsp);
			next();
		});
	}
};

// https://vite.dev/config/
export default defineConfig(async () => ({
	plugins: [devCspHeader, tailwindcss(), sveltekit()],

	// Fonts ship as files, never inlined as `data:` URIs: the webview's CSP admits fonts from the
	// app's own origin only (`font-src 'self'`, tauri.conf.json). Other small assets keep Vite's
	// default inlining, which `img-src 'self' data:` admits.
	build: {
		assetsInlineLimit: (file: string) => (/\.woff2?$/.test(file) ? false : undefined)
	},

	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent Vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: 'ws',
					host,
					port: 1421
				}
			: undefined,
		watch: {
			// 3. tell Vite to ignore watching `src-tauri`
			ignored: ['**/src-tauri/**']
		},
		fs: {
			allow: ['.', themes]
		}
	},

	test: {
		// Two projects because the two kinds of test want different environments: pure modules
		// run in node; `*.component.test.ts` mounts real components in jsdom. Without the
		// `browser` condition Svelte resolves to its server build, where `render()` throws and
		// `$state` does not proxy — a probe there proves nothing.
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: ['src/**/*.test.ts'],
					exclude: [...configDefaults.exclude, 'src/**/*.component.test.ts'],
					environment: 'node'
				}
			},
			{
				extends: true,
				resolve: { conditions: ['browser'] },
				test: {
					name: 'component',
					include: ['src/**/*.component.test.ts'],
					environment: 'jsdom',
					setupFiles: ['src/test/component-setup.ts'],
					// The shell suite's beforeAll warms the lazy lens imports so
					// individual tests never pay a cold transform; on a shared CI
					// runner under vitest's default 10s hook timeout that warming
					// itself can outlast the hook. 60s keeps the hook honest (a
					// wedged import still fails) without turning CI load into a
					// flake.
					hookTimeout: 60_000
				}
			}
		]
	}
}));
