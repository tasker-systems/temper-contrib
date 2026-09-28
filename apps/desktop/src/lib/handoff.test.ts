import { describe, expect, it } from 'vitest';
import {
	type HandoffMaterial,
	handoffPrompt,
	type Intent,
	intentStated,
	intentWords,
	ONE_CLICK_WORDS,
	proposalFrom,
	trailSince
} from './handoff';

const MATERIAL: HandoffMaterial = {
	title: 'Build the document room',
	base: '# Scope\n\nThe room, read-only.',
	draft: '# Scope\n\nThe room, read-only.\n\nAnd edited.',
	newer: '# Scope\n\nSomeone else was here.'
};

const TRAIL = '- 2026-09-28T10:00 someone-else wrote the body';

describe('the handoff prompt', () => {
	it('carries the intent as words: the one-click phrase, then the free text', () => {
		const text = handoffPrompt(
			{ freeText: 'prefer the smaller section', oneClick: 'fold' },
			MATERIAL,
			TRAIL
		);
		expect(text).toContain(ONE_CLICK_WORDS.fold);
		expect(text).toContain('prefer the smaller section');
	});

	it('carries the three versions as fenced markdown sections, labelled', () => {
		const text = handoffPrompt({ freeText: '', oneClick: 'keep' }, MATERIAL, TRAIL);
		expect(text).toContain('### What I had written (my draft)');
		expect(text).toContain('### What the document reads now (the newer version)');
		expect(text).toContain('### What the document read when I opened it (the base)');
		// The bodies ride inside their fences, byte-exact.
		expect(text).toContain('```markdown\n# Scope\n\nThe room, read-only.\n\nAnd edited.\n```');
		expect(text).toContain('```markdown\n# Scope\n\nSomeone else was here.\n```');
	});

	it('names the proposal fence the return path will parse', () => {
		const text = handoffPrompt({ freeText: '', oneClick: null }, MATERIAL, TRAIL);
		expect(text).toContain('```proposal');
	});

	it('carries the trail since the base when one is given, and omits the section when not', () => {
		const withTrail = handoffPrompt({ freeText: '', oneClick: null }, MATERIAL, TRAIL);
		expect(withTrail).toContain('What happened to it since I opened it:');
		expect(withTrail).toContain(TRAIL);
		const without = handoffPrompt({ freeText: '', oneClick: null }, MATERIAL, '');
		expect(without).not.toContain('What happened to it since I opened it:');
	});

	it('a draft identical to the base is said, so the agent need not diff it', () => {
		const text = handoffPrompt(
			{ freeText: 'x', oneClick: null },
			{ ...MATERIAL, draft: MATERIAL.base },
			''
		);
		expect(text).toContain('(My draft is identical to the base.)');
	});

	it('an unstated intent is said as none, never an invented one', () => {
		const text = handoffPrompt({ freeText: '', oneClick: null }, MATERIAL, '');
		expect(text).toContain('Intent: (none stated');
	});

	it('the prompt carries the document title', () => {
		const text = handoffPrompt({ freeText: '', oneClick: null }, MATERIAL, '');
		expect(text).toContain('"Build the document room"');
	});
});

describe('the intent', () => {
	it('is stated when free text or a one-click is present, and not otherwise', () => {
		expect(intentStated({ freeText: '  ', oneClick: null })).toBe(false);
		expect(intentStated({ freeText: 'prefer mine', oneClick: null })).toBe(true);
		expect(intentStated({ freeText: '', oneClick: 'fold' })).toBe(true);
	});

	it('reads as words: free text alone, one-click alone, or both joined', () => {
		expect(intentWords({ freeText: '', oneClick: null })).toBe('');
		expect(intentWords({ freeText: 'prefer mine', oneClick: null })).toBe('prefer mine');
		expect(intentWords({ freeText: '', oneClick: 'keep' })).toBe(ONE_CLICK_WORDS.keep);
		expect(intentWords({ freeText: 'prefer mine', oneClick: 'keep' })).toBe(
			`${ONE_CLICK_WORDS.keep} — prefer mine`
		);
	});
});

describe('the trail since the base', () => {
	const HISTORY = {
		total: 3,
		omitted: 0,
		runs: [
			{
				actorName: 'someone-else',
				acts: 1,
				firstAt: '2026-09-28T10:00:00+00:00',
				lastAt: '2026-09-28T10:00:00+00:00',
				events: [
					{
						eventId: 'e2',
						kind: 'resource_reblocked',
						occurredAt: '2026-09-28T10:00:00+00:00'
					}
				]
			},
			{
				actorName: 'the person',
				acts: 1,
				firstAt: '2026-09-27T09:00:00+00:00',
				lastAt: '2026-09-27T09:00:00+00:00',
				events: [
					{
						eventId: 'e1',
						kind: 'resource_created',
						occurredAt: '2026-09-27T09:00:00+00:00'
					}
				]
			}
		]
	};
	const BASE_AT = '2026-09-27T12:00:00+00:00';

	it("carries the events after the base and drops the base's own history", () => {
		const { lines, omitted } = trailSince(HISTORY, BASE_AT);
		expect(lines).toBe('- 2026-09-28T10:00:00+00:00 someone-else resource_reblocked');
		expect(omitted).toBe(1);
	});

	it('is empty when nothing moved after the base', () => {
		const { lines, omitted } = trailSince(HISTORY, '2026-09-29T00:00:00+00:00');
		expect(lines).toBe('');
		expect(omitted).toBe(2);
	});

	it('names what it omits past its bound', () => {
		const many = {
			...HISTORY,
			runs: Array.from({ length: 5 }, (_, i) => ({
				actorName: `actor-${i}`,
				acts: 1,
				firstAt: `2026-09-28T1${i}:00:00+00:00`,
				lastAt: `2026-09-28T1${i}:00:00+00:00`,
				events: [
					{
						eventId: `e${i}`,
						kind: 'resource_reblocked',
						occurredAt: `2026-09-28T1${i}:00:00+00:00`
					}
				]
			}))
		};
		const { lines, omitted } = trailSince(many, BASE_AT, 3);
		expect(lines.split('\n')).toHaveLength(3);
		expect(omitted).toBe(2);
	});
});

describe('the proposal from a turn', () => {
	const intent: Intent = { freeText: '', oneClick: null };

	it('is the text between the proposal fence and its closing fence, exactly', () => {
		const turn = `thinking about it.\n\`\`\`proposal\n# Scope\n\nReconciled.\n\`\`\`\nthat is my suggestion.`;
		expect(proposalFrom(turn)).toBe('# Scope\n\nReconciled.');
		// The prompt the turn answers is what asked for the fence — round-trip.
		expect(handoffPrompt(intent, MATERIAL, TRAIL)).toContain('```proposal');
	});

	it('takes the LAST proposal fence: the agent may reason in fenced examples first', () => {
		const turn =
			'seen this pattern:\n```markdown\nexample\n```\nso:\n```proposal\nfirst\n```\nno wait:\n```proposal\nfinal\n```\ndone.';
		expect(proposalFrom(turn)).toBe('final');
	});

	it('a turn with no proposal fence is null — the caller says so, never a guess', () => {
		expect(proposalFrom('I would suggest a merge, but nothing fenced.')).toBeNull();
		expect(proposalFrom('```markdown\njust a code block, not a proposal\n```')).toBeNull();
	});

	it('an unterminated fence is null, never a prefix of the reply', () => {
		expect(proposalFrom('```proposal\nstarted but never closed')).toBeNull();
	});
});
