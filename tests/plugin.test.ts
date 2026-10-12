import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import TaskDateLinksPlugin from '../src/main';
import { SPONSORS, bindPro, isPro, onProChange, resetPro } from '../src/pro';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';
import manifest from '../manifest.json';

afterEach(() => resetPro());

/** A stand-in for the SponsorsManager: only isPro and onChange, which the facade uses. */
function fakeManager(start: boolean) {
	let pro = start;
	const fns = new Set<() => void>();
	return {
		isPro: () => pro,
		onChange: (fn: () => void) => {
			fns.add(fn);
			return () => fns.delete(fn);
		},
		set(v: boolean) {
			pro = v;
			for (const fn of fns) fn();
		},
		listeners: () => fns.size,
	};
}

describe('settings', () => {
	it('loads with default settings against an in-memory vault', async () => {
		const app = App.createConfigured__({ files: { 'Tasks.md': '- [x] Buy milk ✅ 2026-10-10' } });
		const plugin = new TaskDateLinksPlugin(app as never, manifest as never);
		await plugin.loadSettings();
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(isPro()).toBe(false);
	});

	it('repairs bad saved settings', () => {
		expect(normalizeSettings({ auto: 'yes' as never, format: 5 as never, undo: 'x' as never })).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ auto: false, format: 'DD.MM.YYYY', linkDue: true })).toMatchObject({ auto: false, format: 'DD.MM.YYYY', linkDue: true, linkStart: false });
	});

	it('caps the length of saved text', () => {
		expect(normalizeSettings({ onlyFolders: 'a'.repeat(5000) }).onlyFolders.length).toBe(2000);
	});
});

describe('daily note folder', () => {
	function pluginWithCore(options: unknown) {
		const app = App.createConfigured__({ files: {} });
		Object.defineProperty(app, 'internalPlugins', { value: { getPluginById: () => ({ instance: { options } }) } });
		return new TaskDateLinksPlugin(app as never, manifest as never);
	}

	it('uses the core folder and date format without Pro', () => {
		const plugin = pluginWithCore({ folder: 'Journal/Daily', format: 'DD-MM-YYYY' });
		expect(isPro()).toBe(false);
		expect(plugin.exampleLink()).toBe('[[Journal/Daily/10-10-2026|10-10-2026]]');
	});

	it('uses an explicit folder and alias instead of the core folder', () => {
		const plugin = pluginWithCore({ folder: 'Daily', format: 'YYYY-MM-DD' });
		plugin.settings.dailyFolder = 'Work\\Journal/';
		plugin.settings.alias = 'MMM D';
		expect(plugin.exampleLink()).toBe('[[Work/Journal/2026-10-10|Oct 10]]');
	});

	it('uses a slash to override the core folder with the vault root', () => {
		const plugin = pluginWithCore({ folder: 'Daily' });
		plugin.settings.dailyFolder = '/';
		expect(plugin.exampleLink()).toBe('[[2026-10-10]]');
	});

	it('keeps the old output when the core options are absent or malformed', () => {
		for (const options of [undefined, null, { folder: 1, format: [] }]) {
			expect(pluginWithCore(options).exampleLink()).toBe('[[2026-10-10]]');
		}
	});

	it('does not fail when the core plugin getter throws', () => {
		const app = App.createConfigured__({ files: {} });
		Object.defineProperty(app, 'internalPlugins', { value: { getPluginById: () => { throw new Error('unavailable'); } } });
		expect(new TaskDateLinksPlugin(app as never, manifest as never).exampleLink()).toBe('[[2026-10-10]]');
	});
});

describe('pro facade', () => {
	it('is off with no manager', () => {
		expect(isPro()).toBe(false);
	});

	it('follows the GitHub Sponsors manager and tells listeners on each change', () => {
		const m = fakeManager(false);
		bindPro(m as never);
		const cb = vi.fn();
		const off = onProChange(cb);
		m.set(true);
		expect(isPro()).toBe(true);
		expect(cb).toHaveBeenCalledTimes(1);
		off();
		m.set(false);
		expect(cb).toHaveBeenCalledTimes(1);
		expect(isPro()).toBe(false);
	});

	it('reset unbinds the manager', () => {
		const m = fakeManager(true);
		bindPro(m as never);
		expect(m.listeners()).toBe(1);
		resetPro();
		expect(m.listeners()).toBe(0);
		expect(isPro()).toBe(false);
	});

	it('uses the sponsor values of the seller', () => {
		expect(SPONSORS.sponsorLogin).toBe('theluckystrike');
		expect(SPONSORS.minMonthlyUsd).toBe(5);
		expect(SPONSORS.oneTimeUsd).toBe(15);
		expect(SPONSORS.scope).toBe('read:user');
	});
});
