import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type TFile } from 'obsidian-test-mocks/obsidian';
import TaskDateLinksPlugin from '../src/main';
import { DEFAULT_SETTINGS, type TaskDateLinksSettings } from '../src/settings';
import manifest from '../manifest.json';

const before = '- [x] Review ✅ 2026-09-12\n';
const after = '- [x] Review [[2026-09-12]] ✅ 2026-09-12\n';
const edits = [{ before: before.trimEnd(), after: after.trimEnd() }];
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => { resolve = r; });
	return { promise, resolve };
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => vi.restoreAllMocks());

async function rig(seed: string = before) {
	const app = App.createConfigured__({ files: { 'A.md': seed, 'B.md': seed, 'New.md': before } });
	let disk: TaskDateLinksSettings = { ...DEFAULT_SETTINGS, auto: false };
	const writes: TaskDateLinksSettings[] = [];
	function wire(p: TaskDateLinksPlugin) {
		p.settings = structuredClone(disk);
		vi.spyOn(p, 'loadData').mockImplementation(async () => structuredClone(disk));
		vi.spyOn(p, 'saveData').mockImplementation(async (data) => { disk = structuredClone(data); writes.push(structuredClone(data)); });
		return p;
	}
	const old = wire(new TaskDateLinksPlugin(app as never, manifest as never));
	async function fresh() {
		// Independent module evaluation, same actual App and persistent store.
		vi.resetModules();
		const Loaded = (await import('../src/main')).default;
		return wire(new Loaded(app as never, manifest as never));
	}
	const file = (path: string) => app.vault.getFileByPath(path)!;
	const read = (path: string) => app.vault.read(file(path));
	return { app, old, fresh, file, read, writes, disk: () => structuredClone(disk) };
}
async function apply(p: TaskDateLinksPlugin, files: TFile[]) {
	await (p as unknown as { applyPlan(files: TFile[], preview: { path: string; changes: [] }[], range: undefined, skipped: number): Promise<void> })
		.applyPlan(files, files.map(({ path }) => ({ path, changes: [] })), undefined, 0);
}

