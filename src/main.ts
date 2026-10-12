import { Notice, Plugin, normalizePath, type CachedMetadata, type Editor, type TFile } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { SPONSORS, bindPro, isPro, resetPro } from './pro';
import { DEFAULT_SETTINGS, TaskDateLinksSettingTab, normalizeSettings, type TaskDateLinksSettings } from './settings';
import { linkText, type Kind, type LineRange, type LinkOptions } from './links';
import { FALLBACK_FORMAT, buildLinksFor, folderAllowed, optedOut, recentWindow, splitFolders, type LinkConfig } from './options';
import { reconcile, type FileMemo, type ReconcileOptions } from './reconcile';
import { PreviewModal, skippedText, type PreviewFile } from './preview';
import { formatIso, todayIso } from './moment';
import { undoEdits, type UndoFile } from './undo';

/** How often to ask the license state whether a check is due. It sends a request only when signed in and due (7 days). */
const PRO_TICK_MS = 6 * 60 * 60 * 1000;
/** Wait after a note changed before the plugin reads it, so the Tasks plugin has finished its own write. */
const SETTLE_MS = 250;
/** A finished task counts as just finished when its done date is today or this many days before. */
const RECENT_DAYS = 1;
/** Most notes the memo keeps. The oldest one goes first. */
const MEMO_MAX_FILES = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Reads a property that Obsidian does not document. A host that has no such property, or throws for it, gives undefined. */
function peek(obj: unknown, key: string): unknown {
	try {
		return isRecord(obj) ? obj[key] : undefined;
	} catch {
		return undefined;
	}
}

/** Reads a text option of the core Daily notes plugin. A host without the option gives ''. */
function coreDailyOption(app: unknown, key: 'format' | 'folder'): string {
	const internal = peek(app, 'internalPlugins');
	const getter = peek(internal, 'getPluginById');
	if (typeof getter !== 'function') return '';
	try {
		const plugin: unknown = (getter as (id: string) => unknown).call(internal, 'daily-notes');
		const format = peek(peek(peek(plugin, 'instance'), 'options'), key);
		return typeof format === 'string' ? format.trim() : '';
	} catch {
		return '';
	}
}

export default class TaskDateLinksPlugin extends Plugin {
	settings: TaskDateLinksSettings = { ...DEFAULT_SETTINGS };
	/** GitHub Sponsors Pro state. Created in onload; null before that. */
	pro: SponsorsManager | null = null;
	private settingTab: TaskDateLinksSettingTab | null = null;
	/** The finished tasks seen in each note, by path. See reconcile.ts. */
	private readonly memos = new Map<string, FileMemo>();
	private readonly timers = new Map<string, number>();

