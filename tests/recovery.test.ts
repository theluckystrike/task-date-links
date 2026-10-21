import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Notice, type TFile } from 'obsidian-test-mocks/obsidian';
import TaskDateLinksPlugin from '../src/main';
import { PreviewModal } from '../src/preview';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { UndoBatch } from '../src/undo';
import manifest from '../manifest.json';
import { todayIso } from '../src/moment';

const before = (n: number) => `- [x] Task ${n} ✅ 2026-09-12`;
const after = (n: number) => `- [x] Task ${n} [[2026-09-12]] ✅ 2026-09-12`;
const body = (n: number) => Array.from({ length: n }, (_, i) => before(i)).join('\n') + '\n';

afterEach(() => vi.restoreAllMocks());

async function rig(files: Record<string, string>) {
	const app = App.createConfigured__({ files });
	const plugin = new TaskDateLinksPlugin(app as never, manifest as never);
	plugin.settings = { ...DEFAULT_SETTINGS, auto: false };
	// Persist a JSON copy, then load through the real settings normalizer.
	let disk: unknown = null;
	vi.spyOn(plugin, 'saveData').mockImplementation((data) => { disk = JSON.parse(JSON.stringify(data)); return Promise.resolve(); });
	vi.spyOn(plugin, 'loadData').mockImplementation(() => Promise.resolve(disk));
	const notices: string[] = [];
	vi.spyOn(Notice.prototype, 'constructor__').mockImplementation((m) => { notices.push(String(m)); });
	let modal: PreviewModal | undefined;
	vi.spyOn(PreviewModal.prototype, 'open').mockImplementation(function (this: PreviewModal) { modal = this; });
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const read = (p: string) => app.vault.read(app.vault.getFileByPath(p)!);
	const plan = async () => {
		modal = undefined;
		await (plugin as unknown as { backfill(files: TFile[], range: undefined, title: string): Promise<void> }).backfill(app.vault.getMarkdownFiles(), undefined, 'Recovery');
	};
	const apply = async () => {
		if (modal) await (modal as unknown as { onApply(): Promise<void> }).onApply();
	};
	return { app, plugin, notices, read, plan, apply };
}

function batch(paths: string[], count = 1): UndoBatch {
	return { at: 1, files: paths.map((path) => ({ path, edits: Array.from({ length: count }, (_, i) => ({ before: before(i), after: after(i) })) })) };
}

describe('undo recovery after a write failure', () => {
	it('keeps only outstanding edits across reload and retries without touching successful files', async () => {
		const r = await rig({ 'A.md': after(0) + '\r\n', 'B.md': after(0) + '\n' });
		r.plugin.settings.undo = batch(['A.md', 'B.md']);
		const process = r.app.vault.process.bind(r.app.vault);
		let fail = true;
		const calls: string[] = [];
		vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
			calls.push(file.path);
			if (file.path === 'B.md' && fail) {
				// A write rejection after the callback must not count as a committed restore.
				fn(await r.read(file.path));
				throw new Error('transient fixture write failure');
			}
			return process(file, fn);
		});
		// CRLF is part of the exact saved line, as it is in a real back-fill.
		r.plugin.settings.undo.files[0]!.edits = [{ before: before(0) + '\r', after: after(0) + '\r' }];
		await r.plugin.undoLast();
		expect(await r.read('A.md')).toBe(before(0) + '\r\n');
		expect(await r.read('B.md')).toBe(after(0) + '\n');
		expect(r.plugin.settings.undo?.files).toEqual(batch(['B.md']).files);
		expect(r.notices.at(-1)).toContain('Undid 1 lines.');
		expect(r.notices.at(-1)).toContain('could not be undone');
		expect(r.notices.at(-1)).not.toContain('changed since');
		await r.plugin.loadSettings();
		fail = false;
		await r.plugin.undoLast();
		expect(calls).toEqual(['A.md', 'B.md', 'B.md']);
		expect(await r.read('B.md')).toBe(before(0) + '\n');
		expect(r.plugin.settings.undo).toBeNull();
	});

	it('retains conflicts within a partly restored file and a missing file for a later retry', async () => {
		const conflict = after(1).replace('Task 1', 'User edit');
		const r = await rig({ 'A.md': after(0) + '\n' + conflict + '\n' });
		r.plugin.settings.undo = batch(['A.md'], 2);
		r.plugin.settings.undo.files.push(batch(['Missing.md']).files[0]!);
		await r.plugin.undoLast();
		expect(await r.read('A.md')).toBe(before(0) + '\n' + conflict + '\n');
		expect(r.plugin.settings.undo?.files[0]?.edits).toEqual([{ before: before(1), after: after(1) }]);
		expect(r.plugin.settings.undo?.files[1]?.path).toBe('Missing.md');
		expect(r.notices.at(-1)).toContain('changed since');
		expect(r.notices.at(-1)).toContain('missing');
		await r.plugin.loadSettings();
		await r.app.vault.modify(r.app.vault.getFileByPath('A.md')!, before(0) + '\n' + after(1) + '\n');
		await r.app.vault.create('Missing.md', after(0) + '\n');
		await r.plugin.undoLast();
		expect(await r.read('A.md')).toBe(before(0) + '\n' + before(1) + '\n');
		expect(await r.read('Missing.md')).toBe(before(0) + '\n');
		expect(r.plugin.settings.undo).toBeNull();
	});
});

