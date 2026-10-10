import { browser } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { pluginId } from './load';

// Helpers shared by the real-app checks of Task Date Links. The Tasks plugin is installed but off; tasksOn turns it on.
export const DIR = 'Task Date Links';
export const TASKS = 'obsidian-tasks-plugin';

interface Plugins {
	enabledPlugins: Set<string>;
	plugins: Record<string, { apiV1?: unknown }>;
	enablePluginAndSave(id: string): Promise<void>;
	disablePluginAndSave(id: string): Promise<void>;
}

/** Turns the Tasks plugin on and waits until its API and its editor suggest (its settings) are there. Returns today as YYYY-MM-DD. */
export async function tasksOn(): Promise<string> {
	return browser.executeObsidian(async ({ app }, id) => {
		const plugins = (app as unknown as { plugins: Plugins }).plugins;
		await plugins.enablePluginAndSave(id);
		for (let i = 0; i < 100; i++) {
			const ws = app.workspace as unknown as { editorSuggest?: { suggests?: { settings?: { taskFormat?: unknown } }[] } };
			if (plugins.plugins[id]?.apiV1 && ws.editorSuggest?.suggests?.some((x) => x.settings?.taskFormat)) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		return (window as unknown as { moment: () => { format(f: string): string } }).moment().format('YYYY-MM-DD');
	}, TASKS);
}

export async function tasksOff(): Promise<void> {
	await browser.executeObsidian(async ({ app }, id) => (app as unknown as { plugins: Plugins }).plugins.disablePluginAndSave(id), TASKS);
}

export async function momentFormat(offsetDays: number, format: string): Promise<string> {
	return browser.executeObsidian((_o, n, f) => (window as unknown as { moment: () => { add(n: number, u: string): { format(f: string): string } } }).moment().add(n, 'days').format(f), offsetDays, format);
}

export async function readFile(path: string): Promise<string> {
	return browser.executeObsidian(async ({ app }, p) => app.vault.read(app.vault.getFileByPath(p)!), path);
}

/** Creates or replaces a note. */
export async function writeFile(path: string, text: string): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, p, t) => {
			const f = app.vault.getFileByPath(p);
			if (f) await app.vault.modify(f, t);
			else await app.vault.create(p, t);
		},
		path,
		text,
	);
}

/** Waits until the text of the note satisfies the check. */
export async function waitFile(path: string, ok: (text: string) => boolean, msg: string, timeout = 15000): Promise<string> {
	let last = '';
	await browser.waitUntil(
		async () => {
			last = await readFile(path);
			return ok(last);
		},
		{ timeout, interval: 250, timeoutMsg: `${msg}; the note holds ${JSON.stringify(last)}` },
	);
	return last;
}

/** Waits a moment and checks the note did not change: used to prove the plugin leaves a note alone. */
export async function settled(path: string, ms = 2500): Promise<string> {
	await browser.pause(ms);
	return readFile(path);
}

/** Opens the note in the editor, puts the cursor on the line and runs the Tasks command "Toggle task done". */
export async function toggleLine(path: string, line: number): Promise<void> {
	await obsidianPage.openFile(path);
	await browser.executeObsidian(
		async ({ app }, n) => {
			const view = app.workspace.activeEditor;
			if (!view?.editor) throw new Error('no editor in the active tab');
			view.editor.setCursor({ line: n, ch: 0 });
			const commands = (app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands;
			if (!commands.executeCommandById('obsidian-tasks-plugin:toggle-done')) throw new Error('the Tasks command did not run');
			await Promise.resolve();
		},
		line,
	);
}

/** What the Tasks plugin does with a task line: its own toggle, called on the text. */
export async function tasksToggle(line: string, path: string): Promise<string> {
	return browser.executeObsidian(({ app }, l, p, id) => {
		const plugin = (app as unknown as { plugins: { plugins: Record<string, { apiV1: { executeToggleTaskDoneCommand(l: string, p: string): string } }> } }).plugins.plugins[id]!;
		return plugin.apiV1.executeToggleTaskDoneCommand(l, p);
	}, line, path, TASKS);
}

/** Changes settings of the plugin the way the settings tab does. */
export async function setSettings(patch: Record<string, unknown>): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, id, p) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { settings: Record<string, unknown>; saveSettings(): Promise<void>; settingsChanged(): void }> } }).plugins.plugins[id]!;
			plugin.settings = { ...plugin.settings, ...(p as Record<string, unknown>) };
			plugin.settingsChanged();
			await plugin.saveSettings();
		},
		pluginId,
		patch,
	);
}

/** Pro on: a stubbed GitHub Sponsors reply ($5 a month) and a fake token, then Refresh. Pro off: sign out. No real request. */
export async function setPro(on: boolean): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, id, value) => {
			interface Pro {
				opts: { http: unknown };
				refreshNow(): Promise<void>;
				signOut(): void;
				isPro(): boolean;
			}
			const p = (app as unknown as { plugins: { plugins: Record<string, { pro: Pro }> } }).plugins.plugins[id]!;
			if (!value) {
				p.pro.signOut();
				return;
			}
			const reply = { status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } };
			p.pro.opts.http = () => Promise.resolve(reply);
			// A sign out just before can still be clearing the stored token, so set it again until the check passes.
			for (let i = 0; i < 20 && !p.pro.isPro(); i++) {
				app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36));
				await p.pro.refreshNow();
				if (!p.pro.isPro()) await new Promise((r) => setTimeout(r, 100));
			}
			if (!p.pro.isPro()) throw new Error('Pro did not turn on with the stubbed sponsor reply');
		},
		pluginId,
		on,
	);
}

/** Text of every notice on screen. */
export async function notices(): Promise<string[]> {
	return browser.execute(() => Array.from(document.querySelectorAll('.notice')).map((n) => n.textContent ?? ''));
}

/** Clicks the button of the preview window by its label. */
export async function clickPreview(label: string): Promise<void> {
	const b = await browser.$(`//div[contains(@class,"task-date-links-preview")]//button[normalize-space()="${label}"]`);
	await b.waitForDisplayed({ timeout: 8000 });
	await b.click();
}

/** Runs a command of this plugin. */
export async function run(command: string): Promise<void> {
	await browser.executeObsidianCommand(`${pluginId}:${command}`);
}

/** Closes every open window of the app with Escape, so one failed check does not leave a preview open for the next. */
export async function closeModals(): Promise<void> {
	for (let i = 0; i < 12 && (await browser.$$('.modal-container').length) > 0; i++) {
		await browser.keys('Escape');
		await browser.pause(150);
	}
}
