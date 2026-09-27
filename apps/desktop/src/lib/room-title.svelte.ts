/**
 * A room's resolved title, for rooms whose title is only known after a read. A route's load
 * declares what it knows at once (the document room declares `document`); once the room has read
 * what temper calls the thing, it names it here and the frame shows that instead. Keyed by path,
 * so a title never outlives the room that read it, and cleared when the room closes.
 */
const titles = $state<Record<string, string>>({});

export const roomTitles = {
	get(path: string): string | undefined {
		return titles[path];
	},
	set(path: string, title: string): void {
		titles[path] = title;
	},
	clear(path: string): void {
		delete titles[path];
	}
};
