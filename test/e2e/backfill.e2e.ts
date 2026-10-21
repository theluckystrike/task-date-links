import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { DIR, clickPreview, closeModals, notices, readFile, run, setPro, setSettings, waitFile, writeFile } from './helpers';
import { pluginId } from './load';

const OLD = `${DIR}/Old tasks.md`;
const READING = `${DIR}/Reading list.md`;

/** Waits for the preview window and returns its summary line. */
async function previewSummary(): Promise<string> {
	const el = await browser.$('.task-date-links-preview .task-date-links-summary');
	await el.waitForDisplayed({ timeout: 8000 });
	return el.getText();
}

describe(`${pluginId} back-fill`, function () {
	let oldText = '';
	let readingText = '';

	before(async function () {
		oldText = await readFile(OLD);
		readingText = await readFile(READING);
		await setSettings({ auto: true });
	});

	afterEach(async function () {
		await closeModals();
		await setPro(false);
		await setSettings({ onlyFolders: '', ignoreFolders: '', weekly: false, monthly: false, linkDue: false, linkStart: false, alias: '', dailyFolder: '' });
		await writeFile(OLD, oldText);
		await writeFile(READING, readingText);
	});

	it('links the done dates of the current note after a preview, and one undo puts every line back', async function () {
		await obsidianPage.openFile(OLD);
		await run('link-done-dates-note');
		expect(await previewSummary()).toBe('4 tasks in 1 note will get a link.');
		expect(await readFile(OLD)).toBe(oldText);
		await clickPreview('Link the dates');
		const text = await waitFile(OLD, (t) => t.includes('[[2026-09-12]]'), 'the back-fill did not write');
		expect(text).toBe(
			[
				'Finished tasks from before the plugin. The back-fill command links them.',
				'',
				'- [x] Plan the offsite [[2026-09-12]] 🔼 ✅ 2026-09-12',
				'- [x] Book the hotel [[2026-09-14]] ✅ 2026-09-14 ^hotel',
				'- [x] Send the agenda [[2026-09-19]] [due:: 2026-09-20] [completion:: 2026-09-19]',
				'- [x] Collect the receipts [[2026-09-30]] 🔁 every month 📅 2026-09-30 ✅ 2026-09-30',
				'- [ ] Write the offsite recap',
				'',
			].join('\n'),
		);
		await run('undo-backfill');
		await waitFile(OLD, (t) => t === oldText, 'one undo did not restore the note');
		// Note bytes settle before saveSettings finishes and shows the command's notice.
		await browser.waitUntil(async () => (await notices()).some((n) => n.includes('Undid 4 lines')), { timeout: 5000, timeoutMsg: 'undo did not finish with its notice' });
		expect((await notices()).join('|')).toContain('Undid 4 lines');
	});

	it('cancel in the preview changes nothing', async function () {
		await obsidianPage.openFile(OLD);
		await run('link-done-dates-note');
		await previewSummary();
		await clickPreview('Cancel');
		expect(await readFile(OLD)).toBe(oldText);
	});

	it('back-fill shows the folder target before it writes and one undo restores the task', async function () {
		await setSettings({ dailyFolder: 'Journal/Daily' });
		await obsidianPage.openFile(OLD);
		await run('link-done-dates-note');
		expect(await previewSummary()).toBe('4 tasks in 1 note will get a link.');
		expect(await browser.$('.task-date-links-preview').getText()).toContain('[[Journal/Daily/2026-09-12|2026-09-12]]');
		expect(await readFile(OLD)).toBe(oldText);
		await clickPreview('Link the dates');
		await waitFile(OLD, (t) => t.includes('[[Journal/Daily/2026-09-12|2026-09-12]]'), 'the folder back-fill did not write');
		await run('undo-backfill');
		await waitFile(OLD, (t) => t === oldText, 'undo did not restore the folder back-fill');
	});

	it('a note with nothing to link shows a notice and no preview', async function () {
		await writeFile(OLD, '- [ ] Open task\n- [x] Linked [[2026-09-12]] ✅ 2026-09-12\n');
		await obsidianPage.openFile(OLD);
		await run('link-done-dates-note');
		await browser.waitUntil(async () => (await notices()).some((n) => n.includes('No done dates to link.')), { timeout: 5000, timeoutMsg: 'no notice' });
		expect(await browser.$$('.task-date-links-preview').length).toBe(0);
	});

	it('links only the selected lines', async function () {
		await obsidianPage.openFile(OLD);
		await browser.executeObsidian(({ app }) => {
			// Lines 2 and 3 (zero based) are the first two done tasks.
			app.workspace.activeEditor!.editor!.setSelection({ line: 2, ch: 0 }, { line: 3, ch: 5 });
		});
		await run('link-done-dates-selection');
		expect(await previewSummary()).toBe('2 tasks in 1 note will get a link.');
		await clickPreview('Link the dates');
		const text = await waitFile(OLD, (t) => t.includes('[[2026-09-14]]'), 'the selection back-fill did not write');
		expect(text).toContain('- [x] Plan the offsite [[2026-09-12]] 🔼 ✅ 2026-09-12\n- [x] Book the hotel [[2026-09-14]] ✅ 2026-09-14 ^hotel\n- [x] Send the agenda [due:: 2026-09-20]');
		await run('undo-backfill');
		await waitFile(OLD, (t) => t === oldText, 'undo did not restore the note');
	});

	it('the whole vault needs Pro; with Pro it previews both notes, applies, and one undo restores both', async function () {
		await run('link-done-dates-vault');
		await browser.waitUntil(async () => (await notices()).some((n) => n.includes('pro feature')), { timeout: 5000, timeoutMsg: 'no Pro notice' });
		expect(await readFile(OLD)).toBe(oldText);
		await setPro(true);
		await run('link-done-dates-vault');
		const summary = await previewSummary();
		expect(summary).toMatch(/^\d+ tasks in \d+ notes will get a link\.$/);
		await clickPreview('Link the dates');
		await waitFile(READING, (t) => t.includes('[[2026-08-02]]'), 'the vault back-fill did not write the reading list');
		expect(await readFile(READING)).toContain('- [x] Read the paper on queues [[2026-08-20]] ⏫ ✅ 2026-08-20');
		expect(await readFile(OLD)).toContain('[[2026-09-12]]');
		await run('undo-backfill');
		await waitFile(READING, (t) => t === readingText, 'undo did not restore the reading list');
		await waitFile(OLD, (t) => t === oldText, 'undo did not restore the old tasks');
	});

	it('pro: other dates, weekly and monthly links, and an alias use the moment formats of Obsidian', async function () {
		await setPro(true);
		await setSettings({ linkDue: true, weekly: true, monthly: true, alias: 'MMM D' });
		await writeFile(OLD, '- [x] Pay rent 📅 2026-10-12 ✅ 2026-10-10\n');
		await obsidianPage.openFile(OLD);
		await run('link-done-dates-note');
		await previewSummary();
		await clickPreview('Link the dates');
		const text = await waitFile(OLD, (t) => t.includes('[['), 'no link written');
		expect(text).toBe('- [x] Pay rent [[2026-10-12|Oct 12]] [[2026-W42]] [[2026-10]] [[2026-10-10|Oct 10]] [[2026-W41]] 📅 2026-10-12 ✅ 2026-10-10\n');
	});

	it('pro: folder rules skip a folder for the back-fill', async function () {
		await setPro(true);
		await setSettings({ ignoreFolders: DIR });
		await obsidianPage.openFile(OLD);
		await run('link-done-dates-note');
		await browser.waitUntil(async () => (await notices()).some((n) => n.includes('folder rules')), { timeout: 5000, timeoutMsg: 'no folder rule notice' });
		expect(await readFile(OLD)).toBe(oldText);
	});
});
