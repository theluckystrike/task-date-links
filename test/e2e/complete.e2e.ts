import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { DIR, momentFormat, readFile, setSettings, settled, tasksOff, tasksOn, tasksToggle, toggleLine, waitFile, writeFile } from './helpers';
import { pluginId } from './load';

// The real Tasks plugin completes the task; Task Date Links adds the link after it. Every check reads the note text back.
describe(`${pluginId} with the Tasks plugin`, function () {
	let today = '';

	before(async function () {
		today = await tasksOn();
		expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	afterEach(async function () {
		await setSettings({ auto: true, unlink: true });
	});

	after(async function () {
		await tasksOff();
	});

	it('completing a task with Tasks adds the daily link before the done date, and Tasks still reads the line', async function () {
		const f = `${DIR}/c-basic.md`;
		const rest = '- [ ] Send invoice ⏫ 📅 2026-10-14 ^inv\n- [ ] Plan the week [due:: 2026-10-15]\n';
		await writeFile(f, `- [ ] Buy milk\n${rest}`);
		await toggleLine(f, 0);
		const text = await waitFile(f, (t) => t.includes(`[[${today}]]`), 'no link after the Tasks toggle');
		expect(text).toBe(`- [x] Buy milk [[${today}]] ✅ ${today}\n${rest}`);
		// Tasks reads the done date after the link: its own toggle gives back an open task without the date.
		const reopened = await tasksToggle(`- [x] Buy milk [[${today}]] ✅ ${today}`, f);
		expect(reopened).toBe(`- [ ] Buy milk [[${today}]]`);
	});

	it('the daily note lists the completed task in its backlinks', async function () {
		const f = `${DIR}/c-backlinks.md`;
		const daily = `${DIR}/${today}.md`;
		await writeFile(daily, `# ${today}\n`);
		await writeFile(f, '- [ ] Call the bank\n');
		await toggleLine(f, 0);
		await waitFile(f, (t) => t.includes(`[[${today}]]`), 'no link');
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app }, from, to) => (app.metadataCache.resolvedLinks[from] ?? {})[to] === 1, f, daily),
			{ timeout: 10000, timeoutMsg: 'the daily note has no link from the task note in resolvedLinks' },
		);
	});

	it('unchecking the task with Tasks removes the link the plugin added', async function () {
		const f = `${DIR}/c-reopen.md`;
		await writeFile(f, '- [ ] Pay rent 📅 2026-10-12\n- [ ] Keep me\n');
		await toggleLine(f, 0);
		await waitFile(f, (t) => t.includes(`[[${today}]]`), 'no link');
		await toggleLine(f, 0);
		const text = await waitFile(f, (t) => !t.includes('[x]') && !t.includes('[['), 'the task is still linked or checked after the uncheck');
		expect(text).toBe('- [ ] Pay rent 📅 2026-10-12\n- [ ] Keep me\n');
	});

	it('a recurring task: the new open copy has no link and the finished copy has one', async function () {
		const f = `${DIR}/c-recur.md`;
		const tomorrow = await momentFormat(1, 'YYYY-MM-DD');
		await writeFile(f, `- [ ] Water plants 🔁 every day 📅 ${today}\n`);
		await toggleLine(f, 0);
		const text = await waitFile(f, (t) => t.includes(`[[${today}]]`), 'no link on the finished copy');
		const lines = text.trimEnd().split('\n');
		expect(lines).toHaveLength(2);
		expect(lines).toContain(`- [ ] Water plants 🔁 every day 📅 ${tomorrow}`);
		expect(lines).toContain(`- [x] Water plants [[${today}]] 🔁 every day 📅 ${today} ✅ ${today}`);
		// The new copy completes tomorrow; completing it again today must not stack links on the first one.
		expect(text.split(`[[${today}]]`)).toHaveLength(2);
	});

	it('emoji fields, a block id and a done task with several fields keep their order', async function () {
		const f = `${DIR}/c-fields.md`;
		await writeFile(f, '- [ ] Book venue ➕ 2026-10-05 🛫 2026-10-08 ⏳ 2026-10-09 📅 2026-10-12 ^venue\n');
		await toggleLine(f, 0);
		const text = await waitFile(f, (t) => t.includes(`[[${today}]]`), 'no link');
		expect(text).toBe(`- [x] Book venue [[${today}]] ➕ 2026-10-05 🛫 2026-10-08 ⏳ 2026-10-09 📅 2026-10-12 ✅ ${today} ^venue\n`);
		const back = await tasksToggle(text.trimEnd(), f);
		expect(back).toContain('📅 2026-10-12');
		expect(back).not.toContain('✅');
	});

	it('does nothing when the setting is off, and links nothing without a done date', async function () {
		const f = `${DIR}/c-off.md`;
		await setSettings({ auto: false });
		await writeFile(f, '- [ ] Quiet task\n- [x] Checked by hand\n');
		await toggleLine(f, 0);
		await waitFile(f, (t) => t.includes('✅'), 'Tasks wrote no done date');
		const text = await settled(f);
		expect(text).toBe(`- [x] Quiet task ✅ ${today}\n- [x] Checked by hand\n`);
	});

	it('leaves a note alone when its property task-date-links is false', async function () {
		const f = `${DIR}/c-property.md`;
		await writeFile(f, '---\ntask-date-links: false\n---\n- [ ] Private task\n');
		await toggleLine(f, 3);
		await waitFile(f, (t) => t.includes('✅'), 'Tasks wrote no done date');
		expect(await settled(f)).toBe(`---\ntask-date-links: false\n---\n- [x] Private task ✅ ${today}\n`);
	});

	it('a link that the user deletes stays deleted', async function () {
		const f = `${DIR}/c-deleted.md`;
		await writeFile(f, '- [ ] Order cake\n');
		await toggleLine(f, 0);
		await waitFile(f, (t) => t.includes(`[[${today}]]`), 'no link');
		await obsidianPage.openFile(`${DIR}/Reading list.md`);
		await writeFile(f, `- [x] Order cake ✅ ${today}\n`);
		expect(await settled(f)).toBe(`- [x] Order cake ✅ ${today}\n`);
	});

	it('Windows line endings stay when the plugin writes', async function () {
		const f = `${DIR}/c-crlf.md`;
		await obsidianPage.openFile(`${DIR}/Reading list.md`);
		await writeFile(f, '# List\r\n\r\n- [ ] First\r\n- [ ] Second\r\n');
		const done = await tasksToggle('- [ ] First', f);
		expect(done).toBe(`- [x] First ✅ ${today}`);
		await writeFile(f, `# List\r\n\r\n${done}\r\n- [ ] Second\r\n`);
		const text = await waitFile(f, (t) => t.includes(`[[${today}]]`), 'no link in the CRLF note');
		expect(text).toBe(`# List\r\n\r\n- [x] First [[${today}]] ✅ ${today}\r\n- [ ] Second\r\n`);
	});

	it('works for a done date that was typed by hand, with the Tasks plugin off', async function () {
		await tasksOff();
		const f = `${DIR}/c-manual.md`;
		await writeFile(f, `- [x] Typed by hand ✅ ${today}\n`);
		await waitFile(f, (t) => t.includes(`[[${today}]]`), 'no link without the Tasks plugin');
		expect(await readFile(f)).toBe(`- [x] Typed by hand [[${today}]] ✅ ${today}\n`);
		await tasksOn();
	});
});
