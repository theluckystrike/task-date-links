// The back-fill and the property `task-date-links: false`. The commands run against the in-memory vault of obsidian-test-mocks,
// so each test goes through the same code as a user: the command, the preview window, "Link the dates" and the notice.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Notice, type TFile } from 'obsidian-test-mocks/obsidian';
import TaskDateLinksPlugin from '../src/main';
import { optedOut } from '../src/options';
import { PREVIEW_MAX, PreviewModal, moreText, skippedText } from '../src/preview';
import { bindPro, resetPro } from '../src/pro';
import type { TaskDateLinksSettings } from '../src/settings';
import manifest from '../manifest.json';

const OPT_OUT = '---\ntask-date-links: false\n---\n';
const SKIP_NOTE = 'The property "task-date-links: false" skips this note. Nothing was changed.';
const UNDO_HINT = 'Run "Undo the last back-fill" to undo.';
const skippedOne = 'Skipped 1 note with the property "task-date-links: false".';

interface Rig {
	app: App;
	plugin: TaskDateLinksPlugin;
	notices: string[];
	modals: PreviewModal[];
	file(path: string): TFile;
	read(path: string): Promise<string>;
}

interface Command {
	callback?: () => void;
	checkCallback?: (checking: boolean) => boolean;
	editorCallback?: (editor: unknown, ctx: unknown) => void;
	editorCheckCallback?: (checking: boolean, editor: unknown, ctx: unknown) => boolean;
}

afterEach(() => {
	resetPro();
	vi.restoreAllMocks();
});

/** A loaded plugin on a vault with these notes. Notices and preview windows are recorded and not shown. */
async function rig(files: Record<string, string>, settings: Partial<TaskDateLinksSettings> = {}, pro = false): Promise<Rig> {
	const app = App.createConfigured__({ files });
	const notices: string[] = [];
	const modals: PreviewModal[] = [];
	vi.spyOn(Notice.prototype, 'constructor__').mockImplementation((message) => {
		notices.push(String(message));
	});
	vi.spyOn(PreviewModal.prototype, 'open').mockImplementation(function (this: PreviewModal) {
		modals.push(this);
		this.onOpen();
	});
	const plugin = new TaskDateLinksPlugin(app as never, manifest as never);
	await plugin.onload();
	Object.assign(plugin.settings, settings);
	if (pro) bindPro({ isPro: () => true, onChange: () => () => undefined } as never);
	const file = (path: string): TFile => {
		const f = app.vault.getFileByPath(path);
		if (!f) throw new Error(`no file ${path}`);
		return f;
	};
	return { app, plugin, notices, modals, file, read: (path) => app.vault.read(file(path)) };
}

/** A stand-in for the editor of the open note: the text of the note, and a selection of whole lines when one is given. */
async function editorOf(r: Rig, path: string, lines?: [number, number]) {
	const text = await r.read(path);
	return {
		getValue: () => text,
		somethingSelected: () => lines !== undefined,
		getCursor: (which: string) => ({ line: lines?.[which === 'from' ? 0 : 1] ?? 0, ch: which === 'from' ? 0 : 5 }),
	};
}

/** Runs a command of the plugin and waits until it shows a notice or the preview. */
async function run(r: Rig, id: string, path?: string, lines?: [number, number]): Promise<void> {
	const cmd = (r.plugin as unknown as { commands__: Map<string, Command> }).commands__.get(id);
	if (!cmd) throw new Error(`no command ${id}`);
	const seen = r.notices.length + r.modals.length;
	if (path === undefined) {
		if (cmd.checkCallback) expect(cmd.checkCallback(false)).toBe(true);
		else cmd.callback?.();
	}
	else if (cmd.editorCallback) cmd.editorCallback(await editorOf(r, path, lines), { file: r.file(path) });
	else expect(cmd.editorCheckCallback?.(false, await editorOf(r, path, lines), { file: r.file(path) })).toBe(true);
	await vi.waitFor(() => expect(r.notices.length + r.modals.length).toBeGreaterThan(seen));
}

