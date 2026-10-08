/**
 * Colour by binding: what each doc type's marks paint with. The contract owns slots;
 * vocabularies own the bindings to them. Core's default binding is the base of the
 * merge, and each enabled contribution's vocabulary entries follow in registration
 * order — a plugin's entry for a doc type wins the base's, the same rule the create
 * menu runs. A doc type bound nowhere renders in the neutral role.
 */
import type { Contribution, DocTypeTint, SlotTint } from '../lenses';
import { CORE_DOC_TYPE_BINDINGS } from './core';

/** One vocabulary's bindings, as the core's resolve call receives them: the merge is
 * the resolver's to run, and the vocabulary's id is what a channel collision names. */
export interface VocabularyBindings {
	id: string;
	doctypes: Record<string, SlotTint>;
}

/** Every binding in force, core's default first. A contribution may carry several
 * vocabularies; only entries with an opinion on colour bind anything. */
export function boundVocabularies(enabled: readonly Contribution[]): VocabularyBindings[] {
	const bindings: VocabularyBindings[] = [{ id: 'core', doctypes: CORE_DOC_TYPE_BINDINGS }];
	for (const contribution of enabled) {
		for (const vocabulary of contribution.vocabularies) {
			const doctypes: Record<string, SlotTint> = {};
			for (const { doctype, tint } of vocabulary.doctypes) {
				if (tint) doctypes[doctype] = tint;
			}
			if (Object.keys(doctypes).length > 0) bindings.push({ id: contribution.plugin, doctypes });
		}
	}
	return bindings;
}

/** What one doc type paints with: its bound slot, or the neutral role. */
export function docTypeTint(enabled: readonly Contribution[], docType: string): DocTypeTint {
	for (const { doctypes } of [...boundVocabularies(enabled)].reverse()) {
		const tint = doctypes[docType];
		if (tint) return tint;
	}
	return 'cat-neutral';
}
