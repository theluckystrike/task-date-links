// Pure helpers that turn the settings into link options, and small date and folder helpers. No Obsidian import: the date
// formatter is passed in (the plugin gives it the moment of Obsidian), so tests can use a small stand-in.
import type { LinkText } from './links';

/** Formats an ISO date (YYYY-MM-DD) with a moment format. Returns '' for a date that does not exist. */
export type FormatFn = (iso: string, format: string) => string;

export interface LinkConfig {
	/** Folder of the daily notes, relative to the vault root. */
	dailyFolder?: string;
	/** Moment format of the daily note name. */
	format: string;
	/** Moment format of the link text after the pipe. Empty shows the date without the daily folder. */
	alias: string;
	weekly: boolean;
	weeklyFormat: string;
	monthly: boolean;
	monthlyFormat: string;
}

export const FALLBACK_FORMAT = 'YYYY-MM-DD';
export const DEFAULT_WEEKLY = 'gggg-[W]ww';
export const DEFAULT_MONTHLY = 'YYYY-MM';

/** The note property that keeps one note out of the plugin. */
export const PROPERTY = 'task-date-links';

/**
 * True when the front matter of a note opts the note out. Only the boolean `false` does that (`task-date-links: false`, or a
 * checkbox property that is off). The text "false" in quotes, `no`, 0, an empty value, `true` and a missing property do not.
 * The link on completion and every back-fill ask this one function, so the two paths read the property in the same way.
 */
export function optedOut(frontmatter: Readonly<Record<string, unknown>> | null | undefined): boolean {
	return frontmatter?.[PROPERTY] === false;
}

/** Characters that would break a wikilink or turn it into a heading or block link. */
const UNSAFE = /[[\]|#^\\\r\n]/u;

/** True when a formatted note name can sit inside [[ ]] as it is. */
export function safeTarget(name: string): boolean {
	return name.trim() !== '' && !UNSAFE.test(name);
}

/** A folder must not contain link delimiters or relative path segments. Empty means the vault root. */
export function safeFolder(folder: string): boolean {
	return !UNSAFE.test(folder) && !folder.split('/').some((part) => part === '.' || part === '..');
}

function oneLink(fmt: FormatFn, iso: string, format: string, alias: string, folder = ''): LinkText | null {
	const name = fmt(iso, format);
	const dateName = safeTarget(name) ? name : fmt(iso, FALLBACK_FORMAT);
	if (!safeTarget(dateName)) return null;
	const prefix = safeFolder(folder) ? folder.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/') : '';
	const target = prefix ? `${prefix}/${dateName}` : dateName;
	const label = alias.trim() === '' ? (prefix ? dateName : '') : fmt(iso, alias);
	const shown = label.replace(/[\]|\r\n[#^]/g, ' ').trim();
	const text = shown !== '' && shown !== target ? `[[${target}|${shown}]]` : `[[${target}]]`;
	return prefix ? { target, text, same: [dateName] } : { target, text };
}

/** The links for one date: the daily note, then the weekly and monthly note when those are on. */
export function buildLinksFor(fmt: FormatFn, cfg: LinkConfig): (iso: string) => LinkText[] {
	return (iso) => {
		const out: LinkText[] = [];
		const daily = oneLink(fmt, iso, cfg.format, cfg.alias, cfg.dailyFolder);
		if (daily) out.push(daily);
		if (cfg.weekly) {
			const w = oneLink(fmt, iso, cfg.weeklyFormat || DEFAULT_WEEKLY, '');
			if (w && !out.some((o) => o.target === w.target)) out.push(w);
		}
		if (cfg.monthly) {
			const m = oneLink(fmt, iso, cfg.monthlyFormat || DEFAULT_MONTHLY, '');
			if (m && !out.some((o) => o.target === m.target)) out.push(m);
		}
		return out;
	};
}

/** The date n days after an ISO date (n may be negative). */
export function addDays(iso: string, n: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

/** The done dates that count as "just finished": from `days` days before today up to today. */
export function recentWindow(today: string, days: number): { from: string; to: string } {
	return { from: addDays(today, -Math.max(0, Math.floor(days))), to: today };
}

/** One folder per line. Trims, drops empty lines and the slash at the end. */
export function splitFolders(text: string): string[] {
	return text
		.split('\n')
		.map((l) => l.trim().replace(/\/+$/, ''))
		.filter((l) => l !== '');
}

const inFolder = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

/** Folder rules: a note is used when it is in one of `only` (or `only` is empty) and in none of `ignore`. */
export function folderAllowed(path: string, only: readonly string[], ignore: readonly string[]): boolean {
	if (ignore.some((f) => inFolder(path, f))) return false;
	return only.length === 0 || only.some((f) => inFolder(path, f));
}