/** Selects "Link the dates" in the preview. */
async function applyPreview(modal: PreviewModal | undefined): Promise<void> {
	if (!modal) throw new Error('no preview');
	await (modal as unknown as { onApply(): Promise<void> }).onApply();
}

const textOf = (modal: PreviewModal | undefined, cls: string): string | null => modal?.contentEl.querySelector(`.${cls}`)?.textContent ?? null;

describe('optedOut, the one reader of the property', () => {
	it('is true only for the boolean false', () => {
		expect(optedOut({ 'task-date-links': false })).toBe(true);
		for (const value of [true, 'false', 'False', 'no', 0, '', null, undefined, [], [false]]) expect(optedOut({ 'task-date-links': value })).toBe(false);
		expect(optedOut({})).toBe(false);
		expect(optedOut({ other: false })).toBe(false);
		expect(optedOut(undefined)).toBe(false);
		expect(optedOut(null)).toBe(false);
	});
});

describe('back-fill and the property task-date-links: false', () => {
	it('links a folder in the preview, applies it and undoes it without Pro', async () => {
		const before = '- [x] Plan ✅ 2026-09-13\n';
		const r = await rig({ 'Plan.md': before }, { dailyFolder: 'Journal/Daily' });
		await run(r, 'link-done-dates-note', 'Plan.md');
		expect(r.modals[0]?.contentEl.textContent).toContain('[[Journal/Daily/2026-09-13|2026-09-13]]');
		await applyPreview(r.modals[0]);
		expect(await r.read('Plan.md')).toBe('- [x] Plan [[Journal/Daily/2026-09-13|2026-09-13]] ✅ 2026-09-13\n');
		await run(r, 'undo-backfill');
		expect(await r.read('Plan.md')).toBe(before);
	});
	it('the current note alone: an opted-out note gets a clear notice, no preview and no change', async () => {
		const before = `${OPT_OUT}- [x] Private ✅ 2026-09-12\n`;
		const r = await rig({ 'Private.md': before });
		await run(r, 'link-done-dates-note', 'Private.md');
		expect(r.modals).toEqual([]);
		expect(r.notices).toEqual([SKIP_NOTE]);
		expect(await r.read('Private.md')).toBe(before);
		expect(r.plugin.settings.undo).toBeNull();
	});

	it('a selection in an opted-out note changes nothing', async () => {
		const before = `${OPT_OUT}- [x] Private ✅ 2026-09-12\n- [x] Also private ✅ 2026-09-13\n`;
		const r = await rig({ 'Private.md': before });
		await run(r, 'link-done-dates-selection', 'Private.md', [3, 4]);
		expect(r.modals).toEqual([]);
		expect(r.notices).toEqual([SKIP_NOTE]);
		expect(await r.read('Private.md')).toBe(before);
	});

	it('a folder with one opted-out and one normal note: only the normal one changes and the skipped count is 1', async () => {
		const secret = `${OPT_OUT}- [x] Private ✅ 2026-09-12\n`;
		const outside = '- [x] Outside the folder ✅ 2026-09-14\n';
		const r = await rig({ 'Projects/Private.md': secret, 'Projects/Plan.md': '- [x] Plan ✅ 2026-09-13\n', 'Other/Else.md': outside }, { onlyFolders: 'Projects' }, true);
		await run(r, 'link-done-dates-vault');
		expect(textOf(r.modals[0], 'task-date-links-summary')).toBe('1 task in 1 note will get a link.');
		expect(textOf(r.modals[0], 'task-date-links-skipped')).toBe(skippedOne);
		expect(r.modals[0]?.contentEl.textContent).not.toContain('Private');
		await applyPreview(r.modals[0]);
		expect(await r.read('Projects/Plan.md')).toBe('- [x] Plan [[2026-09-13]] ✅ 2026-09-13\n');
		expect(await r.read('Projects/Private.md')).toBe(secret);
		expect(await r.read('Other/Else.md')).toBe(outside);
		expect(r.notices).toEqual([`Linked 1 done date in 1 note. ${skippedOne} ${UNDO_HINT}`]);
		expect(r.plugin.settings.undo?.files.map((f) => f.path)).toEqual(['Projects/Plan.md']);
	});

	it('the whole vault: opted-out notes stay as they are and the notice counts them', async () => {
		const a = `${OPT_OUT}- [x] A ✅ 2026-09-12\n`;
		const b = `${OPT_OUT}- [x] B ✅ 2026-09-12\n`;
		const r = await rig({ 'A.md': a, 'B.md': b, 'C.md': '- [x] C ✅ 2026-09-12\n- [x] D ✅ 2026-09-13\n' }, {}, true);
		await run(r, 'link-done-dates-vault');
		expect(textOf(r.modals[0], 'task-date-links-summary')).toBe('2 tasks in 1 note will get a link.');
		expect(textOf(r.modals[0], 'task-date-links-skipped')).toBe('Skipped 2 notes with the property "task-date-links: false".');
		await applyPreview(r.modals[0]);
		expect(await r.read('A.md')).toBe(a);
		expect(await r.read('B.md')).toBe(b);
		expect(await r.read('C.md')).toBe('- [x] C [[2026-09-12]] ✅ 2026-09-12\n- [x] D [[2026-09-13]] ✅ 2026-09-13\n');
		expect(r.notices).toEqual([`Linked 2 done dates in 1 note. Skipped 2 notes with the property "task-date-links: false". ${UNDO_HINT}`]);
	});

	it('the whole vault with only opted-out notes shows no preview and says why', async () => {
		const a = `${OPT_OUT}- [x] A ✅ 2026-09-12\n`;
		const r = await rig({ 'A.md': a, 'Open.md': '- [ ] Not done\n' }, {}, true);
		await run(r, 'link-done-dates-vault');
		expect(r.modals).toEqual([]);
		expect(r.notices).toEqual([`No done dates to link. ${skippedOne}`]);
		expect(await r.read('A.md')).toBe(a);
	});

	it('task-date-links: true and a missing property are both processed, with no skipped line', async () => {
		const r = await rig({ 'True.md': '---\ntask-date-links: true\n---\n- [x] T ✅ 2026-09-12\n', 'Plain.md': '- [x] P ✅ 2026-09-12\n' });
		await run(r, 'link-done-dates-note', 'True.md');
		await applyPreview(r.modals[0]);
		await run(r, 'link-done-dates-note', 'Plain.md');
		await applyPreview(r.modals[1]);
		expect(await r.read('True.md')).toBe('---\ntask-date-links: true\n---\n- [x] T [[2026-09-12]] ✅ 2026-09-12\n');
		expect(await r.read('Plain.md')).toBe('- [x] P [[2026-09-12]] ✅ 2026-09-12\n');
		expect(textOf(r.modals[0], 'task-date-links-skipped')).toBeNull();
		expect(textOf(r.modals[1], 'task-date-links-skipped')).toBeNull();
		const linked = `Linked 1 done date in 1 note. ${UNDO_HINT}`;
		expect(r.notices).toEqual([linked, linked]);
	});

	it('the text "false" in quotes is not the boolean false: the note is processed, the same as on completion', async () => {
		const r = await rig({ 'Text.md': '---\ntask-date-links: "false"\n---\n- [x] T ✅ 2026-09-12\n' });
		expect(r.app.metadataCache.getFileCache(r.file('Text.md'))?.frontmatter?.['task-date-links']).toBe('false');
		await run(r, 'link-done-dates-note', 'Text.md');
		expect(textOf(r.modals[0], 'task-date-links-summary')).toBe('1 task in 1 note will get a link.');
		await applyPreview(r.modals[0]);
		expect(await r.read('Text.md')).toBe('---\ntask-date-links: "false"\n---\n- [x] T [[2026-09-12]] ✅ 2026-09-12\n');
	});

	it('the link on completion and the back-fill agree for each value of the property', async () => {
		const values: [string, boolean][] = [
			['false', true],
			['true', false],
			['"false"', false],
			['no', false],
			['0', false],
		];
		const files: Record<string, string> = { 'none.md': '- [x] T ✅ 2026-09-12\n' };
		values.forEach(([v], i) => (files[`v${i}.md`] = `---\ntask-date-links: ${v}\n---\n- [x] T ✅ 2026-09-12\n`));
		const r = await rig(files);
		const p = r.plugin as unknown as { timers: Map<string, number>; onunload(): void };
		const check = async (path: string, out: boolean): Promise<void> => {
			// The link on completion: a note that opted out gets no timer, so the plugin never reads it.
			const cache = r.app.metadataCache.getFileCache(r.file(path));
			r.app.metadataCache.trigger('changed', r.file(path), '', cache);
			expect(p.timers.has(path), `on completion, ${path}`).toBe(!out);
			await run(r, 'link-done-dates-note', path);
			expect(r.notices.includes(SKIP_NOTE), `back-fill, ${path}`).toBe(out);
			r.notices.length = 0;
		};
		await check('none.md', false);
		for (let i = 0; i < values.length; i++) await check(`v${i}.md`, values[i]?.[1] ?? false);
		p.onunload();
	});

	it('a note that gets the property while the preview is open is skipped when you apply', async () => {
		const r = await rig({ 'A.md': '- [x] A ✅ 2026-09-12\n', 'B.md': '- [x] B ✅ 2026-09-12\n' }, {}, true);
		await run(r, 'link-done-dates-vault');
		expect(textOf(r.modals[0], 'task-date-links-summary')).toBe('2 tasks in 2 notes will get a link.');
		const late = `${OPT_OUT}- [x] A ✅ 2026-09-12\n`;
		await r.app.vault.modify(r.file('A.md'), late);
		await applyPreview(r.modals[0]);
		expect(await r.read('A.md')).toBe(late);
		expect(await r.read('B.md')).toBe('- [x] B [[2026-09-12]] ✅ 2026-09-12\n');
		expect(r.notices).toEqual([`Linked 1 done date in 1 note. ${skippedOne} ${UNDO_HINT}`]);
	});
});

