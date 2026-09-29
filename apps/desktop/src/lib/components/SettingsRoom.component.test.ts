// The settings room's witnesses: the person's context name reads from the
// device store and saves back through it, and agents are configuration —
// read from the store, saved into it, removed from it. `invoke` is mocked.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => async () => {}) }));

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

describe('agents from the ACP roster', () => {
	/** The roster the core offers: some on $PATH, one not there, one the store
	 *  already holds. The absent and the configured key render nothing. */
	const offered = [
		{
			key: 'opencode',
			label: 'OpenCode',
			binary: 'opencode',
			command: 'opencode acp',
			status: 'present'
		},
		{
			key: 'cursor',
			label: 'Cursor CLI',
			binary: 'agent',
			command: 'agent acp',
			status: 'present'
		},
		{
			key: 'gemini',
			label: 'Gemini CLI',
			binary: 'gemini',
			command: 'gemini --acp',
			status: 'absent'
		},
		{
			key: 'codex',
			label: 'Codex CLI',
			binary: 'npx',
			command: 'npx -y @agentclientprotocol/codex-acp',
			status: 'present'
		}
	];

	beforeEach(() => {
		for (const key of Object.keys(storedAgents)) delete storedAgents[key];
		storedAgents.opencode = { label: 'opencode', command: 'opencode acp' };
		vi.mocked(invoke).mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
			if (cmd === 'settings_get') {
				return Promise.resolve({ workingDir: '/w', temperContext: 'c', agents: storedAgents });
			}
			if (cmd === 'roster_get') {
				return Promise.resolve(offered.map((o) => ({ ...o })));
			}
			if (cmd === 'settings_set_agent' && args) {
				const { key, launch } = args as {
					key: string;
					launch: { label?: string; command?: string };
				};
				storedAgents[key] = { label: launch.label, command: launch.command };
			}
			return Promise.resolve(null);
		}) as never);
	});

	it('offers only the entries whose binary is present and not already configured', async () => {
		const { container } = render(Page);
		const roster = await vi.waitFor(() => {
			const found = container.querySelector('.roster');
			expect(found).not.toBeNull();
			return found as HTMLElement;
		});
		const rows = roster.querySelectorAll('li');
		// gemini is absent — its row does not render; opencode is already configured — same.
		expect(rows).toHaveLength(2);
		expect(roster.textContent).toContain('Cursor CLI');
		expect(roster.textContent).toContain('Codex CLI');
		expect(roster.textContent).not.toContain('gemini');
		expect(roster.textContent).not.toContain('OpenCode');
	});

	it('selects a preset into the device store with no typing of commands', async () => {
		const { container } = render(Page);
		// The first offered row is Cursor CLI — the opencode key is already
		// configured, so its preset is not offered again.
		await vi.waitFor(() => {
			expect(container.querySelectorAll('.roster li').length).toBe(2);
		});
		const row = [...container.querySelectorAll('.roster li')].find(
			(li) => !li.textContent?.includes('Codex')
		) as HTMLElement;
		const button = row.querySelector('button') as HTMLButtonElement;
		expect(button.textContent).toBe('add');
		await fireEvent.click(button);

		await vi.waitFor(() =>
			expect(vi.mocked(invoke)).toHaveBeenCalledWith('settings_set_agent', {
				key: 'cursor',
				launch: { label: 'Cursor CLI', command: 'agent acp' }
			})
		);
		await vi.waitFor(() => expect(storedAgents.cursor?.command).toBe('agent acp'));
	});

	it('falls back to the hand flow alone when the roster cannot be read', async () => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === 'settings_get') {
				return Promise.resolve({ workingDir: '/w', temperContext: 'c', agents: storedAgents });
			}
			if (cmd === 'roster_get') return Promise.reject(new Error('no roster'));
			return Promise.resolve(null);
		}) as never);
		const { container } = render(Page);
		await vi.waitFor(() => {
			expect(container.querySelector('.roster')).toBeNull();
			expect(container.textContent).toContain('could not be read');
		});
		// The hand form is still there.
		await vi.waitFor(() => expect(container.querySelector('.agent-form')).not.toBeNull());
	});
});