describe('App ownership across independently evaluated plugin modules', () => {
	it.each(['before callback', 'accepted write'] as const)('drains old apply at %s before immediate re-enable and preserves third-load recovery', async (phase) => {
		const r = await rig();
		const entered = deferred(), release = deferred();
		const process = r.app.vault.process.bind(r.app.vault);
		const calls: string[] = [];
		vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
			calls.push(file.path);
			if (file.path !== 'A.md') return process(file, fn);
			if (phase === 'before callback') { entered.resolve(); await release.promise; return process(file, fn); }
			const result = await process(file, fn); entered.resolve(); await release.promise; return result;
		});
		const pending = apply(r.old, [r.file('A.md'), r.file('B.md')]);
		await entered.promise; r.old.onunload();
		const fresh = await r.fresh();
		let ready = false;
		const loading = fresh.loadSettings().then(() => { ready = true; });
		await turn(); const earlyReady = ready, earlyCalls = [...calls];
		release.resolve(); await Promise.all([pending, loading]);
		expect(earlyReady).toBe(false); expect(earlyCalls).toEqual(['A.md']);
		expect(await r.read('A.md')).toBe(phase === 'accepted write' ? after : before);
		expect(await r.read('B.md')).toBe(before);
		expect(fresh.settings.undo?.files.map((f) => f.path) ?? []).toEqual(phase === 'accepted write' ? ['A.md'] : []);
		// Known completed old work is usable before a later apply intentionally replaces last undo.
		if (phase === 'accepted write') await fresh.undoLast();
		await apply(fresh, [r.file('New.md')]);
		fresh.settings.alias = 'MMM D'; await fresh.saveSettings();
		r.old.settings.alias = 'STALE'; await r.old.saveSettings();
		fresh.onunload(); const third = await r.fresh(); await third.loadSettings();
		expect(third.settings.alias).toBe('MMM D');
		expect(third.settings.undo?.files.map((f) => f.path)).toEqual(['New.md']);
		await third.undoLast(); expect(await r.read('New.md')).toBe(before);
		expect(r.disk().undo).toBeNull();
	});

	it('hands off only the outstanding old undo tail, including a missing note', async () => {
		const r = await rig(after);
		r.old.settings.undo = { at: 1, files: ['A.md', 'B.md', 'Missing.md'].map((path) => ({ path, edits })) };
		const entered = deferred(), release = deferred();
		const process = r.app.vault.process.bind(r.app.vault);
		vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
			const result = await process(file, fn); entered.resolve(); await release.promise; return result;
		});
		const pending = r.old.undoLast(); await entered.promise; r.old.onunload();
		const fresh = await r.fresh(), loading = fresh.loadSettings();
		await turn(); release.resolve(); await Promise.all([pending, loading]);
		expect(fresh.settings.undo?.files.map((f) => f.path)).toEqual(['B.md', 'Missing.md']);
		expect(await r.read('A.md')).toBe(before); expect(await r.read('B.md')).toBe(after);
		await r.app.vault.create('Missing.md', after); await fresh.undoLast();
		expect(await r.read('B.md')).toBe(before); expect(await r.read('Missing.md')).toBe(before);
		expect(r.disk().undo).toBeNull();
	});

	it('orders late saveData snapshots and queued settings saves before new settings and work', async () => {
		const r = await rig();
		r.old.settings.undo = { at: 1, files: [{ path: 'A.md', edits }] };
		const entered = deferred(), release = deferred();
		const save = r.old.saveData.bind(r.old);
		vi.mocked(r.old.saveData).mockImplementationOnce(async (snapshot) => {
			entered.resolve(); await release.promise; await save(snapshot);
		});
		r.old.settings.alias = 'OLD 1'; const save1 = r.old.saveSettings(); await entered.promise;
		r.old.settings.alias = 'OLD 2'; const save2 = r.old.saveSettings();
		r.old.onunload(); const fresh = await r.fresh();
		let loaded = false; const loading = fresh.loadSettings().then(() => { loaded = true; });
		await turn(); const early = loaded; release.resolve(); await Promise.all([save1, save2, loading]);
		expect(early).toBe(false); expect(fresh.settings.alias).toBe('OLD 2');
		expect(r.writes.map((w) => w.alias)).toEqual(['OLD 1', 'OLD 2']);
		fresh.settings.alias = 'MMM D'; await fresh.saveSettings();
		await apply(fresh, [r.file('New.md')]);
		r.old.settings.alias = 'late stale'; await r.old.saveSettings();
		fresh.onunload(); const third = await r.fresh(); await third.loadSettings();
		expect(third.settings.alias).toBe('MMM D');
		expect(third.settings.undo?.files.map((f) => f.path)).toEqual(['New.md']);
		await third.undoLast(); expect(await r.read('New.md')).toBe(before);
	});

	it('drains stale preferences snapshots together with a completed apply without dropping its recovery', async () => {
		const r = await rig();
		const accepted = deferred(), releaseWrite = deferred(), saving = deferred(), releaseSave = deferred();
		const process = r.app.vault.process.bind(r.app.vault);
		vi.spyOn(r.app.vault, 'process').mockImplementation(async (file, fn) => {
			const value = await process(file, fn); accepted.resolve(); await releaseWrite.promise; return value;
		});
		const save = r.old.saveData.bind(r.old);
		vi.mocked(r.old.saveData).mockImplementationOnce(async (snapshot) => { saving.resolve(); await releaseSave.promise; await save(snapshot); });
		const pending = apply(r.old, [r.file('A.md')]); await accepted.promise;
		r.old.settings.alias = 'OLD 1'; const save1 = r.old.saveSettings(); await saving.promise;
		r.old.settings.alias = 'OLD 2'; const save2 = r.old.saveSettings();
		r.old.onunload(); const fresh = await r.fresh();
		let ready = false; const loading = fresh.loadSettings().then(() => { ready = true; });
		releaseWrite.resolve(); await turn(); const early = ready;
		releaseSave.resolve(); await Promise.all([pending, save1, save2, loading]);
		expect(early).toBe(false); expect(fresh.settings.alias).toBe('OLD 2');
		expect(fresh.settings.undo?.files.map((f) => f.path)).toEqual(['A.md']);
		await fresh.undoLast(); expect(await r.read('A.md')).toBe(before);
	});

	it.each(['apply', 'undo', 'current', 'selection', 'automatic'] as const)('holds fresh %s behind predecessor readiness', async (operation) => {
		const r = await rig();
		const entered = deferred(), release = deferred();
		vi.mocked(r.old.saveData).mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
		const saving = r.old.saveSettings(); await entered.promise; r.old.onunload();
		const fresh = await r.fresh();
		const reads = vi.spyOn(r.app.vault, 'read'), cached = vi.spyOn(r.app.vault, 'cachedRead'), writes = vi.spyOn(r.app.vault, 'process');
		const methods = fresh as unknown as {
			backfill(files: TFile[], range: { from: number; to: number } | undefined, title: string): Promise<void>;
			settle(file: TFile): Promise<void>;
		};
		const pending = operation === 'apply' ? apply(fresh, [r.file('New.md')]) : operation === 'undo' ? fresh.undoLast() :
			operation === 'automatic' ? methods.settle(r.file('New.md')) : methods.backfill([r.file('New.md')], operation === 'selection' ? { from: 0, to: 0 } : undefined, 'Reload');
		await turn(); const early = [reads.mock.calls.length, cached.mock.calls.length, writes.mock.calls.length];
		release.resolve(); await Promise.all([saving, pending]);
		expect(early).toEqual([0, 0, 0]);
	});

	it('releases mutation ownership after a save failure so a retry and later reload can finish', async () => {
		const r = await rig();
		vi.mocked(r.old.saveData).mockRejectedValueOnce(new Error('controlled failure'));
		await expect(apply(r.old, [r.file('A.md')])).rejects.toThrow('controlled failure');
		await r.old.saveSettings(); r.old.onunload();
		const fresh = await r.fresh(); await fresh.loadSettings();
		await fresh.undoLast(); expect(await r.read('A.md')).toBe(before);
	});
});
