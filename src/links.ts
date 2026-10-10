// Pure logic for Task Date Links: no Obsidian import, so every function runs in tests and golden vectors.
//
// A task line is read the way the Tasks plugin reads it (DefaultTaskSerializer): the block link ("^abc") comes off the end
// first, then fields are taken off the end one by one, in any order, up to 20 times. What is left is the description.
// The new links go at the end of the description, before the first field, so Tasks still finds every field at the end
// of the line. A line, a code fence, a front matter block or a line ending is never changed except by that insert.

export type Kind = 'created' | 'start' | 'scheduled' | 'due' | 'done';
/** Order in which the links of one task are written. */
export const KINDS: readonly Kind[] = ['created', 'start', 'scheduled', 'due', 'done'];

/** A link to write: `target` is the note name the link points to, `text` is the whole link as written. */
export interface LinkText {
	target: string;
	text: string;
}

export interface LinkOptions {
	/** Which dates of a finished task get a link. A task is only linked when it has a done date. */
	kinds: readonly Kind[];
	/** The links for one date, such as the daily, weekly and monthly note. */
	linksFor: (iso: string) => LinkText[];
	/** Only done dates inside this range (inclusive, as YYYY-MM-DD text) are linked. null means every done date. */
	window: { from: string; to: string } | null;
}

export interface Change {
	/** Zero-based line number. */
	line: number;
	before: string;
	after: string;
}

export interface LinkResult {
	text: string;
	changes: Change[];
}

export interface ParsedTask {
	/** The line up to and including the space after the checkbox. */
	prefix: string;
	status: string;
	/** The description: the text before the first trailing field, without trailing space. */
	description: string;
	/** Index in the line where the description ends. */
	descEnd: number;
	dates: Partial<Record<Kind, string>>;
}

const TASK_RE = /^([\s>]*(?:[-*+]|\d+[.)]) +\[(.)\] +)(.*)$/u;
const BLOCK_RE = / \^[A-Za-z0-9-]+$/u;
const MAX_FIELDS = 20;

const DATE = String.raw`(\d{4}-\d{2}-\d{2})`;
/** Trailing field patterns of the Tasks emoji format and of its Dataview format. Date fields name their kind. */
const FIELDS: { kind: Kind | 'cancelled' | null; re: RegExp }[] = [
	{ kind: null, re: /[🔺⏫🔼🔽⏬]️?$/u },
	{ kind: null, re: /🔁️? ?[a-zA-Z0-9, !]+$/iu },
	{ kind: null, re: /🏁️? ?[a-zA-Z]+$/u },
	{ kind: null, re: /⛔️? *[a-zA-Z0-9_-]+( *, *[a-zA-Z0-9_-]+)*$/u },
	{ kind: null, re: /🆔️? *[a-zA-Z0-9_-]+$/u },
	{ kind: 'created', re: new RegExp(String.raw`➕️? *${DATE}$`, 'u') },
	{ kind: 'start', re: new RegExp(String.raw`🛫️? *${DATE}$`, 'u') },
	{ kind: 'scheduled', re: new RegExp(String.raw`[⏳⌛]️? *${DATE}$`, 'u') },
	{ kind: 'due', re: new RegExp(String.raw`[📅📆🗓]️? *${DATE}$`, 'u') },
	{ kind: 'done', re: new RegExp(String.raw`✅️? *${DATE}$`, 'u') },
	{ kind: 'cancelled', re: new RegExp(String.raw`❌️? *${DATE}$`, 'u') },
	{ kind: null, re: /[[(](?:priority|repeat|id|dependsOn|onCompletion):: *[^\])]*[\])]$/u },
	{ kind: 'created', re: new RegExp(String.raw`[[(]created:: *${DATE}[\])]$`, 'u') },
	{ kind: 'start', re: new RegExp(String.raw`[[(]start:: *${DATE}[\])]$`, 'u') },
	{ kind: 'scheduled', re: new RegExp(String.raw`[[(]scheduled:: *${DATE}[\])]$`, 'u') },
	{ kind: 'due', re: new RegExp(String.raw`[[(]due:: *${DATE}[\])]$`, 'u') },
	{ kind: 'done', re: new RegExp(String.raw`[[(]completion:: *${DATE}[\])]$`, 'u') },
	{ kind: 'cancelled', re: new RegExp(String.raw`[[(]cancelled:: *${DATE}[\])]$`, 'u') },
];

