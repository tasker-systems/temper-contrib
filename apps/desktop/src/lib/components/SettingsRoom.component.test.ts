// The settings room's witnesses: the person's context name reads from the
// device store and saves back through it, and agents are configuration —
// read from the store, saved into it, removed from it. `invoke` is mocked.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Page from './SettingsRoom.svelte';

// jsdom has no matchMedia; the theme control watches the system preference.
if (!window.matchMedia) {
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false
	})) as unknown as typeof window.matchMedia;
}

const storedAgents: Record<string, { label?: string; command?: string }> = {
	opencode: { label: 'opencode', command: 'opencode acp' }
};

describe('the settings room', () => {
	beforeEach(() => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === 'settings_get') {
				return Promise.resolve({
					workingDir: '/w',
					temperContext: 'my-context',
					agents: storedAgents
				});
			}
			return Promise.resolve(null);
		}) as never);
	});

	/** The temper context's field is the last input in the room, after the
	 *  agents section added its own inputs ahead of it. */
	async function contextInput(container: HTMLElement): Promise<HTMLInputElement> {
		return vi.waitFor(() => {
			const inputs = [...container.querySelectorAll('input')];
			const found = inputs.at(-1) as HTMLInputElement;
			expect(found.value).toBe('my-context');
			return found;
		});
	}

	it('reads the configured temper context from the store', async () => {
		const { container } = render(Page);
		await contextInput(container);
	});

	it('saves a changed context name through the store', async () => {
		const { container } = render(Page);
		const input = await contextInput(container);
		await fireEvent.input(input, { target: { value: 'renamed-context' } });

		const saves = [...container.querySelectorAll('button')].filter(
			(b) => b.textContent === 'Save' || b.textContent === 'Saving…'
		);
		// The working directory's save is first, the device label's second, the temper context's last.
		expect(saves.length).toBe(3);
		await fireEvent.click(saves[2]);

		await vi.waitFor(() =>
			expect(vi.mocked(invoke)).toHaveBeenCalledWith('settings_set_temper_context', {
				name: 'renamed-context'
			})
		);
	});
});

describe("this device's label", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === 'settings_get') {
				return Promise.resolve({ workingDir: '/w', temperContext: 'c', deviceLabel: 'station' });
			}
			return Promise.resolve(null);
		}) as never);
	});

	it('reads the label from the store and saves a change through it', async () => {
		const { container } = render(Page);
		const input = await vi.waitFor(() => {
			const found = container.querySelector(
				'input[placeholder="this machine\'s hostname"]'
			) as HTMLInputElement;
			expect(found.value).toBe('station');
			return found;
		});
		await fireEvent.input(input, { target: { value: 'laptop' } });
		const save = [...container.querySelectorAll('button')].filter(
			(b) => b.textContent === 'Save'
		)[1];
		await fireEvent.click(save);
		await vi.waitFor(() =>
			expect(vi.mocked(invoke)).toHaveBeenCalledWith('settings_set_device_label', {
				label: 'laptop'
			})
		);
	});
});

describe('agents by configuration', () => {
	beforeEach(() => {
		for (const key of Object.keys(storedAgents)) delete storedAgents[key];
		storedAgents.opencode = { label: 'opencode', command: 'opencode acp' };
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'settings_get') {
				return Promise.resolve({ workingDir: '/w', temperContext: 'c', agents: storedAgents });
			}
			if (cmd === 'settings_set_agent' && args) {
				const { key, launch } = args as {
					key: string;
					launch: { label?: string; command?: string };
				};
				storedAgents[key] = { label: launch.label, command: launch.command };
			}
			if (cmd === 'settings_remove_agent' && args) {
				delete storedAgents[(args as { key: string }).key];
			}
			return Promise.resolve(null);
		}) as never);
	});

	it('reads the configured roster from the store and names none when there is none', async () => {
		const { container } = render(Page);
		await vi.waitFor(() =>
			expect(container.querySelector('.agent-list')?.textContent).toContain('opencode')
		);

		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === 'settings_get') return Promise.resolve({ agents: {} });
			return Promise.resolve(null);
		}) as never);
		const empty = render(Page);
		await vi.waitFor(() => expect(empty.container.textContent).toContain('none configured'));
	});

	it('saves a new agent into the store with its label and launch command', async () => {
		const { container } = render(Page);
		const form = await vi.waitFor(() => {
			const found = container.querySelector('.agent-form');
			expect(found).not.toBeNull();
			return found as HTMLElement;
		});
		const inputs = [...form.querySelectorAll('input')] as HTMLInputElement[];
		await fireEvent.input(inputs[0], { target: { value: 'cursor' } });
		await fireEvent.input(inputs[1], { target: { value: 'cursor cli' } });
		await fireEvent.input(inputs[2], { target: { value: 'cursor-agent --acp' } });
		await fireEvent.click(form.querySelector('button') as HTMLButtonElement);

		await vi.waitFor(() =>
			expect(vi.mocked(invoke)).toHaveBeenCalledWith('settings_set_agent', {
				key: 'cursor',
				launch: { label: 'cursor cli', command: 'cursor-agent --acp' }
			})
		);
		await vi.waitFor(() => expect(storedAgents.cursor?.command).toBe('cursor-agent --acp'));
	});

	it('removes a configured agent, leaving the roster empty — never a hardcoded default', async () => {
		const { container } = render(Page);
		await vi.waitFor(() =>
			expect(container.querySelector('.agent-list')?.textContent).toContain('opencode')
		);
		const remove = [...container.querySelectorAll('.agent-list button')].find(
			(b) => b.textContent === 'remove'
		);
		await fireEvent.click(remove as HTMLButtonElement);

		await vi.waitFor(() =>
			expect(vi.mocked(invoke)).toHaveBeenCalledWith('settings_remove_agent', {
				key: 'opencode'
			})
		);
		await vi.waitFor(() => expect(Object.keys(storedAgents)).toHaveLength(0));
	});
});
