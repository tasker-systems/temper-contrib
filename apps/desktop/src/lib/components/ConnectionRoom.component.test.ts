// The connection room's witnesses: a fresh machine is shown the vault path it
// can edit and its apply establishes and names the vault; an existing machine
// enters at sign-in with the pending visible; a refusal renders one line; and
// a sign-in that answers an error is re-asked before anything is called
// failed — the grant can be in custody even then. `invoke` is mocked and
// records every call.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { temperViews } from '$lib/temper-views.svelte';
import Room from './ConnectionRoom.svelte';

type Provider = {
	name: string;
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	audience: string;
	callbackUrl: string;
	scopes: string[];
	desktopClientId: string | null;
};

type Gather = {
	configExists: boolean;
	defaultVaultPath: string | null;
	choice: string | null;
	provider: Provider | null;
	apiUrl: string | null;
	signInRefusal: string | null;
};

const hostedProvider = (desktopClientId: string | null): Provider => ({
	name: 'auth0',
	authorizeUrl: 'https://temperkb.us.auth0.com/authorize',
	tokenUrl: 'https://temperkb.us.auth0.com/oauth/token',
	clientId: 'mWp8znLw2MUJNCiZNl8wwBv6SPJI2mfF',
	audience: 'https://temperkb.io/api',
	callbackUrl: 'https://temperkb.io/api/auth/cli-callback',
	scopes: ['openid', 'profile', 'email', 'offline_access'],
	desktopClientId
});

/** What the machine resolves at mount; each test sets its own. */
let gathered: Gather;
/** What apply answers, when it is called — built from the request, as the core does. */
let applyReply:
	| ((request: Record<string, string>) => Gather & { establishedVaultPath: string | null })
	| null;
let applyFails: string | null;
/** Whether the core holds a live grant; `temper_signin` lands one when set. */
let signedIn: boolean;
let signinRejects: string | null;
/** Whether a rejected sign-in still landed the grant (custody before the failing step). */
let custodyDespiteError: boolean;
/** Gates the sign-in promise, so the pending state can be seen mid-flight. */
let releaseSignin: (() => void) | null = null;

function routeInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
	switch (cmd) {
		case 'temper_connection_gather':
			return Promise.resolve(structuredClone(gathered));
		case 'temper_connection_apply':
			if (applyFails) return Promise.reject(applyFails);
			if (applyReply) {
				const reply = applyReply((args?.request ?? {}) as Record<string, string>);
				gathered = structuredClone(reply);
				return Promise.resolve(structuredClone(reply));
			}
			return Promise.resolve(null);
		case 'temper_signin':
			if (signinRejects) {
				// The core installs the client and lands the grant before the
				// step that fails — custody, then an error. That is the trap
				// this mock models when `custodyDespiteError` is set; a
				// refusal before the browser lands nothing.
				if (custodyDespiteError) signedIn = true;
				return Promise.reject(signinRejects);
			}
			return new Promise((resolve) => {
				releaseSignin = () => {
					signedIn = true;
					resolve(null);
				};
			});
		case 'temper_connection_status':
			return Promise.resolve({ connected: signedIn, error: signedIn ? null : 'no grant held' });
		case 'temper_whoami':
			return Promise.resolve(signedIn ? { display_name: 'Pete Taylor', slug: 'pete' } : null);
		default:
			return Promise.resolve(null);
	}
}

const freshMachine = (): Gather => ({
	configExists: false,
	defaultVaultPath: '/witness/temper-vault',
	choice: null,
	provider: null,
	apiUrl: null,
	signInRefusal: null
});

const hostedMachine = (desktopClientId: string | null): Gather => ({
	configExists: true,
	defaultVaultPath: null,
	choice: 'hosted',
	provider: hostedProvider(desktopClientId),
	apiUrl: 'https://temperkb.io',
	signInRefusal: desktopClientId
		? null
		: 'no desktop client is registered for temperkb.us.auth0.com — set desktop_client_id on the "auth0" provider entry'
});

function tabSpy() {
	return { open: vi.fn(), setTitle: vi.fn(), beforeLeave: vi.fn(() => () => {}) };
}