	async onload(): Promise<void> {
		await this.loadSettings();
		// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		this.register(pro.onChange(() => this.settingTab?.update()));
		this.settingTab = new TaskDateLinksSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.registerEvent(this.app.metadataCache.on('changed', (file, _data, cache) => this.onChanged(file, cache)));
		this.registerEvent(this.app.vault.on('delete', (f) => this.memos.delete(f.path)));
		this.registerEvent(this.app.vault.on('rename', (_f, old) => this.memos.delete(old)));
		this.addCommands();
		this.app.workspace.onLayoutReady(() => {
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), PRO_TICK_MS));
		});
	}

	onunload(): void {
		resetPro();
		for (const t of this.timers.values()) window.clearTimeout(t);
		this.timers.clear();
		this.memos.clear();
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings((await this.loadData()) as Partial<TaskDateLinksSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Called by the settings tab after a value changed. The memos were built with the old format, so they go. */
	settingsChanged(): void {
		this.memos.clear();
	}

	// ---- dates and options ----

	/** An ISO date in a moment format; '' when the date does not exist. */
	formatDate(iso: string, format: string): string {
		return formatIso(iso, format);
	}

	private dailyFormat(): string {
		return this.settings.format.trim() || coreDailyOption(this.app, 'format') || FALLBACK_FORMAT;
	}

	private config(): LinkConfig {
		const s = this.settings;
		const pro = isPro();
		const dailyFolder = normalizePath(s.dailyFolder.trim() || coreDailyOption(this.app, 'folder'));
		return { dailyFolder, format: this.dailyFormat(), alias: s.alias, weekly: pro && s.weekly, weeklyFormat: s.weeklyFormat, monthly: pro && s.monthly, monthlyFormat: s.monthlyFormat };
	}

	/** The text of a link for the example date, for the settings. */
	exampleLink(): string {
		return buildLinksFor((i, f) => this.formatDate(i, f), { ...this.config(), weekly: false, monthly: false })('2026-10-10')[0]?.text ?? '[[2026-10-10]]';
	}

	/** Which dates get a link. The done date always does; the others are Pro. */
	private kinds(): Kind[] {
		const s = this.settings;
		const kinds: Kind[] = ['done'];
		if (!isPro()) return kinds;
		if (s.linkCreated) kinds.push('created');
		if (s.linkStart) kinds.push('start');
		if (s.linkScheduled) kinds.push('scheduled');
		if (s.linkDue) kinds.push('due');
		return kinds;
	}

	private linkOptions(window: LinkOptions['window']): LinkOptions {
		return { kinds: this.kinds(), linksFor: buildLinksFor((i, f) => this.formatDate(i, f), this.config()), window };
	}

	private autoOptions(): ReconcileOptions {
		const today = todayIso();
		return { ...this.linkOptions(recentWindow(today, RECENT_DAYS)), unlink: this.settings.unlink };
	}

	/** Folder rules are Pro. Without Pro every note is used. */
	private pathAllowed(path: string): boolean {
		if (!isPro()) return true;
		return folderAllowed(path, splitFolders(this.settings.onlyFolders), splitFolders(this.settings.ignoreFolders));
	}

	/** True when the note has the property `task-date-links: false`. The back-fill asks the same function as the link on completion. */
	private noteOptedOut(file: TFile): boolean {
		return optedOut(this.app.metadataCache.getFileCache(file)?.frontmatter);
	}

	// ---- on completion ----

	private onChanged(file: TFile, cache: CachedMetadata): void {
		if (!this.settings.auto || file.extension !== 'md' || !this.pathAllowed(file.path)) return;
		if (optedOut(cache.frontmatter)) return;
		const hasDone = (cache.listItems ?? []).some((li) => li.task !== undefined && li.task !== ' ');
		if (!hasDone && !this.memos.has(file.path)) return;
		const old = this.timers.get(file.path);
		if (old !== undefined) window.clearTimeout(old);
		this.timers.set(
			file.path,
			window.setTimeout(() => {
				this.timers.delete(file.path);
				void this.settle(file);
			}, SETTLE_MS),
		);
	}

	private remember(path: string, memo: FileMemo): void {
		this.memos.delete(path);
		if (memo.size === 0) return;
		this.memos.set(path, memo);
		for (const k of this.memos.keys()) {
			if (this.memos.size <= MEMO_MAX_FILES) break;
			this.memos.delete(k);
		}
	}

	/** Reads the note, and writes only when a link has to be added or removed. */
	private async settle(file: TFile): Promise<void> {
		try {
			const opts = this.autoOptions();
			const prev = this.memos.get(file.path);
			const first = reconcile(await this.app.vault.read(file), prev, opts);
			if (first.changes.length === 0) {
				this.remember(file.path, first.memo);
				return;
			}
			await this.app.vault.process(file, (now) => {
				const r = reconcile(now, prev, opts);
				this.remember(file.path, r.memo);
				return r.text;
			});
		} catch (e) {
			console.warn('Task Date Links: could not update', file.path, e);
		}
	}

	// ---- back-fill ----

	private addCommands(): void {
		this.addCommand({
			id: 'link-done-dates-note',
			name: 'Link the done dates in the current note',
			editorCallback: (editor, ctx) => {
				if (ctx.file) void this.backfill([ctx.file], undefined, `Link the done dates in ${ctx.file.basename}`, editor);
			},
		});
		this.addCommand({
			id: 'link-done-dates-selection',
			name: 'Link the done dates in the selection',
			editorCheckCallback: (checking, editor, ctx) => {
				if (!editor.somethingSelected() || !ctx.file) return false;
				if (!checking) void this.backfill([ctx.file], selectedLines(editor), 'Link the done dates in the selection', editor);
				return true;
			},
		});
		this.addCommand({
			id: 'link-done-dates-vault',
			name: 'Link the done dates in the whole vault',
			callback: () => {
				if (!isPro()) {
					new Notice('The back-fill of the whole vault is a pro feature. Sponsor on GitHub, then sign in from the plugin settings.');
					return;
				}
				const files = this.app.vault.getMarkdownFiles().filter((f) => this.pathAllowed(f.path) && this.hasDone(f));
				void this.backfill(files, undefined, 'Link the done dates in the whole vault');
			},
		});
		this.addCommand({
			id: 'undo-backfill',
			name: 'Undo the last back-fill',
			checkCallback: (checking) => {
				if (this.settings.undo === null) return false;
				if (!checking) void this.undoLast();
				return true;
			},
		});
	}

	private hasDone(file: TFile): boolean {
		return (this.app.metadataCache.getFileCache(file)?.listItems ?? []).some((li) => li.task !== undefined && li.task !== ' ');
	}

	/**
	 * Builds the plan, shows the preview and applies it when the user agrees. Back-fill links every done date, old or new.
	 * A note that the folder rules or the property `task-date-links: false` keep out is never read and never changed.
	 */
	private async backfill(files: readonly TFile[], range: LineRange | undefined, title: string, editor?: Editor): Promise<void> {
		const opts = this.linkOptions(null);
		const preview: PreviewFile[] = [];
		const inFolders = files.filter((f) => this.pathAllowed(f.path));
		if (inFolders.length === 0 && files.length > 0) {
			new Notice('The folder rules skip this note.');
			return;
		}
		const allowed = inFolders.filter((f) => !this.noteOptedOut(f));
		const skipped = inFolders.length - allowed.length;
		if (editor && files.length === 1 && skipped === 1) {
			new Notice('The property "task-date-links: false" skips this note. Nothing was changed.');
			return;
		}
		for (const f of allowed) {
			const text = editor && files.length === 1 ? editor.getValue() : await this.app.vault.cachedRead(f);
			const changes = linkText(text, opts, range).changes;
			if (changes.length > 0) preview.push({ path: f.path, changes });
		}
		if (preview.length === 0) {
			new Notice(['No done dates to link.', skippedText(skipped)].filter((t) => t !== '').join(' '));
			return;
		}
		new PreviewModal(this.app, title, preview, () => this.applyPlan(allowed, preview, range, skipped), skipped).open();
	}

	private async applyPlan(files: readonly TFile[], preview: readonly PreviewFile[], range: LineRange | undefined, skippedBefore: number): Promise<void> {
		const opts = this.linkOptions(null);
		const planned = new Set(preview.map((p) => p.path));
		const done: UndoFile[] = [];
		let skipped = skippedBefore;
		let failed = 0;
		for (const f of files) {
			if (!planned.has(f.path)) continue;
			// The property can change while the preview is open, for example through a sync.
			if (this.noteOptedOut(f)) {
				skipped++;
				continue;
			}
			// A note that cannot be written (deleted or renamed while the preview is open) does not stop the other notes,
			// and the undo still gets the notes that changed.
			try {
				const edits: UndoFile['edits'] = [];
				await this.app.vault.process(f, (now) => {
					edits.length = 0;
					const r = linkText(now, opts, range);
					for (const c of r.changes) edits.push({ before: c.before, after: c.after });
					return r.text;
				});
				if (edits.length > 0) done.push({ path: f.path, edits });
			} catch (e) {
				failed++;
				console.warn('Task Date Links: could not update', f.path, e);
			}
			this.memos.delete(f.path);
		}
		const n = done.reduce((sum, d) => sum + d.edits.length, 0);
		this.settings.undo = n > 0 ? { at: Date.now(), files: done } : this.settings.undo;
		await this.saveSettings();
		const linked = `Linked ${n} done ${n === 1 ? 'date' : 'dates'} in ${done.length} ${done.length === 1 ? 'note' : 'notes'}.`;
		const notChanged = failed > 0 ? `${failed === 1 ? '1 note' : `${failed} notes`} could not be changed. The console shows why.` : '';
		new Notice([linked, notChanged, skippedText(skipped), 'Run "Undo the last back-fill" to undo.'].filter((t) => t !== '').join(' '));
	}

	/** Puts back the lines of the last back-fill. A line that you changed since is left alone. */
	async undoLast(): Promise<void> {
		const batch = this.settings.undo;
		if (!batch) return;
		let restored = 0;
		let skipped = 0;
		for (const u of batch.files) {
			const file = this.app.vault.getFileByPath(u.path);
			if (!file) {
				skipped += u.edits.length;
				continue;
			}
			try {
				await this.app.vault.process(file, (now) => {
					const r = undoEdits(now, u.edits);
					restored += r.restored;
					skipped += r.skipped;
					return r.text;
				});
			} catch (e) {
				skipped += u.edits.length;
				console.warn('Task Date Links: could not undo', u.path, e);
			}
			this.memos.delete(u.path);
		}
		this.settings.undo = null;
		await this.saveSettings();
		new Notice(skipped > 0 ? `Undid ${restored} lines. ${skipped} lines were changed since and stay as they are.` : `Undid ${restored} lines.`);
	}
}

/** The lines the selection touches. A selection that ends at the start of a line does not take that line. */
function selectedLines(editor: Editor): LineRange {
	const a = editor.getCursor('from');
	const b = editor.getCursor('to');
	return { from: a.line, to: b.ch === 0 && b.line > a.line ? b.line - 1 : b.line };
}
