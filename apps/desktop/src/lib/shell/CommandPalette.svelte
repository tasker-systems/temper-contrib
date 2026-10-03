<script lang="ts">
	/**
	 * The command palette: ⌘K / Ctrl-K, or the masthead's trigger. Escape or a click outside
	 * closes it. It filters, locally, what the desktop already holds — it does not search temper,
	 * and says so. Opening something focuses a tab already showing it before opening a new one.
	 */
	import { agentSession } from '$lib/agent/session.svelte';
	import { temperViews } from '$lib/temper-views.svelte';
	import { enabled } from './contributions';
	import { lensesFor } from './lenses';
	import { type Command, filterSections, lensWords, type Section, SECTION_BOUND } from './palette';
	import { shellPanels } from './panels.svelte';
	import { contextHref, subjectFromAddress } from './subjects';
	import { HOME_TAB, stepTitle, tabs } from './tabs.svelte';

	let filter = $state('');
	let selected = $state(0);
	let input: HTMLInputElement | undefined = $state();

	$effect(() => {
		input?.focus();
	});

	const close = () => shellPanels.setPaletteOpen(false);
	const run = (command: Command) => {
		close();
		command.run();
	};

	const sections = $derived.by((): Section[] => {
		const open: Command[] = tabs.tabs.map((tab) => ({
			id: `tab:${tab.id}`,
			label: stepTitle(tabs.current(tab)),
			from: tab.id === HOME_TAB ? 'home tab' : 'open tab',
			run: () => tabs.activate(tab.id)
		}));
		const aside: Command[] = tabs.setAside.map((tab) => ({
			id: `aside:${tab.id}`,
			label: stepTitle(tabs.current(tab)),
			from: 'set aside',
			run: () => tabs.reopen(tab.id)
		}));
		const seen = new Set<string>();
		const resourceCommand = (id: string, title: string, from: string): Command | null => {
			if (seen.has(id)) return null;
			seen.add(id);
			return {
				id: `resource:${id}`,
				label: title,
				from,
				run: () => tabs.focusOrOpen({ kind: 'resource', id })
			};
		};
		const held: Command[] = [];
		for (const row of temperViews.recent?.rows ?? []) {
			const c = resourceCommand(row.id, row.title, `recent ${row.docType}`);
			if (c) held.push(c);
		}
		for (const group of enabled) {
			for (const way of group.waysIn) {
				if (way.source !== 'list') continue;
				for (const row of temperViews.list(`${group.plugin}/${way.id}`).page?.rows ?? []) {
					const c = resourceCommand(row.id, row.title, `${way.label} · ${group.plugin}`);
					if (c) held.push(c);
				}
			}
		}
		const contexts: Command[] = (temperViews.contexts ?? []).map((context) => {
			const ref = `${context.ownerRef}/${context.slug}`;
			const url = new URL(contextHref(ref), 'http://palette.local');
			const subject = subjectFromAddress(url.pathname, url.searchParams);
			return {
				id: `context:${context.id}`,
				label: ref,
				from: 'context',
				run: () => subject && tabs.focusOrOpen(subject)
			};
		});

		const active = tabs.active;
		const step = tabs.current(active);
		// A create happens in a context: the command is offered only where the room in view
		// names one — a query over a context — and is absent, never disabled-grey, elsewhere.
		const context = step.subject.kind === 'query' ? step.subject.context : undefined;
		const lenses: Command[] = lensesFor(step.subject, step.docType, enabled)
			.filter((lens) => lens.id !== step.lens)
			.map((lens) => ({
				id: `lens:${lens.id}`,
				label: `See ${stepTitle(step)} through the ${lens.name} lens`,
				from: lensWords(lens),
				run: () => tabs.setLens(active.id, lens.id)
			}));

		const actions: Command[] = [
			{
				id: 'session',
				label: agentSession.conversation ? 'Show the session' : 'Start a session with an agent',
				from: 'agent',
				run: () => agentSession.setPanelOpen(true)
			},
			{
				id: 'settings',
				label: 'Open settings',
				from: 'core',
				run: () => tabs.focusOrOpen({ kind: 'place', place: 'settings' })
			},
			{
				id: 'setup',
				label: 'Open app setup',
				from: 'core',
				run: () => tabs.focusOrOpen({ kind: 'place', place: 'setup' })
			},
			{
				id: 'catalog',
				label: 'Open the view catalog',
				from: 'core',
				run: () => tabs.focusOrOpen({ kind: 'place', place: 'catalog' })
			},
			...(context
				? [
						{
							id: 'new-resource',
							label: 'New resource here',
							from: 'core',
							run: () =>
								tabs.open({ kind: 'place', place: 'new-resource', context }, { where: 'here' })
						}
					]
				: [])
		];

		return [
			{ title: 'Tabs', commands: [...open, ...aside] },
			{ title: 'Switch lens', commands: lenses },
			{ title: 'Open', commands: held },
			{ title: 'Contexts', commands: contexts },
			{ title: 'Do', commands: actions }
		];
	});

	const shown = $derived(filterSections(sections, filter));
	const flat = $derived(shown.flatMap((s) => s.shown));

	$effect(() => {
		// A new filter starts the selection over.
		void filter;
		selected = 0;
	});

	function onkeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			selected = flat.length ? (selected + 1) % flat.length : 0;
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selected = flat.length ? (selected - 1 + flat.length) % flat.length : 0;
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const command = flat[selected];
			if (command) run(command);
		}
	}
