import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { App, type TFile } from 'obsidian-test-mocks/obsidian';
import TaskDateLinksPlugin from '../src/main';
import { DEFAULT_SETTINGS, type TaskDateLinksSettings } from '../src/settings';
import manifest from '../manifest.json';

const before = '- [x] Recovery ✅ 2026-09-12\r\n';
const after = '- [x] Recovery [[2026-09-12]] ✅ 2026-09-12\r\n';
const edits = [{ before: before.slice(0, -1), after: after.slice(0, -1) }];
const turn = () => new Promise((r) => setTimeout(r, 0));
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

async function rig(seed = before) {
	const app = App.createConfigured__({ files: { 'A.md': seed, 'B.md': seed, 'New.md': before } });
	let disk: TaskDateLinksSettings = { ...DEFAULT_SETTINGS, auto: false };
	let failures = 0;
	const saves: TaskDateLinksSettings[] = [];
	// onload() wraps saveData (packages/hello), so the tests keep the spy of each plugin here.
	const saveSpies = new Map<TaskDateLinksPlugin, MockInstance<(data: unknown) => Promise<void>>>();
	function wire(p: TaskDateLinksPlugin) {
		vi.spyOn(p, 'loadData').mockImplementation(async () => structuredClone(disk));
		saveSpies.set(p, vi.spyOn(p, 'saveData').mockImplementation(async (data) => {
			saves.push(structuredClone(data));
			if (failures > 0) { failures--; throw new Error(`storage unavailable ${saves.length}`); }
			disk = structuredClone(data);
		}));
		return p;
	}
	const old = wire(new TaskDateLinksPlugin(app as never, manifest as never));
	await old.onload();
	async function fresh() {
		// Obsidian drops the views of a disabled plugin. onunload() alone does not do that in the mock.
		(app as unknown as { viewRegistry: { unregisterView(type: string): void } }).viewRegistry.unregisterView(`${manifest.id}-whats-new`);
		vi.resetModules();
		const Loaded = (await import('../src/main')).default;
		return wire(new Loaded(app as never, manifest as never));
	}
	const file = (path: string) => app.vault.getFileByPath(path)!;
	return { app, old, fresh, file, saveSpy: (p: TaskDateLinksPlugin) => saveSpies.get(p)!, read: (path: string) => app.vault.read(file(path)), saves,
		fail: (n: number) => { failures = n; }, disk: () => structuredClone(disk) };
}
async function apply(p: TaskDateLinksPlugin, files: TFile[]) {
	await (p as unknown as { applyPlan(files: TFile[], preview: { path: string; changes: [] }[], range: undefined, skipped: number): Promise<void> })
		.applyPlan(files, files.map(({ path }) => ({ path, changes: [] })), undefined, 0);
}