describe('the preview window', () => {
	it('says how many notes the property skips', () => {
		expect(skippedText(0)).toBe('');
		expect(skippedText(1)).toBe(skippedOne);
		expect(skippedText(3)).toBe('Skipped 3 notes with the property "task-date-links: false".');
	});

	it('shows 40 lines at most and says how many it does not show', async () => {
		expect(moreText(PREVIEW_MAX)).toBe('');
		expect(moreText(PREVIEW_MAX + 1)).toBe('And 1 more line that this window does not show.');
		const body = Array.from({ length: PREVIEW_MAX + 5 }, (_, i) => `- [x] Task ${i} ✅ 2026-09-12`).join('\n');
		const r = await rig({ 'Long.md': `${body}\n` });
		await run(r, 'link-done-dates-note', 'Long.md');
		expect(textOf(r.modals[0], 'task-date-links-summary')).toBe('45 tasks in 1 note will get a link.');
		expect(r.modals[0]?.contentEl.querySelectorAll('.task-date-links-row').length).toBe(PREVIEW_MAX);
		expect(textOf(r.modals[0], 'task-date-links-more')).toBe('And 5 more lines that this window does not show.');
		await applyPreview(r.modals[0]);
		expect((await r.read('Long.md')).match(/\[\[2026-09-12\]\]/g)?.length).toBe(PREVIEW_MAX + 5);
	});
});
