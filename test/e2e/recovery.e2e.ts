import { browser, expect } from '@wdio/globals';
import { createHash } from 'node:crypto';
import { obsidianPage } from 'wdio-obsidian-service';
import { pluginId, reloadPlugin } from './load';
import { DIR, closeModals, notices, readFile, run, setSettings, writeFile } from './helpers';

const A = `${DIR}/Recovery A.md`;
const B = `${DIR}/Recovery B.md`;
const BEFORE = '- [x] Recovery ✅ 2026-09-12\r\n';
const AFTER = '- [x] Recovery [[2026-09-12]] ✅ 2026-09-12\r\n';

describe(`${pluginId} recovery`, function () {
	afterEach(async function () {
		await closeModals();
		await setSettings({ auto: true, undo: null });
		await writeFile(A, BEFORE);
		await writeFile(B, BEFORE);
	});

	it('binds the installed candidate bytes to the actual Obsidian runtime', async function () {
		const receipt = await browser.executeObsidian(async ({ app, obsidian }, id) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { manifest: { version: string } }> } }).plugins.plugins[id]!;
			return {
				appVersion: obsidian.apiVersion,
				pluginVersion: plugin.manifest.version,
				main: await app.vault.adapter.read(`${app.vault.configDir}/plugins/${id}/main.js`),
				manifest: await app.vault.adapter.read(`${app.vault.configDir}/plugins/${id}/manifest.json`),
				styles: await app.vault.adapter.read(`${app.vault.configDir}/plugins/${id}/styles.css`),
			};
		}, pluginId);
		expect(['1.13.4', '1.14.4']).toContain(receipt.appVersion);
		console.log('TASK_UNDO_APP_BINDING ' + JSON.stringify({
			appVersion: receipt.appVersion, pluginVersion: receipt.pluginVersion,
			mainSha256: createHash('sha256').update(receipt.main).digest('hex'),
			manifestSha256: createHash('sha256').update(receipt.manifest).digest('hex'),
			stylesSha256: createHash('sha256').update(receipt.styles).digest('hex'),
		}));
	});

	it('retains a rejected write through a real plugin reload, then retries only that note', async function () {
		await setSettings({ auto: false });
		await writeFile(A, AFTER);
		await writeFile(B, AFTER);
		const first = await browser.executeObsidian(async ({ app }, id, a, b, before, after) => {
			interface RecoveryPlugin { settings: { undo: unknown }; undoLast(): Promise<void> }
			const p = (app as unknown as { plugins: { plugins: Record<string, RecoveryPlugin> } }).plugins.plugins[id]!;
			p.settings.undo = { at: 1, files: [a, b].map((path) => ({ path, edits: [{ before: before.trimEnd() + '\r', after: after.trimEnd() + '\r' }] })) };
			const original = app.vault.process;
			app.vault.process = async (file, fn, options) => {
				if (file.path === b) { fn(await app.vault.read(file)); throw new Error('controlled transient write failure'); }
				return original.call(app.vault, file, fn, options);
			};
			try { await p.undoLast(); return p.settings.undo; }
			finally { app.vault.process = original; }
		}, pluginId, A, B, BEFORE, AFTER);
		expect(first).toEqual({ at: 1, files: [{ path: B, edits: [{ before: BEFORE.slice(0, -1), after: AFTER.slice(0, -1) }] }] });
		expect(await readFile(A)).toBe(BEFORE);
		expect(await readFile(B)).toBe(AFTER);
		expect(await reloadPlugin(pluginId)).toEqual({ enabled: true, reloaded: true, errors: [] });
		const retry = await browser.executeObsidian(async ({ app }, id) => {
			interface RecoveryPlugin { settings: { undo: unknown }; undoLast(): Promise<void> }
			const p = (app as unknown as { plugins: { plugins: Record<string, RecoveryPlugin> } }).plugins.plugins[id]!;
			const saved = p.settings.undo;
			const calls: string[] = [];
			const original = app.vault.process;
			app.vault.process = async (file, fn, options) => { calls.push(file.path); return original.call(app.vault, file, fn, options); };
			try { await p.undoLast(); return { saved, calls, undo: p.settings.undo }; }
			finally { app.vault.process = original; }
		}, pluginId);
		expect(retry).toEqual({ saved: first, calls: [B], undo: null });
		expect(await readFile(A)).toBe(BEFORE);
		expect(await readFile(B)).toBe(BEFORE);
	});

	it('refuses 20001 changed lines visibly before a real note write', async function () {
		await setSettings({ auto: false });
		const source = Array.from({ length: 20001 }, (_, i) => `- [x] Recovery ${i} ✅ 2026-09-12`).join('\n') + '\n';
		await writeFile(A, source);
		await obsidianPage.openFile(A);
		// The afterEach of the last test turned automatic links on and wrote the notes again. That work can still hold
		// the plugin, and a command then gets the busy notice instead of the check. Wait until the plugin is idle.
		const idle = () => browser.executeObsidian(({ app }, id) => !(app as unknown as { plugins: { plugins: Record<string, { mutationBusy?: boolean }> } }).plugins.plugins[id]!.mutationBusy, pluginId);
		for (let i = 0; i < 2; i++) {
			await browser.waitUntil(idle, { timeout: 15000, timeoutMsg: 'the plugin stayed busy' });
			await browser.pause(500);
		}
		await run('link-done-dates-note');
		await browser.waitUntil(async () => (await notices()).some((n) => n.includes('5000 notes and 20000 changed lines')), { timeout: 15000, timeoutMsg: 'missing capacity notice' });
		expect(await readFile(A)).toBe(source);
		expect(await browser.$$('.task-date-links-preview').length).toBe(0);
	});
});