describe('fresh onload recovers failed final persistence', () => {
	it('retries one failed accepted apply save on fresh onload, survives two more reloads and undoes A', async () => {
		const r = await rig(); r.fail(1);
		await expect(apply(r.old, [r.file('A.md')])).rejects.toThrow('storage unavailable 1');
		expect(await r.read('A.md')).toBe(after); expect(r.disk().undo).toBeNull();
		const known = structuredClone(r.old.settings.undo);
		r.old.onunload(); const fresh = await r.fresh(); await fresh.onload();
		expect(fresh.settings.undo).toEqual(known); expect(r.disk().undo).toEqual(known); expect(r.saves).toHaveLength(2);
		fresh.onunload(); const third = await r.fresh(); await third.onload();
		third.onunload(); const fourth = await r.fresh(); await fourth.onload();
		expect(fourth.settings.undo).toEqual(known); expect(r.saves).toHaveLength(2);
		await fourth.undoLast(); expect(await r.read('A.md')).toBe(before); expect(r.disk().undo).toBeNull();
	});

	it('keeps failed enables blocked with each actual retry error and later enables once healthy', async () => {
		const r = await rig(); r.fail(3);
		await expect(apply(r.old, [r.file('A.md')])).rejects.toThrow('storage unavailable 1'); r.old.onunload();
		for (const n of [2, 3]) {
			const fresh = await r.fresh();
			await expect(fresh.onload()).rejects.toThrow(`storage unavailable ${n}`);
			const process = vi.spyOn(r.app.vault, 'process');
			await expect(apply(fresh, [r.file('New.md')])).rejects.toThrow(`storage unavailable ${n}`);
			expect(process).not.toHaveBeenCalled(); expect(r.disk().undo).toBeNull();
			await turn(); expect(r.saves).toHaveLength(n); fresh.onunload();
		}
		const healthy = await r.fresh(); await healthy.onload();
		expect(r.saves).toHaveLength(4); expect(healthy.settings.undo?.files.map((f) => f.path)).toEqual(['A.md']);
		await healthy.undoLast(); expect(await r.read('A.md')).toBe(before);
	});

	it.each([1, 2])('serializes queued owners through %s failures without stale writes after readiness', async (failures) => {
		const r = await rig(); r.fail(failures);
		const entered = deferred(), release = deferred();
		const spy = r.saveSpy(r.old); const save = spy.getMockImplementation()!;
		spy.mockImplementationOnce(async (data) => { entered.resolve(); await release.promise; await save(data); });
		const pending = apply(r.old, [r.file('A.md')]);
		const rejected = expect(pending).rejects.toThrow('storage unavailable 1');
		await entered.promise; r.old.onunload();
		const second = await r.fresh(); let secondReady = false;
		const loading2 = second.onload().then(() => { secondReady = true; }, (e: Error) => { expect(failures).toBe(2); expect(e.message).toBe('storage unavailable 2'); });
		const third = await r.fresh(); let thirdReady = false;
		const loading3 = third.onload().then(() => { thirdReady = true; });
		await turn(); expect([secondReady, thirdReady]).toEqual([false, false]);
		release.resolve(); await Promise.all([rejected, loading2, loading3]);
		expect(third.settings.undo?.files.map((f) => f.path)).toEqual(['A.md']); expect(r.saves).toHaveLength(failures + 1);
		third.settings.alias = 'MMM D'; await third.saveSettings(); await third.undoLast();
		await apply(third, [r.file('New.md')]);
		r.old.settings.alias = 'STALE'; second.settings.alias = 'STALE';
		await Promise.all([r.old.saveSettings(), second.saveSettings()]);
		third.onunload(); const fourth = await r.fresh(); await fourth.onload();
		expect(fourth.settings.alias).toBe('MMM D'); expect(fourth.settings.undo?.files.map((f) => f.path)).toEqual(['New.md']);
		expect(r.disk().alias).toBe('MMM D'); await fourth.undoLast(); expect(await r.read('New.md')).toBe(before);
	});

	it('retains only outstanding missing, conflicting and failed undo edits after a failed final save', async () => {
		const r = await rig(after);
		await r.app.vault.modify(r.file('B.md'), 'user changed this\r\n');
		r.old.settings.undo = { at: 7, files: ['A.md', 'B.md', 'Missing.md'].map((path) => ({ path, edits })) };
		await r.old.saveSettings(); r.fail(1);
		await expect(r.old.undoLast()).rejects.toThrow('storage unavailable 2');
		expect(await r.read('A.md')).toBe(before);
		r.old.onunload(); const fresh = await r.fresh(); await fresh.onload();
		expect(fresh.settings.undo).toEqual({ at: 7, files: ['B.md', 'Missing.md'].map((path) => ({ path, edits })) });
		await fresh.undoLast(); expect(fresh.settings.undo?.files.map((f) => f.path)).toEqual(['B.md', 'Missing.md']);
		await r.app.vault.modify(r.file('B.md'), after); await r.app.vault.create('Missing.md', after);
		const process = vi.spyOn(r.app.vault, 'process'); await fresh.undoLast();
		expect(process.mock.calls.map(([f]) => f.path)).toEqual(['B.md', 'Missing.md']);
		expect(await r.read('B.md')).toBe(before); expect(await r.read('Missing.md')).toBe(before); expect(r.disk().undo).toBeNull();
	});

	it('hands off a failed partial undo final save while a later tail remains untouched', async () => {
		const r = await rig(after);
		r.old.settings.undo = { at: 9, files: ['A.md', 'B.md'].map((path) => ({ path, edits })) };
		await r.old.saveSettings(); r.fail(1);
		const accepted = deferred(), release = deferred(); const process = r.app.vault.process.bind(r.app.vault);
		vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
			const value = await process(file, fn); accepted.resolve(); await release.promise; return value;
		});
		const pending = r.old.undoLast(); const rejected = expect(pending).rejects.toThrow('storage unavailable 2');
		await accepted.promise; r.old.onunload(); const fresh = await r.fresh(); const loading = fresh.onload();
		release.resolve(); await Promise.all([rejected, loading]); vi.mocked(r.app.vault.process).mockRestore();
		expect(fresh.settings.undo?.files.map((f) => f.path)).toEqual(['B.md']);
		expect(await r.read('A.md')).toBe(before); expect(await r.read('B.md')).toBe(after);
		await fresh.undoLast(); expect(await r.read('B.md')).toBe(before); expect(r.disk().undo).toBeNull();
	});

	it('holds another mutation when its explicit recovery retry fails, then permits a healthy retry', async () => {
		const r = await rig(); r.fail(2);
		await expect(apply(r.old, [r.file('A.md')])).rejects.toThrow('storage unavailable 1');
		await expect(apply(r.old, [r.file('New.md')])).rejects.toThrow('storage unavailable 2');
		expect(await r.read('New.md')).toBe(before); expect(r.old.settings.undo?.files.map((f) => f.path)).toEqual(['A.md']);
		await r.old.saveSettings(); await r.old.undoLast(); expect(await r.read('A.md')).toBe(before);
	});
	it('holds automatic updates without retrying a failed save or creating an unhandled rejection', async () => {
		const r = await rig(); r.fail(10);
		await expect(apply(r.old, [r.file('A.md')])).rejects.toThrow('storage unavailable 1');
		const process = vi.spyOn(r.app.vault, 'process'), warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const automatic = r.old as unknown as { settle(file: TFile): Promise<void> };
		for (let n = 0; n < 4; n++) await automatic.settle(r.file('New.md'));
		expect(r.saves).toHaveLength(1); expect(process).not.toHaveBeenCalled(); expect(warn).toHaveBeenCalledTimes(4);
		expect(String(warn.mock.calls[0]?.[2])).toContain('storage unavailable 1');
		r.old.onunload(); r.fail(0); const fresh = await r.fresh(); await fresh.onload();
		expect(r.saves).toHaveLength(2); await fresh.undoLast(); expect(await r.read('A.md')).toBe(before);
	});

});
