import { describe, expect, it } from 'vitest';
import { addDays, buildLinksFor, folderAllowed, recentWindow, safeFolder, safeTarget, splitFolders } from '../src/options';
import { doneDate, hasLink, parseTask, removeLink, taskableLines } from '../src/links';
import { normalizeUndo, undoEdits } from '../src/undo';
import { splitAdded, summarize } from '../src/preview';
import { fmt } from './fmt';

describe('parseTask', () => {
	it('reads the description, the dates and the end of the description', () => {
		const t = parseTask('- [x] Pay rent ⏫ 🔁 every month 📅 2026-10-12 ✅ 2026-10-10 ^id1');
		expect(t?.description).toBe('Pay rent');
		expect(t?.dates).toEqual({ due: '2026-10-12', done: '2026-10-10' });
		expect(t?.descEnd).toBe('- [x] Pay rent'.length);
	});
	it('returns null for a line that is not a task or has no text', () => {
		expect(parseTask('Pay rent')).toBeNull();
		expect(parseTask('- [x]')).toBeNull();
		expect(parseTask('- [x] ✅ 2026-10-10')).toBeNull();
	});
	it('stops after 20 fields so a hostile line cannot loop', () => {
		const line = `- [x] A ${'⏫ '.repeat(40)}✅ 2026-10-10`;
		expect(parseTask(line)?.dates.done).toBe('2026-10-10');
		expect(doneDate(`- [x] A ${'⏫'.repeat(40)} ✅ 2026-10-10`)).toBe('2026-10-10');
	});
});

describe('link helpers', () => {
	it('finds and removes links with aliases and parts', () => {
		expect(hasLink('a [[2026-10-10|x]] b', '2026-10-10')).toBe(true);
		expect(hasLink('a [[2026-10-100]] b', '2026-10-10')).toBe(false);
		expect(removeLink('a [[2026-10-10#h]] b [[2026-10-10]]', '2026-10-10')).toBe('a b');
	});
	it('marks code fences and front matter', () => {
		expect(taskableLines(['---', 'a: 1', '---', 'x', '```', 'y', '```', 'z'])).toEqual([false, false, false, true, false, false, false, true]);
	});
});

describe('options', () => {
	it('safeFolder rejects link delimiters and . or .. segments', () => {
		for (const ok of ['', 'Daily', 'Journal/Daily', 'Journal/2026 notes']) expect(safeFolder(ok)).toBe(true);
		for (const bad of ['.', '..', 'Journal/./Daily', 'Journal/../Daily', 'Daily#Tasks', 'Daily|x', 'Daily^1', 'Dai[ly]']) expect(safeFolder(bad)).toBe(false);
	});
	const cfg = { format: 'YYYY-MM-DD', alias: '', weekly: false, weeklyFormat: '', monthly: false, monthlyFormat: '' };
	it('checks names for links', () => {
		expect(safeTarget('2026-10-10')).toBe(true);
		expect(safeTarget('2026/10/10')).toBe(true);
		for (const bad of ['', ' ', 'a|b', 'a#b', 'a^b', 'a[b', 'a]b', 'a\nb']) expect(safeTarget(bad)).toBe(false);
	});
	it('builds no link for a date that does not exist', () => {
		expect(buildLinksFor(fmt, cfg)('2026-02-30')).toEqual([]);
	});
	it('does not repeat a link when the weekly format gives the daily name', () => {
		const links = buildLinksFor(fmt, { ...cfg, weekly: true, weeklyFormat: 'YYYY-MM-DD' })('2026-10-10');
		expect(links.map((l) => l.text)).toEqual(['[[2026-10-10]]']);
	});
	it('drops an alias that equals the name and cleans a bad alias', () => {
		expect(buildLinksFor(fmt, { ...cfg, alias: 'YYYY-MM-DD' })('2026-10-10')[0]?.text).toBe('[[2026-10-10]]');
		expect(buildLinksFor(fmt, { ...cfg, alias: '[a|b]]' })('2026-10-10')[0]?.text).toBe('[[2026-10-10|a b]]');
	});
	it('adds days across month and year ends', () => {
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(recentWindow('2026-10-10', 1)).toEqual({ from: '2026-10-09', to: '2026-10-10' });
		expect(recentWindow('2026-10-10', -5)).toEqual({ from: '2026-10-10', to: '2026-10-10' });
	});
	it('applies folder rules', () => {
		expect(splitFolders(' Projects/ \n\nArchive\n')).toEqual(['Projects', 'Archive']);
		expect(folderAllowed('Projects/a.md', [], [])).toBe(true);
		expect(folderAllowed('Projects/a.md', ['Projects'], [])).toBe(true);
		expect(folderAllowed('Other/a.md', ['Projects'], [])).toBe(false);
		expect(folderAllowed('Projects/Archive/a.md', ['Projects'], ['Projects/Archive'])).toBe(false);
		expect(folderAllowed('ProjectsX/a.md', ['Projects'], [])).toBe(false);
	});
});