describe('persisted back-fill capacity', () => {
	it.each([['files', 5000, 1], ['aggregate edits', 2, 10000]] as const)('accepts the exact %s boundary and reloads every accepted edit', async (_label, files, edits) => {
		const source = body(edits);
		const r = await rig(Object.fromEntries(Array.from({ length: files }, (_, i) => [`N${i}.md`, source])));
		await r.plan();
		await r.apply();
		await r.plugin.loadSettings();
		expect(r.plugin.settings.undo?.files).toHaveLength(files);
		expect(r.plugin.settings.undo?.files.reduce((n, f) => n + f.edits.length, 0)).toBe(files * edits);
		await r.plugin.undoLast();
		for (const file of r.app.vault.getMarkdownFiles()) expect(await r.read(file.path)).toBe(source);
		expect(r.plugin.settings.undo).toBeNull();
	}, 120000);

	it.each([['files', 5001, 1], ['aggregate edits', 2, 10001], ['one file edits', 1, 20001]] as const)('refuses above the %s boundary before any write and preserves the previous undo', async (_label, files, edits) => {
		const r = await rig(Object.fromEntries(Array.from({ length: files }, (_, i) => [`N${i}.md`, body(edits)])));
		const previous = batch(['Previous.md']);
		r.plugin.settings.undo = previous;
		const writes = vi.spyOn(r.app.vault, 'process');
		await r.plan();
		await r.apply();
		expect(writes.mock.calls.length).toBe(0);
		expect(r.plugin.settings.undo).toEqual(previous);
		expect(r.notices.at(-1)).toContain('5000 notes and 20000 changed lines');
		expect(r.notices.at(-1)).toContain('Nothing was changed');
	});

	it('checks the entire current plan again if a later note grows after preview', async () => {
		const r = await rig({ 'First.md': body(1), 'Later.md': body(1) });
		await r.plan();
		await r.app.vault.modify(r.app.vault.getFileByPath('Later.md')!, body(20000));
		const writes = vi.spyOn(r.app.vault, 'process');
		await r.apply();
		expect(writes.mock.calls.length).toBe(0);
		expect(await r.read('First.md')).toBe(body(1));
		expect(r.plugin.settings.undo).toBeNull();
	});

	it('refuses a note changed after preflight without applying uncounted edits', async () => {
		const r = await rig({ 'A.md': body(1) });
		await r.plan();
		const process = r.app.vault.process.bind(r.app.vault);
		vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
			await r.app.vault.modify(file, body(20001));
			return process(file, fn);
		});
		await r.apply();
		expect(await r.read('A.md')).toBe(body(20001));
		expect(r.plugin.settings.undo).toBeNull();
	});

	it('preserves an oversized undo saved by an older version instead of truncating recovery on reload', async () => {
		const r = await rig({});
		const legacy = batch(Array.from({ length: 5001 }, (_, i) => `N${i}.md`), 4);
		r.plugin.settings.undo = legacy;
		await r.plugin.saveSettings();
		await r.plugin.loadSettings();
		expect(JSON.stringify(r.plugin.settings.undo) === JSON.stringify(legacy)).toBe(true);
	});
});


function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}

async function applyFiles(r: Awaited<ReturnType<typeof rig>>, paths: string[]) {
	await (r.plugin as unknown as { applyPlan(files: TFile[], preview: { path: string; changes: [] }[], range: undefined, skipped: number): Promise<void> })
		.applyPlan(paths.map((p) => r.app.vault.getFileByPath(p)!), paths.map((path) => ({ path, changes: [] })), undefined, 0);
}

