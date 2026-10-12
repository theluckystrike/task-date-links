import { describe, expect, it } from 'vitest';
import { reconcile, type ReconcileOptions } from '../src/reconcile';
import { toOptions } from './spec-options';

const opts = (unlink = true): ReconcileOptions => ({ ...toOptions({ window: ['2026-10-09', '2026-10-10'] }), unlink });

describe('reconcile', () => {
	it('links a task that was just finished and remembers it', () => {
		const r = reconcile('- [x] Buy milk ✅ 2026-10-10\n', undefined, opts());
		expect(r.text).toBe('- [x] Buy milk [[2026-10-10]] ✅ 2026-10-10\n');
		expect(r.memo.size).toBe(1);
		expect([...r.memo.values()][0]?.targets).toEqual(['2026-10-10']);
	});

	it('does not touch a done task that is older than the window', () => {
		const r = reconcile('- [x] Old ✅ 2026-08-01\n', undefined, opts());
		expect(r.changes).toEqual([]);
		expect(r.text).toBe('- [x] Old ✅ 2026-08-01\n');
	});

	it('does not link a seen task again after the user deleted the link', () => {
		const first = reconcile('- [x] Buy milk ✅ 2026-10-10\n', undefined, opts());
		const second = reconcile('- [x] Buy milk ✅ 2026-10-10\n', first.memo, opts());
		expect(second.changes).toEqual([]);
	});

	it('links a task that was open before and is done now', () => {
		const first = reconcile('- [ ] Buy milk\n- [x] Sell car ✅ 2026-10-10\n', undefined, opts());
		const second = reconcile('- [x] Buy milk ✅ 2026-10-10\n- [x] Sell car [[2026-10-10]] ✅ 2026-10-10\n', first.memo, opts());
		expect(second.text).toBe('- [x] Buy milk [[2026-10-10]] ✅ 2026-10-10\n- [x] Sell car [[2026-10-10]] ✅ 2026-10-10\n');
		expect(second.changes.map((c) => c.line)).toEqual([0]);
	});

	it('removes the links it added when the task is reopened', () => {
		const first = reconcile('- [x] Buy milk 📅 2026-10-12 ✅ 2026-10-10 ^b1\n', undefined, opts());
		expect(first.text).toBe('- [x] Buy milk [[2026-10-10]] 📅 2026-10-12 ✅ 2026-10-10 ^b1\n');
		// The Tasks plugin removes the done date and unchecks the box.
		const second = reconcile('- [ ] Buy milk [[2026-10-10]] 📅 2026-10-12 ^b1\n', first.memo, opts());
		expect(second.text).toBe('- [ ] Buy milk 📅 2026-10-12 ^b1\n');
		expect(second.memo.size).toBe(0);
	});

	it('keeps a link the user typed when the task is reopened', () => {
		const first = reconcile('- [x] Buy milk [[2026-10-10]] ✅ 2026-10-10\n', undefined, opts());
		const second = reconcile('- [ ] Buy milk [[2026-10-10]]\n', first.memo, opts());
		expect(second.changes).toEqual([]);
	});

	it('does not remove links when unlink is off', () => {
		const first = reconcile('- [x] Buy milk ✅ 2026-10-10\n', undefined, opts(false));
		const second = reconcile('- [ ] Buy milk [[2026-10-10]]\n', first.memo, opts(false));
		expect(second.changes).toEqual([]);
	});

	it('leaves the new open copy of a recurring task alone and links only the finished one', () => {
		const first = reconcile('- [ ] Water plants 🔁 every day 📅 2026-10-10\n', undefined, opts());
		expect(first.changes).toEqual([]);
		const after = '- [ ] Water plants 🔁 every day 📅 2026-10-11\n- [x] Water plants 🔁 every day 📅 2026-10-10 ✅ 2026-10-10\n';
		const second = reconcile(after, first.memo, opts());
		expect(second.text).toBe('- [ ] Water plants 🔁 every day 📅 2026-10-11\n- [x] Water plants [[2026-10-10]] 🔁 every day 📅 2026-10-10 ✅ 2026-10-10\n');
	});

	it('reopens only the line that holds the link when two lines share a description', () => {
		const first = reconcile('- [ ] Water plants\n- [x] Water plants ✅ 2026-10-10\n', undefined, opts());
		const second = reconcile('- [ ] Water plants\n- [ ] Water plants [[2026-10-10]]\n', first.memo, opts());
		expect(second.text).toBe('- [ ] Water plants\n- [ ] Water plants\n');
	});

	it('keeps Windows line endings when it removes a link', () => {
		const first = reconcile('- [x] A ✅ 2026-10-10\r\n', undefined, opts());
		const second = reconcile('- [ ] A [[2026-10-10]]\r\n', first.memo, opts());
		expect(second.text).toBe('- [ ] A\r\n');
	});

	it('removes only its full folder link when the task is reopened', () => {
		const folderOpts = { ...opts(), linksFor: () => [{ target: 'Daily/2026-10-10', text: '[[Daily/2026-10-10|Oct 10]]' }] };
		const first = reconcile('- [x] A [[Other/2026-10-10]] ✅ 2026-10-10', undefined, folderOpts);
		expect(first.text).toBe('- [x] A [[Other/2026-10-10]] [[Daily/2026-10-10|Oct 10]] ✅ 2026-10-10');
		const second = reconcile('- [ ] A [[Other/2026-10-10]] [[Daily/2026-10-10|Oct 10]]', first.memo, folderOpts);
		expect(second.text).toBe('- [ ] A [[Other/2026-10-10]]');
	});

	it('is stable: a second run over its own output changes nothing', () => {
		const text = '- [x] A ✅ 2026-10-10\n- [x] B ✅ 2026-10-09\n- [ ] C\n';
		const r1 = reconcile(text, undefined, opts());
		const r2 = reconcile(r1.text, r1.memo, opts());
		const r3 = reconcile(r1.text, undefined, opts());
		expect(r2.changes).toEqual([]);
		expect(r3.changes).toEqual([]);
	});
});
