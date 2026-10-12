// Defects found in the a33 audit. Each test failed before its fix.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Notice } from 'obsidian-test-mocks/obsidian';
import TaskDateLinksPlugin from '../src/main';
import { linkText, taskableLines } from '../src/links';
import { buildLinksFor } from '../src/options';
import { PreviewModal } from '../src/preview';
import { bindPro, resetPro } from '../src/pro';
import manifest from '../manifest.json';
import { fmt } from './fmt';

afterEach(() => {
	resetPro();
	vi.restoreAllMocks();
});

const opts = {
	kinds: ['done' as const],
	linksFor: buildLinksFor(fmt, { format: 'YYYY-MM-DD', alias: '', weekly: false, weeklyFormat: '', monthly: false, monthlyFormat: '' }),
	window: null,
};

describe('code fences inside a callout or a list item', () => {
	it('skips a fence in a callout or a quote', () => {
		const text = ['> [!example]', '> ```md', '> - [x] Sample ✅ 2026-10-10', '> ```', '> - [x] Real ✅ 2026-10-10'].join('\n');
		expect(taskableLines(text.split('\n'))).toEqual([true, false, false, false, true]);
		expect(linkText(text, opts).changes.map((c) => c.line)).toEqual([4]);
	});
	it('skips a fence that is indented under a list item', () => {
		const text = ['- Notes', '    ```', '    - [x] Sample ✅ 2026-10-10', '    ```', '- [x] Real ✅ 2026-10-10'].join('\n');
		expect(linkText(text, opts).changes.map((c) => c.line)).toEqual([4]);
	});
	it('ends a callout fence when the callout ends', () => {
		const text = ['> ```', '> code', '', '- [x] Real ✅ 2026-10-10'].join('\n');
		expect(linkText(text, opts).changes.map((c) => c.line)).toEqual([3]);
	});
});

describe('back-fill when a note goes away while the preview is open', () => {
	it('links the other notes, keeps the undo of the notes that changed and tells the user', async () => {
		const app = App.createConfigured__({ files: { 'A.md': '- [x] A ✅ 2026-09-12\n', 'B.md': '- [x] B ✅ 2026-09-12\n' } });
		const notices: string[] = [];
		const modals: PreviewModal[] = [];
		vi.spyOn(Notice.prototype, 'constructor__').mockImplementation((m) => {
			notices.push(String(m));
		});
		vi.spyOn(PreviewModal.prototype, 'open').mockImplementation(function (this: PreviewModal) {
			modals.push(this);
		});
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const plugin = new TaskDateLinksPlugin(app as never, manifest as never);
		await plugin.onload();
		bindPro({ isPro: () => true, onChange: () => () => undefined } as never);
		const cmd = (plugin as unknown as { commands__: Map<string, { callback?: () => void }> }).commands__.get('link-done-dates-vault');
		cmd?.callback?.();
		await vi.waitFor(() => expect(modals.length).toBe(1));
		const process = app.vault.process.bind(app.vault);
		vi.spyOn(app.vault, 'process').mockImplementation(async (f, fn) => {
			if (f.path === 'B.md') throw new Error('ENOENT');
			return process(f, fn);
		});
		await (modals[0] as unknown as { onApply(): Promise<void> }).onApply();
		const a = app.vault.getFileByPath('A.md');
		if (!a) throw new Error('no A.md');
		expect(await app.vault.read(a)).toBe('- [x] A [[2026-09-12]] ✅ 2026-09-12\n');
		expect(plugin.settings.undo?.files.map((f) => f.path)).toEqual(['A.md']);
		expect(notices[notices.length - 1]).toContain('Linked 1 done date in 1 note.');
		expect(notices[notices.length - 1]).toContain('1 note could not be changed');
		plugin.onunload();
	});
});
