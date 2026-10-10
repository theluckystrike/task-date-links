// What to do after a note changed, on top of links.ts. The plugin keeps one small memo per note: for each finished task it
// has seen, the links it added itself. The memo makes three things possible without any marker in the note text:
//   1. A finished task that is already in the memo is not linked again. A link you delete by hand stays deleted.
//   2. A task that is finished and not in the memo is new, so it gets its links (first sight of a note counts as new).
//   3. A task that is reopened (status " ") loses the links the plugin added to it, and only those.
import { linkLine, linksToAddFor, parseTask, removeLink, taskableLines, type Change, type LinkOptions } from './links';

export interface MemoEntry {
	/** The description of the finished task without the links to its own dates. */
	desc: string;
	/** Link targets that this plugin added to the task. */
	targets: string[];
}

/** Finished tasks of one note, by description and done date. */
export type FileMemo = Map<string, MemoEntry>;

export interface ReconcileOptions extends LinkOptions {
	/** Remove the added links from a task that is reopened. */
	unlink: boolean;
}

export interface ReconcileResult {
	text: string;
	changes: Change[];
	memo: FileMemo;
}

const NUL = '\u0000';
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const WIKI_RE = /\[\[([^\]|#^]+)(?:[|#^][^\]]*)?\]\]/gu;

/** The description of a task without the links to the dates the task itself has. */
function bareDescription(description: string, dates: Record<string, string | undefined>, opts: LinkOptions): string {
	let d = description;
	for (const iso of Object.values(dates)) {
		if (iso === undefined) continue;
		for (const l of opts.linksFor(iso)) d = removeLink(d, l.target);
	}
	return collapse(d);
}

/** Targets of the wikilinks in a text, lower case. */
function wikiTargets(text: string): string[] {
	return [...text.matchAll(WIKI_RE)].map((m) => (m[1] ?? '').trim().toLowerCase());
}

/** The index of a memo by description, and the set of all targets in it. */
function indexMemo(prev: FileMemo | undefined): { byDesc: Map<string, MemoEntry>; all: Set<string> } {
	const byDesc = new Map<string, MemoEntry>();
	const all = new Set<string>();
	for (const e of prev?.values() ?? []) {
		if (e.targets.length === 0) continue;
		const hit = byDesc.get(e.desc);
		byDesc.set(e.desc, hit ? { desc: e.desc, targets: [...new Set([...hit.targets, ...e.targets])] } : e);
		for (const t of e.targets) all.add(t.toLowerCase());
	}
	return { byDesc, all };
}

/** The line of a reopened task without the links the plugin added to it, or null when nothing matches the memo. */
function unlinkLine(line: string, idx: { byDesc: Map<string, MemoEntry>; all: Set<string> }): string | null {
	const t = parseTask(line);
	if (!t || t.status !== ' ') return null;
	const found = wikiTargets(t.description).filter((x) => idx.all.has(x));
	if (found.length === 0) return null;
	let stripped = t.description;
	for (const f of found) stripped = removeLink(stripped, f);
	const entry = idx.byDesc.get(collapse(stripped));
	if (!entry) return null;
	let head = t.description;
	for (const target of entry.targets) head = removeLink(head, target);
	return head === t.description ? null : `${line.slice(0, t.prefix.length)}${head}${line.slice(t.descEnd)}`;
}

/** Handles one finished task line: adds links when it is new, and records it in the memo. */
function seeDone(line: string, prev: FileMemo | undefined, next: FileMemo, opts: LinkOptions): string {
	const t = parseTask(line);
	const done = t?.dates.done;
	if (!t || t.status === ' ' || done === undefined) return line;
	const desc = bareDescription(t.description, t.dates, opts);
	const key = desc + NUL + done;
	const old = prev?.get(key);
	let out = line;
	let targets = old?.targets ?? [];
	if (old === undefined) {
		const add = linksToAddFor(t, opts);
		const linked = add.length > 0 ? linkLine(line, opts) : null;
		if (linked !== null) {
			out = linked;
			targets = add.map((a) => a.target);
		}
	}
	const dup = next.get(key);
	next.set(key, { desc, targets: dup ? [...new Set([...dup.targets, ...targets])] : targets });
	return out;
}

/** Runs the memo rules over a note. `prev` is undefined the first time the note is seen. */
export function reconcile(text: string, prev: FileMemo | undefined, opts: ReconcileOptions): ReconcileResult {
	const lines = text.split('\n');
	const ok = taskableLines(lines);
	const idx = opts.unlink ? indexMemo(prev) : { byDesc: new Map<string, MemoEntry>(), all: new Set<string>() };
	const next: FileMemo = new Map();
	const changes: Change[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!ok[i]) continue;
		const raw = lines[i] ?? '';
		const cr = raw.endsWith('\r') ? '\r' : '';
		const before = cr ? raw.slice(0, -1) : raw;
		const after = idx.all.size > 0 ? (unlinkLine(before, idx) ?? seeDone(before, prev, next, opts)) : seeDone(before, prev, next, opts);
		if (after === before) continue;
		lines[i] = after + cr;
		changes.push({ line: i, before: raw, after: after + cr });
	}
	return { text: lines.join('\n'), changes, memo: next };
}