describe('exclusive mutations and disabled controller recovery', () => {
	it.each(['apply', 'undo'] as const)('rejects overlapping %s during undo and permits a new last undo after completion', async (overlap) => {
		const r = await rig({ 'Old.md': after(0) + '\n', 'New.md': body(1) });
		r.plugin.settings.undo = batch(['Old.md']);
		const entered = deferred(), release = deferred();
		const process = r.app.vault.process.bind(r.app.vault);
		const writes: string[] = [];
		vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
			writes.push(file.path);
			if (file.path === 'Old.md') { entered.resolve(); await release.promise; }
			return process(file, fn);
		});
		const pending = r.plugin.undoLast();
		await entered.promise;
		const overlapping = overlap === 'apply' ? applyFiles(r, ['New.md']) : r.plugin.undoLast();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const overlappedWrites = [...writes];
		release.resolve(); await Promise.all([pending, overlapping]);
		expect(overlappedWrites).toEqual(['Old.md']);
		expect(await r.read('New.md')).toBe(body(1));
		expect(r.notices.some((n) => n.includes('busy'))).toBe(true);
		await applyFiles(r, ['New.md']);
		await r.plugin.loadSettings();
		expect(await r.read('New.md')).toBe(after(0) + '\n');
		expect(r.plugin.settings.undo?.files.map((f) => f.path)).toEqual(['New.md']);
	});

	it('rejects apply/apply overlap, including duplicate preview acceptance', async () => {
		const r = await rig({ 'A.md': body(1), 'B.md': body(1) });
		const entered = deferred(), release = deferred();
		const process = r.app.vault.process.bind(r.app.vault);
		const writes: string[] = [];
		vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
			writes.push(file.path);
			if (file.path === 'A.md') { entered.resolve(); await release.promise; }
			return process(file, fn);
		});
		const pending = applyFiles(r, ['A.md']); await entered.promise;
		const other = applyFiles(r, ['B.md']), duplicate = applyFiles(r, ['A.md']);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const overlappedWrites = [...writes];
		release.resolve(); await Promise.all([pending, other, duplicate]);
		expect(overlappedWrites).toEqual(['A.md']);
		expect(r.notices.some((n) => n.includes('busy'))).toBe(true);
		await r.plugin.loadSettings();
		expect(r.plugin.settings.undo?.files.map((f) => f.path)).toEqual(['A.md']);
		expect(await r.read('B.md')).toBe(body(1));
	});

	it.each(['apply', 'undo'] as const)('stops %s after disable while preserving an already accepted first write and unsent recovery', async (operation) => {
		const seed = operation === 'apply' ? body(1) : after(0) + '\n';
		const r = await rig({ 'A.md': seed, 'B.md': seed });
		if (operation === 'undo') r.plugin.settings.undo = batch(['A.md', 'B.md']);
		const accepted = deferred(), release = deferred();
		const process = r.app.vault.process.bind(r.app.vault);
		const writes: string[] = [];
		vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
			writes.push(file.path);
			// Callback accepted before unload; only the process promise settles afterwards.
			const result = await process(file, fn);
			if (file.path === 'A.md') { accepted.resolve(); await release.promise; }
			return result;
		});
		const pending = operation === 'apply' ? applyFiles(r, ['A.md', 'B.md']) : r.plugin.undoLast();
		await accepted.promise; r.plugin.onunload(); release.resolve(); await pending;
		expect(writes).toEqual(['A.md']);
		expect(await r.read('B.md')).toBe(seed);
		expect(await r.read('A.md')).toBe(operation === 'apply' ? after(0) + '\n' : body(1));
		await r.plugin.loadSettings();
		expect(r.plugin.settings.undo?.files.map((f) => f.path)).toEqual([operation === 'apply' ? 'A.md' : 'B.md']);
	});

	it.each(['apply', 'undo'] as const)('does not mutate a deferred %s callback or a later file after disable', async (operation) => {
		const seed = operation === 'apply' ? body(1) : after(0) + '\n';
		const r = await rig({ 'A.md': seed, 'B.md': seed });
		const previous = batch(operation === 'apply' ? ['Previous.md'] : ['A.md', 'B.md']);
		r.plugin.settings.undo = previous;
		const entered = deferred(), release = deferred();
		const process = r.app.vault.process.bind(r.app.vault);
		const writes: string[] = [];
		vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
			writes.push(file.path);
			if (file.path === 'A.md') { entered.resolve(); await release.promise; }
			return process(file, fn);
		});
		const pending = operation === 'apply' ? applyFiles(r, ['A.md', 'B.md']) : r.plugin.undoLast();
		await entered.promise; r.plugin.onunload(); release.resolve(); await pending;
		expect(writes).toEqual(['A.md']);
		expect(await r.read('A.md')).toBe(seed); expect(await r.read('B.md')).toBe(seed);
		await r.plugin.loadSettings(); expect(r.plugin.settings.undo).toEqual(previous);
	});

	it.each(['apply', 'undo'] as const)('uses the final callback of a retried %s process when disable intervenes', async (operation) => {
		const seed = operation === 'apply' ? body(1) : after(0) + '\n';
		const r = await rig({ 'A.md': seed });
		const previous = batch(operation === 'apply' ? ['Previous.md'] : ['A.md']);
		r.plugin.settings.undo = previous;
		const process = r.app.vault.process.bind(r.app.vault);
		vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
			fn(seed); // Optimistic callback is retried before accepting any write.
			r.plugin.onunload();
			return process(file, fn);
		});
		if (operation === 'apply') await applyFiles(r, ['A.md']); else await r.plugin.undoLast();
		expect(await r.read('A.md')).toBe(seed);
		await r.plugin.loadSettings(); expect(r.plugin.settings.undo).toEqual(previous);
	});

	it('releases exclusivity after a persistence error and a cancelled preview', async () => {
		const r = await rig({ 'A.md': body(1), 'B.md': body(1) });
		vi.mocked(r.plugin.saveData).mockRejectedValueOnce(new Error('fixture persistence error'));
		await expect(applyFiles(r, ['A.md'])).rejects.toThrow('fixture persistence error');
		await r.plan(); // Closing/cancelling a preview never owns the mutation guard.
		await applyFiles(r, ['B.md']);
		expect(await r.read('B.md')).toBe(after(0) + '\n');
		expect(r.plugin.settings.undo?.files.map((f) => f.path)).toEqual(['B.md']);
	});
});