for (const phase of ['apply deferred', 'apply accepted', 'undo deferred', 'undo accepted', 'settings snapshot']) {
	it(`hands off ${phase} through immediate native disable and enable`, async function () {
		await setSettings({ auto: false, alias: '', undo: null });
		await writeFile(A, phase.startsWith('undo') ? AFTER : BEFORE);
		await writeFile(B, phase.startsWith('undo') ? AFTER : BEFORE);
		const result = await browser.executeObsidian(async ({ app }, id, a, b, before, after, phase) => {
			interface P {
				settings: { auto: boolean; alias: string; undo: { at: number; files: { path: string; edits: { before: string; after: string }[] }[] } | null };
				applyPlan(files: unknown[], preview: unknown[], range: undefined, skipped: number): Promise<void>;
				undoLast(): Promise<void>; saveSettings(): Promise<void>; saveData(data: unknown): Promise<void>;
			}
			interface Manager { plugins: Record<string, P>; disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<boolean> }
			const manager = (app as unknown as { plugins: Manager }).plugins;
			const old = manager.plugins[id]!;
			let release!: () => void, enter!: () => void;
			const held = new Promise<void>((r) => { release = r; });
			const entered = new Promise<void>((r) => { enter = r; });
			const original = app.vault.process, originalSave = old.saveData;
			const calls: string[] = [];
			const apply = (p: P, paths: string[]) => p.applyPlan(paths.map((path) => app.vault.getFileByPath(path)!), paths.map((path) => ({ path, changes: [] })), undefined, 0);
			const edit = { before: before.slice(0, -1), after: after.slice(0, -1) };
			if (phase.startsWith('undo')) old.settings.undo = { at: 1, files: [a, b].map((path) => ({ path, edits: [edit] })) };
			if (phase === 'settings snapshot') {
				old.settings.alias = 'OLD';
				old.saveData = async (data) => { enter(); await held; await originalSave.call(old, data); };
			} else {
				app.vault.process = async (file, fn, options) => {
					calls.push(file.path);
					if (file.path !== a) return original.call(app.vault, file, fn, options);
					if (phase.endsWith('deferred')) { enter(); await held; return original.call(app.vault, file, fn, options); }
					const value = await original.call(app.vault, file, fn, options); enter(); await held; return value;
				};
			}
			try {
				const pending = phase === 'settings snapshot' ? old.saveSettings() : phase.startsWith('undo') ? old.undoLast() : apply(old, [a, b]);
				await entered;
				await manager.disablePlugin(id);
				let enabledEarly = false;
				// Start real enable before releasing the predecessor. Awaiting it here would deadlock the fixture.
				const enabling = manager.enablePlugin(id).then((value) => { enabledEarly = true; return value; });
				await new Promise((resolve) => setTimeout(resolve, 0));
				const early = enabledEarly, earlyCalls = [...calls];
				release(); await pending; const enabled = await enabling;
				app.vault.process = original; old.saveData = originalSave;
				const fresh = manager.plugins[id]!;
				const inherited = fresh.settings.undo?.files.map((f) => f.path) ?? [];
				const aAfterHandoff = await app.vault.read(app.vault.getFileByPath(a)!);
				const bAfterHandoff = await app.vault.read(app.vault.getFileByPath(b)!);
				if (fresh.settings.undo) await fresh.undoLast();
				fresh.settings.alias = 'MMM D'; await fresh.saveSettings();
				await apply(fresh, [b]); // Intentionally replaces the earlier last undo after completion.
				old.settings.alias = 'STALE'; old.settings.undo = null; await old.saveSettings();
				await manager.disablePlugin(id); const thirdEnabled = await manager.enablePlugin(id);
				const third = manager.plugins[id]!;
				const savedAlias = third.settings.alias, savedUndo = third.settings.undo?.files.map((f) => f.path) ?? [];
				await third.undoLast();
				const disk = JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/plugins/${id}/data.json`)) as { alias: string; undo: unknown };
				return { early, earlyCalls, enabled, thirdEnabled, distinct: old !== fresh && fresh !== third, inherited, aAfterHandoff, bAfterHandoff, savedAlias, savedUndo, finalB: await app.vault.read(app.vault.getFileByPath(b)!), diskAlias: disk.alias, diskUndo: disk.undo };
			} finally { release(); app.vault.process = original; old.saveData = originalSave; }
		}, pluginId, A, B, BEFORE, AFTER, phase);
		expect(result.early).toBe(false);
		expect(result.earlyCalls).toEqual(phase === 'settings snapshot' ? [] : [A]);
		expect(result.enabled && result.thirdEnabled && result.distinct).toBe(true);
		expect(result.inherited).toEqual(phase === 'apply accepted' ? [A] : phase === 'undo accepted' ? [B] : phase === 'undo deferred' ? [A, B] : []);
		expect(result.aAfterHandoff).toBe(phase === 'apply accepted' || phase === 'undo deferred' ? AFTER : BEFORE);
		expect(result.bAfterHandoff).toBe(phase.startsWith('undo') ? AFTER : BEFORE);
		expect(result.savedAlias).toBe('MMM D'); expect(result.diskAlias).toBe('MMM D');
		expect(result.savedUndo).toEqual([B]); expect(result.finalB).toBe(BEFORE); expect(result.diskUndo).toBeNull();
		console.log('TASK_UNDO_IMMEDIATE_REENABLE ' + JSON.stringify({ phase, result }));
	});
}

for (const phase of ['accepted apply', 'outstanding undo tail']) {
	it(`recovers a rejected final save for ${phase} through fresh native enables`, async function () {
		await setSettings({ auto: false, alias: '', undo: null });
		await writeFile(A, phase === 'accepted apply' ? BEFORE : AFTER);
		await writeFile(B, phase === 'accepted apply' ? BEFORE : AFTER);
		const result = await browser.executeObsidian(async ({ app, obsidian }, id, a, b, before, after, phase) => {
			interface P {
				settings: { alias: string; undo: { at: number; files: { path: string; edits: { before: string; after: string }[] }[] } | null };
				applyPlan(files: unknown[], preview: unknown[], range: undefined, skipped: number): Promise<void>;
				undoLast(): Promise<void>; saveData(data: unknown): Promise<void>; saveSettings(): Promise<void>;
			}
			interface Manager { plugins: Record<string, P>; disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<boolean> }
			const manager = (app as unknown as { plugins: Manager }).plugins;
			const old = manager.plugins[id]!, originalSave = old.saveData, originalProcess = app.vault.process;
			const apply = (p: P, path: string) => p.applyPlan([app.vault.getFileByPath(path)!], [{ path, changes: [] }], undefined, 0);
			const disk = async () => JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/plugins/${id}/data.json`)) as { alias: string; undo: unknown };
			let saves = 0, failure = '';
			if (phase === 'outstanding undo tail') {
				old.settings.undo = { at: 13, files: [a, b].map((path) => ({ path, edits: [{ before: before.slice(0, -1), after: after.slice(0, -1) }] })) };
				await old.saveSettings();
				app.vault.process = async (file, fn, options) => {
					if (file.path === b) throw new Error('controlled undo write failure');
					return originalProcess.call(app.vault, file, fn, options);
				};
			}
			// Only the first host save rejects. Storage is healthy before real disable/enable.
			old.saveData = async (data) => {
				saves++;
				if (saves === 1) throw new Error('controlled final save rejection');
				await originalSave.call(old, data);
			};
			try {
				try { if (phase === 'accepted apply') await apply(old, a); else await old.undoLast(); }
				catch (e) { failure = String(e); }
				app.vault.process = originalProcess;
				const known = structuredClone(old.settings.undo), diskBefore = (await disk()).undo;
				await manager.disablePlugin(id); const enabled = await manager.enablePlugin(id);
				const fresh = manager.plugins[id]!;
				const inherited = structuredClone(fresh.settings.undo), diskRecovered = (await disk()).undo;
				await manager.disablePlugin(id); const secondEnabled = await manager.enablePlugin(id);
				const second = manager.plugins[id]!, secondUndo = structuredClone(second.settings.undo);
				await manager.disablePlugin(id); const thirdEnabled = await manager.enablePlugin(id);
				const third = manager.plugins[id]!, thirdUndo = structuredClone(third.settings.undo);
				const aBeforeUndo = await app.vault.read(app.vault.getFileByPath(a)!);
				const bBeforeUndo = await app.vault.read(app.vault.getFileByPath(b)!);
				await third.undoLast();
				const aRestored = await app.vault.read(app.vault.getFileByPath(a)!);
				const bRestored = await app.vault.read(app.vault.getFileByPath(b)!);
				third.settings.alias = 'MMM D'; await third.saveSettings(); await apply(third, b);
				await manager.disablePlugin(id); const fourthEnabled = await manager.enablePlugin(id);
				const fourth = manager.plugins[id]!, savedAlias = fourth.settings.alias, savedUndo = fourth.settings.undo?.files.map((f) => f.path);
				await fourth.undoLast();
				return { appVersion: obsidian.apiVersion, failure, saves, known, diskBefore, inherited, diskRecovered, secondUndo, thirdUndo, enabled, secondEnabled, thirdEnabled, fourthEnabled, distinct: old !== fresh && fresh !== second && second !== third && third !== fourth, aBeforeUndo, bBeforeUndo, aRestored, bRestored, savedAlias, savedUndo, diskFinal: await disk() };
			} finally { old.saveData = originalSave; app.vault.process = originalProcess; }
		}, pluginId, A, B, BEFORE, AFTER, phase);
		expect(result.failure).toContain('controlled final save rejection'); expect(result.saves).toBe(2);
		expect(result.enabled && result.secondEnabled && result.thirdEnabled && result.fourthEnabled && result.distinct).toBe(true);
		expect(result.known?.files.map((f) => f.path)).toEqual([phase === 'accepted apply' ? A : B]);
		expect(result.inherited).toEqual(result.known); expect(result.diskRecovered).toEqual(result.known);
		expect(result.secondUndo).toEqual(result.known); expect(result.thirdUndo).toEqual(result.known);
		if (phase === 'accepted apply') expect(result.diskBefore).toBeNull();
		else expect((result.diskBefore as { files: unknown[] }).files).toHaveLength(2);
		expect(result.aBeforeUndo).toBe(phase === 'accepted apply' ? AFTER : BEFORE);
		expect(result.bBeforeUndo).toBe(phase === 'accepted apply' ? BEFORE : AFTER);
		expect(result.aRestored).toBe(BEFORE); expect(result.bRestored).toBe(BEFORE);
		expect(result.savedAlias).toBe('MMM D'); expect(result.savedUndo).toEqual([B]);
		expect(result.diskFinal.alias).toBe('MMM D'); expect(result.diskFinal.undo).toBeNull();
		console.log('TASK_UNDO_SAVE_RECOVERY ' + JSON.stringify({ phase, result }));
	});
}
