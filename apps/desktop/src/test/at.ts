/**
 * Indexed reads for tests under `noUncheckedIndexedAccess`: the value a test arranged to be
 * there, or an Error naming what was missing, so a broken fixture fails where it is read.
 */

/** The element at `index`, or an Error when the list holds none there. */
export function at<T>(list: ArrayLike<T>, index: number): T {
	const item = list[index];
	if (item === undefined) throw new Error(`expected an element at index ${index}, found none`);
	return item;
}

/** The value, or an Error naming what was expected when it is absent. */
export function defined<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`expected ${what}, found none`);
	return value;
}
