// The preview of a back-fill: which lines would get a link, with the new links marked, and one button to apply.
import { Modal, Setting, type App } from 'obsidian';
import type { Change } from './links';

export interface PreviewFile {
	path: string;
	changes: Change[];
}

/** Most changes the preview lists. The count in the summary is always the full number, and a line under the list says how many are not shown. */
export const PREVIEW_MAX = 40;

/** Splits a changed line into the text before the new links, the new links, and the text after them. */
export function splitAdded(before: string, after: string): [string, string, string] {
	let p = 0;
	while (p < before.length && p < after.length && before[p] === after[p]) p++;
	let s = 0;
	while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
	return [after.slice(0, p), after.slice(p, after.length - s), after.slice(after.length - s)];
}

/** The summary line: how many tasks in how many notes. */
export function summarize(files: readonly PreviewFile[]): string {
	const tasks = files.reduce((n, f) => n + f.changes.length, 0);
	const task = tasks === 1 ? '1 task' : `${tasks} tasks`;
	return `${task} in ${files.length === 1 ? '1 note' : `${files.length} notes`} will get a link.`;
}

/** The sentence about the notes that the property `task-date-links: false` keeps out of a back-fill; '' when there are none. */
export function skippedText(skipped: number): string {
	if (skipped <= 0) return '';
	return `Skipped ${skipped === 1 ? '1 note' : `${skipped} notes`} with the property "task-date-links: false".`;
}

/** The line under the list when the preview does not show every change; '' when it shows them all. */
export function moreText(total: number): string {
	const more = total - PREVIEW_MAX;
	if (more <= 0) return '';
	return `And ${more === 1 ? '1 more line' : `${more} more lines`} that this window does not show.`;
}

export class PreviewModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly files: readonly PreviewFile[],
		private readonly onApply: () => Promise<void>,
		/** How many notes the property keeps out of this back-fill. */
		private readonly skipped = 0,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('task-date-links-preview');
		this.setTitle(this.title);
		contentEl.createEl('p', { text: summarize(this.files), cls: 'task-date-links-summary' });
		if (this.skipped > 0) contentEl.createEl('p', { text: skippedText(this.skipped), cls: 'task-date-links-skipped' });
		const list = contentEl.createDiv({ cls: 'task-date-links-list' });
		let shown = 0;
		for (const f of this.files) {
			for (const c of f.changes) {
				if (shown++ >= PREVIEW_MAX) break;
				this.addRow(list, f.path, c);
			}
		}
		const total = this.files.reduce((n, f) => n + f.changes.length, 0);
		if (total > PREVIEW_MAX) contentEl.createEl('p', { text: moreText(total), cls: 'task-date-links-more' });
		contentEl.createEl('p', { text: 'To put the lines back, use the undo command of this plugin.', cls: 'task-date-links-hint' });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Link the dates').setCta().onClick(() => void this.apply()))
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private addRow(list: HTMLElement, path: string, c: Change): void {
		const row = list.createDiv({ cls: 'task-date-links-row' });
		row.createDiv({ text: `${path}, line ${c.line + 1}`, cls: 'task-date-links-where' });
		const [head, added, tail] = splitAdded(c.before, c.after);
		const line = row.createDiv({ cls: 'task-date-links-line' });
		line.createSpan({ text: head });
		line.createSpan({ text: added, cls: 'task-date-links-added' });
		line.createSpan({ text: tail });
	}

	private async apply(): Promise<void> {
		this.close();
		await this.onApply();
	}
}