describe('undo', () => {
	it('puts lines back by text, not by number', () => {
		const text = 'new line\n- [x] A [[2026-10-10]] ✅ 2026-10-10\n- [x] B [[2026-10-10]] ✅ 2026-10-10\n';
		const r = undoEdits(text, [
			{ before: '- [x] A ✅ 2026-10-10', after: '- [x] A [[2026-10-10]] ✅ 2026-10-10' },
			{ before: '- [x] B ✅ 2026-10-10', after: '- [x] B [[2026-10-10]] ✅ 2026-10-10' },
			{ before: '- [x] C ✅ 2026-10-10', after: '- [x] C [[2026-10-10]] ✅ 2026-10-10' },
		]);
		expect(r.text).toBe('new line\n- [x] A ✅ 2026-10-10\n- [x] B ✅ 2026-10-10\n');
		expect(r.restored).toBe(2);
		expect(r.skipped).toBe(1);
	});
	it('leaves a line that you edited since', () => {
		const r = undoEdits('- [x] A edited [[2026-10-10]] ✅ 2026-10-10', [{ before: '- [x] A ✅ 2026-10-10', after: '- [x] A [[2026-10-10]] ✅ 2026-10-10' }]);
		expect(r.restored).toBe(0);
		expect(r.text).toBe('- [x] A edited [[2026-10-10]] ✅ 2026-10-10');
	});
	it('uses each edit once for equal lines', () => {
		const e = { before: '- [x] A ✅ 2026-10-10', after: '- [x] A [[2026-10-10]] ✅ 2026-10-10' };
		const r = undoEdits(`${e.after}\n${e.after}`, [e]);
		expect(r.text).toBe(`${e.before}\n${e.after}`);
	});
	it('repairs a bad saved batch', () => {
		expect(normalizeUndo(null)).toBeNull();
		expect(normalizeUndo({ at: 'x', files: [] })).toBeNull();
		expect(normalizeUndo({ at: 1, files: [{ path: 'a.md', edits: [{ before: 'a', after: 'b' }, { before: 1 }, 'x'] }, { path: 5 }, 'x'] })).toEqual({ at: 1, files: [{ path: 'a.md', edits: [{ before: 'a', after: 'b' }] }] });
		expect(normalizeUndo({ at: 1, files: [{ path: 'a.md', edits: [] }] })).toBeNull();
	});
});

describe('preview helpers', () => {
	it('finds the added text', () => {
		expect(splitAdded('- [x] A ✅ 2026-10-10', '- [x] A [[2026-10-10]] ✅ 2026-10-10')).toEqual(['- [x] A ', '[[2026-10-10]] ', '✅ 2026-10-10']);
		expect(splitAdded('same', 'same')).toEqual(['same', '', '']);
	});
	it('says how many tasks and notes', () => {
		const ch = { line: 0, before: 'a', after: 'b' };
		expect(summarize([{ path: 'a.md', changes: [ch] }])).toBe('1 task in 1 note will get a link.');
		expect(summarize([{ path: 'a.md', changes: [ch, ch] }, { path: 'b.md', changes: [ch] }])).toBe('3 tasks in 2 notes will get a link.');
	});
});