</script>

<div
	class="backdrop"
	role="presentation"
	onpointerdown={(event) => {
		if (event.target === event.currentTarget) close();
	}}
>
	<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
		<div class="field">
			<input
				bind:this={input}
				bind:value={filter}
				{onkeydown}
				placeholder="Open, switch lens, or run a command…"
				aria-label="Filter commands"
				aria-controls="palette-commands"
			/>
			<button class="esc" aria-label="Close the command palette" onclick={close}>esc</button>
		</div>
		<p class="note">
			Filters what the desktop already holds — searching temper is the search lens, not built yet.
		</p>
		<div class="sections" id="palette-commands" role="listbox" aria-label="Commands">
			{#each shown as section (section.title)}
				<div class="section" role="group" aria-label={section.title}>
					<p class="t-label">{section.title}</p>
					{#each section.shown as command (command.id)}
						{@const index = flat.indexOf(command)}
						<button
							class="command"
							role="option"
							aria-selected={index === selected}
							onpointerenter={() => (selected = index)}
							onclick={() => run(command)}
						>
							<span class="label">{command.label}</span>
							<span class="from">{command.from}</span>
						</button>
					{/each}
					{#if section.omitted}
						<p class="omits">
							{section.shown.length} of {section.commands.length} shown; {section.omitted} more —
							narrow the filter to see them.
						</p>
					{/if}
				</div>
			{:else}
				<p class="omits">Nothing the desktop holds matches “{filter}”.</p>
			{/each}
		</div>
		<p class="foot">
			{SECTION_BOUND} per section at most · ↑↓ to choose · enter to run · esc to close
		</p>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding-top: 12vh;
		background: var(--tp-overlay);
	}
	.palette {
		display: flex;
		flex-direction: column;
		width: min(36rem, calc(100vw - 2rem));
		max-height: 70vh;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface-raised);
	}
	.field {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.7rem 0.9rem;
		border-bottom: 1px solid var(--tp-rule);
	}
	input {
		flex: 1;
		min-width: 0;
		padding: 0;
		border: 0;
		background: none;
		font: 0.95rem var(--tp-font-ui);
		color: var(--tp-text);
	}
	input:focus {
		outline: none;
	}
	.esc {
		padding: 0;
		border: 0;
		background: none;
		font: 0.7rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
		cursor: pointer;
	}
	.note {
		margin: 0;
		padding: 0.45rem 0.9rem;
		border-bottom: 1px solid var(--tp-rule);
		font: italic 0.78rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
	.sections {
		overflow-y: auto;
		padding: 0.4rem 0.4rem 0.6rem;
	}
	.section {
		display: grid;
		gap: 0.1rem;
		padding-top: 0.5rem;
	}
	.section .t-label {
		margin: 0 0 0.2rem 0.5rem;
	}
	.command {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.8rem;
		padding: 0.4rem 0.5rem;
		border: 0;
		border-radius: var(--tp-radius-chip);
		background: none;
		text-align: left;
		cursor: pointer;
	}
	.command[aria-selected='true'] {
		background: var(--tp-accent-wash);
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 0.85rem var(--tp-font-ui);
		color: var(--tp-text);
	}
	.from {
		flex: none;
		font: 0.6rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	.omits {
		margin: 0.2rem 0.5rem 0;
		font: italic 0.78rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
	.foot {
		margin: 0;
		padding: 0.45rem 0.9rem;
		border-top: 1px solid var(--tp-rule);
		font: 0.6rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
</style>