describe('the connection room', () => {
	beforeEach(() => {
		gathered = freshMachine();
		applyReply = null;
		applyFails = null;
		signedIn = false;
		signinRejects = null;
		custodyDespiteError = false;
		releaseSignin = null;
		temperViews.reset();
		vi.mocked(invoke).mockImplementation(routeInvoke as never);
	});

	it('offers init’s four-way choice by its own words', async () => {
		const { container } = render(Room);
		await vi.waitFor(() =>
			expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(4)
		);
		const words = container.querySelector('[role="radiogroup"]')?.textContent ?? '';
		expect(words).toContain('hosted (temperkb.io cloud sync)');
		expect(words).toContain('self-hosted (your own instance + Auth0 tenant)');
		expect(words).toContain('self-hosted (your own instance + Okta)');
		expect(words).toContain('temper-as (the instance’s own Authorization Server)');
	});

	it('a fresh machine is shown its vault path, editable, and apply establishes and names it', async () => {
		applyReply = (request) => ({
			...hostedMachine('v77CQpR2P5EUNfPAkiPPaHXIQbGG5dsE'),
			configExists: true,
			establishedVaultPath: request.vaultPath ?? '/witness/temper-vault'
		});
		const tab = tabSpy();
		const { container } = render(Room, { props: { tab } });

		// The vault path shown, prefilled with the core's default — editable.
		const vault = (await vi.waitFor(() => {
			const found = [...container.querySelectorAll('input')].find((i) =>
				(i as HTMLInputElement).value.startsWith('/witness/temper-vault')
			);
			expect(found).toBeDefined();
			return found as HTMLInputElement;
		})) as HTMLInputElement;
		await fireEvent.input(vault, { target: { value: '/witness/my-vault' } });

		await fireEvent.click(button(container, 'Apply'));

		await vi.waitFor(() =>
			expect(vi.mocked(invoke)).toHaveBeenCalledWith('temper_connection_apply', {
				request: { choice: 'hosted', vaultPath: '/witness/my-vault' }
			})
		);
		// The reply names what was established.
		await vi.waitFor(() =>
			expect(container.textContent).toContain('established the vault at /witness/my-vault')
		);
		// The chain ran: the establish carried the person into sign-in…
		await vi.waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith('temper_signin'));
		releaseSignin?.();
		// …and then to the person-context setup room, through the one door.
		await vi.waitFor(() =>
			expect(tab.open).toHaveBeenCalledWith({ kind: 'place', place: 'setup' }, 'here')
		);
	});

	it('an existing machine enters at sign-in: no vault field, apply re-applies, sign-in is the person’s own act', async () => {
		gathered = hostedMachine('v77CQpR2P5EUNfPAkiPPaHXIQbGG5dsE');
		applyReply = (request) => ({
			...hostedMachine('v77CQpR2P5EUNfPAkiPPaHXIQbGG5dsE'),
			choice: request.choice,
			defaultVaultPath: null,
			establishedVaultPath: null
		});
		const tab = tabSpy();
		const { container } = render(Room);
		await vi.waitFor(() => expect(container.textContent).toContain('Current connection'));
		expect(container.textContent).toContain('hosted — https://temperkb.io/api');
		// No vault field on an existing machine — the radios are the only inputs.
		expect(
			[...container.querySelectorAll('input')].every(
				(i) => (i as HTMLInputElement).type === 'radio'
			)
		).toBe(true);

		// An edit re-applies the resolved choice without a vault path riding.
		await fireEvent.click(button(container, 'Apply'));
		await vi.waitFor(() =>
			expect(vi.mocked(invoke)).toHaveBeenCalledWith('temper_connection_apply', {
				request: { choice: 'hosted' }
			})
		);
		// No auto sign-in on an edit, and no chain to the setup room.
		expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'temper_signin')).toBe(false);
		expect(tab.open).not.toHaveBeenCalled();

		// The sign-in is pending where the person can see it, and the
		// connection is re-asked when it lands.
		await fireEvent.click(button(container, 'Sign in'));
		await vi.waitFor(() => expect(container.textContent).toContain('Waiting for your browser…'));
		expect(container.textContent).toContain('up to two minutes');
		releaseSignin?.();
		await vi.waitFor(() => expect(temperViews.connected).toBe(true));
		expect(reads('temper_connection_status').length).toBeGreaterThan(0);
		expect(tab.open).not.toHaveBeenCalled();
	});

	it('a refusal renders one line and sign-in stays shut', async () => {
		gathered = hostedMachine(null);
		const { container } = render(Room);
		const lines = await vi.waitFor(() => {
			const found = [...container.querySelectorAll('p[role="alert"]')];
			expect(found).toHaveLength(1);
			return found;
		});
		expect(lines[0].textContent).toContain('no desktop client is registered');
		expect(button(container, 'Sign in').disabled).toBe(true);
	});

	it('a sign-in that answers an error is re-asked: custody landing is never called failed', async () => {
		gathered = hostedMachine('v77CQpR2P5EUNfPAkiPPaHXIQbGG5dsE');
		signinRejects = 'the profile read did not complete';
		custodyDespiteError = true;
		const { container } = render(Room);
		await vi.waitFor(() => expect(container.textContent).toContain('Sign in'));
		await fireEvent.click(button(container, 'Sign in'));

		// The grant landed (the core installed the client) even as the command
		// answered an error — the re-query says connected, and the room does
		// not claim the sign-in failed.
		await vi.waitFor(() => expect(temperViews.connected).toBe(true));
		expect(container.textContent).not.toContain('Not signed in');
		expect(container.textContent).not.toContain('sign-in failed');
	});

	it('a sign-in that refused before the browser renders its one line', async () => {
		gathered = hostedMachine('v77CQpR2P5EUNfPAkiPPaHXIQbGG5dsE');
		signinRejects = 'no temper provider is configured — connect to a server first';
		const { container } = render(Room);
		await vi.waitFor(() => expect(container.textContent).toContain('Sign in'));
		await fireEvent.click(button(container, 'Sign in'));

		await vi.waitFor(() =>
			expect(container.textContent).toContain(
				'Not signed in — temper is unchanged. no temper provider is configured'
			)
		);
		expect(temperViews.connected).toBe(false);
	});

	it('an apply the core refuses renders one line and changes nothing', async () => {
		gathered = freshMachine();
		applyFails = 'a self-hosted connection needs client_id, audience';
		const { container } = render(Room);
		await vi.waitFor(() => expect(container.textContent).toContain('Apply'));
		await fireEvent.click(button(container, 'Apply'));
		await vi.waitFor(() =>
			expect(container.textContent).toContain(
				'Not applied — the connection is unchanged. a self-hosted connection needs client_id'
			)
		);
		expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'temper_signin')).toBe(false);
	});
});

function button(container: HTMLElement, text: string): HTMLButtonElement {
	const found = [...container.querySelectorAll('button')].find((b) =>
		b.textContent?.includes(text)
	);
	if (!found) throw new Error(`no button "${text}"`);
	return found as HTMLButtonElement;
}

function reads(cmd: string) {
	return vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd);
}
