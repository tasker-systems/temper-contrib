import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Transcript, { type ChatMessage } from './Transcript.svelte';

/**
 * The transcript witness's fixture half (rendering-baseline design): an agent reply carrying a
 * heading, a fenced block and a link renders formatted, not literal. What the person typed stays
 * the literal text they typed, and a tool-call entry stays one line with its status.
 *
 * The live-agent half needs the running app: `npm run tauri dev`, start a conversation with
 * any ACP agent, and ask it to "reply with a level-2 heading, a fenced rust block, and a link".
 * The reply renders as a heading, a highlighted code block and a link — no `##` or backticks.
 */
const REPLY = '## Plan\n\n```rust\nfn main() {}\n```\n\nSee [temper](https://temperkb.io).';

const messages: ChatMessage[] = [
	{ role: 'user', text: '## not a heading, just what I typed' },
	{ role: 'assistant', text: REPLY },
	{ role: 'system', text: 'Read file', toolCallId: 't1', status: 'completed' }
];

describe('Transcript', () => {
	it('renders an agent reply formatted, not literal', async () => {
		const { container } = render(Transcript, { props: { messages } });
		const reply = () => container.querySelector('.assistant .md-body');
		await waitFor(() => expect(reply()).not.toBeNull());
		expect(reply()?.querySelector('h2')?.textContent).toBe('Plan');
		expect(reply()?.querySelector('pre code.hljs.language-rust .hljs-keyword')?.textContent).toBe('fn');
		expect(reply()?.querySelector('a')?.getAttribute('href')).toBe('https://temperkb.io');
		expect(reply()?.textContent).not.toContain('##');
		expect(reply()?.textContent).not.toContain('```');
	});

	it("keeps the person's own words literal", () => {
		const { container } = render(Transcript, { props: { messages } });
		const user = container.querySelector('.user');
		expect(user?.textContent?.trim()).toBe('## not a heading, just what I typed');
		expect(user?.querySelector('h2')).toBeNull();
	});

	it('keeps a tool call to one line carrying its status', () => {
		const { container } = render(Transcript, { props: { messages } });
		expect(container.querySelector('.system')?.textContent?.trim()).toBe('Read file · completed');
	});

	it('says who is responding while a prompt is in flight', () => {
		const { getByRole } = render(Transcript, { props: { messages: [], pending: 'opencode' } });
		expect(getByRole('status').textContent).toContain('opencode is responding');
	});
});