describe('deferred controller reads and previews', () => {
	it.each(['preview', 'apply', 'automatic'] as const)('does not start further reads or writes after disable during %s read', async (operation) => {
		const r = await rig({ 'A.md': body(1), 'B.md': body(1) });
		const entered = deferred(), release = deferred();
		const method = operation === 'preview' ? 'cachedRead' : 'read';
		const read = r.app.vault[method].bind(r.app.vault);
		const reads: string[] = [];
		vi.spyOn(r.app.vault, method).mockImplementation(async (file) => {
			reads.push(file.path);
			const text = await read(file);
			if (file.path === 'A.md') { entered.resolve(); await release.promise; }
			return text;
		});
		const writes = vi.spyOn(r.app.vault, 'process');
		const pending = operation === 'preview' ? r.plan() : operation === 'apply' ? applyFiles(r, ['A.md', 'B.md']) :
			(r.plugin as unknown as { settle(file: TFile): Promise<void> }).settle(r.app.vault.getFileByPath('A.md')!);
		await entered.promise; r.plugin.onunload(); release.resolve(); await pending;
		expect(reads).toEqual(['A.md']); expect(writes).not.toHaveBeenCalled();
		await r.apply(); expect(writes).not.toHaveBeenCalled();
	});

	it('rejects a stale preview callback after unload without starting a read', async () => {
		const r = await rig({ 'A.md': body(1) });
		await r.plan(); r.plugin.onunload();
		const reads = vi.spyOn(r.app.vault, 'read'), writes = vi.spyOn(r.app.vault, 'process');
		await r.apply(); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
	});
});


it('leaves an automatic update unchanged when its callback is deferred past unload', async () => {
	const source = `- [x] Today ✅ ${todayIso()}\n`;
	const r = await rig({ 'A.md': source });
	const entered = deferred(), release = deferred();
	const process = r.app.vault.process.bind(r.app.vault);
	vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
		entered.resolve(); await release.promise; return process(file, fn);
	});
	const pending = (r.plugin as unknown as { settle(file: TFile): Promise<void> }).settle(r.app.vault.getFileByPath('A.md')!);
	await entered.promise; r.plugin.onunload(); release.resolve(); await pending;
	expect(await r.read('A.md')).toBe(source);
});
