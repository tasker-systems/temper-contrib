import { configDefaults, defineConfig } from "vitest/config";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// The theme contract and themes live at the repository root (`themes/`) and are read in place,
// never copied: one source for every consumer. Vite resolves this against the project root.
const themes = "../../themes";

// https://vite.dev/config/
export default defineConfig(async () => ({
	plugins: [tailwindcss(), sveltekit()],

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
					protocol: "ws",
					host,
					port: 1421
				}
			: undefined,
		watch: {
			// 3. tell Vite to ignore watching `src-tauri`
			ignored: ["**/src-tauri/**"]
		},
		fs: {
			allow: [".", themes]
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
					name: "unit",
					include: ["src/**/*.test.ts"],
					exclude: [...configDefaults.exclude, "src/**/*.component.test.ts"],
					environment: "node"
				}
			},
			{
				extends: true,
				resolve: { conditions: ["browser"] },
				test: {
					name: "component",
					include: ["src/**/*.component.test.ts"],
					environment: "jsdom",
					setupFiles: ["src/test/component-setup.ts"]
				}
			}
		]
	}
}));