/** Reads one task line. Returns null for a line that is not a task or has no description. */
export function parseTask(line: string): ParsedTask | null {
	const m = TASK_RE.exec(line);
	if (!m) return null;
	const prefix = m[1] ?? '';
	let s = (m[3] ?? '').trimEnd();
	const block = BLOCK_RE.exec(s);
	if (block) s = s.slice(0, block.index).trimEnd();
	const dates: Partial<Record<Kind, string>> = {};
	for (let run = 0; run < MAX_FIELDS; run++) {
		const hit = matchField(s);
		if (!hit) break;
		if (hit.kind !== null && hit.kind !== 'cancelled' && dates[hit.kind] === undefined) dates[hit.kind] = hit.iso;
		s = s.slice(0, hit.index).trimEnd();
	}
	if (s === '') return null;
	return { prefix, status: m[2] ?? ' ', description: s, descEnd: prefix.length + s.length, dates };
}

function matchField(s: string): { kind: Kind | 'cancelled' | null; iso: string; index: number } | null {
	for (const f of FIELDS) {
		const m = f.re.exec(s);
		if (m) return { kind: f.kind, iso: f.kind === null ? '' : (m[1] ?? ''), index: m.index };
	}
	return null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the text holds a wikilink to the target, with or without an alias, heading or block part. Not case sensitive. */
export function hasLink(text: string, target: string): boolean {
	return new RegExp(String.raw`\[\[${escapeRe(target)}(?:[|#^][^\]]*)?\]\]`, 'iu').test(text);
}

/** The text without the links to the target, and without the one space before each. */
export function removeLink(text: string, target: string): string {
	return text.replace(new RegExp(String.raw` ?\[\[${escapeRe(target)}(?:[|#^][^\]]*)?\]\]`, 'giu'), '');
}

/** The links a finished task still needs: the ones for its dates that its description does not link yet. */
export function linksToAddFor(t: ParsedTask, opts: LinkOptions): LinkText[] {
	const done = t.dates.done;
	if (t.status === ' ' || done === undefined) return [];
	if (opts.window && (done < opts.window.from || done > opts.window.to)) return [];
	const out: LinkText[] = [];
	for (const kind of KINDS) {
		const iso = t.dates[kind];
		if (iso === undefined || !opts.kinds.includes(kind)) continue;
		for (const link of opts.linksFor(iso)) {
			const have = hasLink(t.description, link.target) || out.some((o) => o.target.toLowerCase() === link.target.toLowerCase());
			if (!have) out.push(link);
		}
	}
	return out;
}

/** The line with the links added before the fields, or null when the line needs none. */
export function linkLine(line: string, opts: LinkOptions): string | null {
	const t = parseTask(line);
	if (!t) return null;
	const add = linksToAddFor(t, opts);
	if (add.length === 0) return null;
	return `${line.slice(0, t.descEnd)} ${add.map((a) => a.text).join(' ')}${line.slice(t.descEnd)}`;
}

/** A line range [from, to] (zero-based, inclusive). */
export interface LineRange {
	from: number;
	to: number;
}

/** Marks the lines of a note that may hold tasks: not front matter, not fenced code. */
export function taskableLines(lines: readonly string[]): boolean[] {
	const ok: boolean[] = [];
	let fence = '';
	let front = lines[0]?.trimEnd() === '---';
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? '').trimEnd();
		if (front) {
			ok.push(false);
			if (i > 0 && (line === '---' || line === '...')) front = false;
			continue;
		}
		const f = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
		if (fence === '' && f) {
			fence = f[1] ?? '';
			ok.push(false);
		} else if (fence !== '' && f && (f[1] ?? '').startsWith(fence.charAt(0)) && (f[1] ?? '').length >= fence.length && line.trim() === (f[1] ?? '')) {
			fence = '';
			ok.push(false);
		} else {
			ok.push(fence === '');
		}
	}
	return ok;
}

/** Links every finished task in the text, or in the line range. Line endings and all other lines stay as they are. */
export function linkText(text: string, opts: LinkOptions, range?: LineRange): LinkResult {
	const lines = text.split('\n');
	const ok = taskableLines(lines);
	const changes: Change[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!ok[i] || (range && (i < range.from || i > range.to))) continue;
		const raw = lines[i] ?? '';
		const cr = raw.endsWith('\r') ? '\r' : '';
		const before = cr ? raw.slice(0, -1) : raw;
		const after = linkLine(before, opts);
		if (after === null) continue;
		lines[i] = after + cr;
		changes.push({ line: i, before: raw, after: after + cr });
	}
	return { text: lines.join('\n'), changes };
}

/** The date a task was finished on, for tests and the preview. */
export function doneDate(line: string): string | null {
	return parseTask(line)?.dates.done ?? null;
}
