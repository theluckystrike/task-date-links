import { Notice, Plugin, normalizePath, type CachedMetadata, type Editor, type TFile } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { SPONSORS, bindPro, isPro, resetPro, proNotice, PRO_VAULT_LEAD } from './pro';
import { DEFAULT_SETTINGS, TaskDateLinksSettingTab, normalizeSettings, type TaskDateLinksSettings } from './settings';
import { linkText, type Kind, type LineRange, type LinkOptions } from './links';
import { FALLBACK_FORMAT, buildLinksFor, folderAllowed, optedOut, recentWindow, splitFolders, type LinkConfig } from './options';
import { reconcile, type FileMemo, type ReconcileOptions } from './reconcile';
import { PreviewModal, skippedText, type PreviewFile } from './preview';
import { formatIso, todayIso } from './moment';
import { UNDO_MAX_EDITS, UNDO_MAX_FILES, undoEdits, type UndoFile, type UndoResult } from './undo';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

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

/** Stored on the App, rather than in a module cache: Obsidian reloads the plugin module. */
const OWNER_KEY = Symbol.for('task-date-links.persistence-owner.v1');
interface Ownership {
	retired: boolean;
	ready: Promise<void>;
	idle: Promise<void>;
	saves: Promise<void>;
	drain(): Promise<void>;
}

/** Older in-session modules can hand off successful saves without a retry callback. */
async function drainOwner(owner: Ownership): Promise<void> {
	if (typeof owner.drain === 'function') return owner.drain();
	await owner.ready;
	await owner.idle;
	await owner.saves;
}

export default class TaskDateLinksPlugin extends Plugin {
	settings: TaskDateLinksSettings = { ...DEFAULT_SETTINGS };
	/** GitHub Sponsors Pro state. Created in onload; null before that. */
	pro: SponsorsManager | null = null;
	private settingTab: TaskDateLinksSettingTab | null = null;
	/** The finished tasks seen in each note, by path. See reconcile.ts. */
	private readonly memos = new Map<string, FileMemo>();
	private readonly timers = new Map<string, number>();
	/** One controller owns all note mutations and the last-back-fill recovery record. */
	private mutationBusy = false;
	private disposed = false;
	private ownership: Ownership | null = null;
	/** The latest accepted snapshot stays owned until the host confirms persistence. */
	private pendingSettings: TaskDateLinksSettings | null = null;

	private get stopped(): boolean { return this.disposed || this.ownership?.retired === true; }

	private owner(): Ownership {
		if (this.ownership) return this.ownership;
		const app = this.app as typeof this.app & { [OWNER_KEY]?: Ownership };
		let previous = Object.getOwnPropertyDescriptor(app, OWNER_KEY)?.value as Ownership | undefined;
		const owner: Ownership = {
			retired: false, ready: Promise.resolve(), idle: Promise.resolve(), saves: Promise.resolve(),
			drain: async () => {
				// A failed enable never becomes ready, but a later explicit enable can
				// retry its predecessor. Only confirmed snapshots may leave owned memory.
				await owner.ready.catch(() => undefined);
				if (previous) { await drainOwner(previous); previous = undefined; }
				await owner.idle;
				await owner.saves.catch(() => undefined);
				if (this.pendingSettings) {
					await this.saveData(this.pendingSettings);
					this.pendingSettings = null;
				}
			},
		};
		this.ownership = owner;
		app[OWNER_KEY] = owner;
		if (previous) {
			previous.retired = true;
			owner.ready = (async () => {
				// onload may await this; onunload must stay synchronous. The old operation
				// finishes its accepted writes and final recovery save without waiting on us.
				await drainOwner(previous);
				previous = undefined;
				this.settings = normalizeSettings((await this.loadData()) as Partial<TaskDateLinksSettings> | null);
			})();
		}
		return owner;
	}

	private async mutate(work: () => Promise<void>, retrySave = true): Promise<void> {
		if (this.stopped) return;
		if (this.mutationBusy) {
			new Notice('Task date links is busy. Wait for the current operation to finish, then try again.');
			return;
		}
		const owner = this.owner();
		this.mutationBusy = true;
		let release!: () => void;
		owner.idle = new Promise<void>((resolve) => { release = resolve; });
		try {
			await owner.ready;
			await owner.saves.catch(async (error: unknown) => {
				if (!retrySave || this.stopped) throw error;
				// An explicit operation can retry storage once before touching another note.
				await this.persistSettings();
			});
			if (!this.stopped) await work();
		} finally {
			this.mutationBusy = false;
			release();
		}
	}

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		await this.loadSettings();
		if (this.stopped) return;
		// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
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
			if (this.stopped) return;
			void pro.refresh();
			this.registerInterval(window.setInterval(() => { if (!this.stopped) void pro.refresh(); }, PRO_TICK_MS));
		});
	}

	onunload(): void {
		this.disposed = true;
		resetPro();
		for (const t of this.timers.values()) window.clearTimeout(t);
		this.timers.clear();
		this.memos.clear();
	}

	async loadSettings(): Promise<void> {
		const owner = this.owner();
		await owner.ready;
		await owner.saves;
		this.settings = normalizeSettings((await this.loadData()) as Partial<TaskDateLinksSettings> | null);
	}

	async saveSettings(): Promise<void> {
		if (this.stopped) return;
		await this.persistSettings();
	}

	/** Accepted saves run in order, including snapshots whose host promise outlives disable.
	 * The operation already holding idle may enqueue its final recovery save after retirement. */
	private persistSettings(): Promise<void> {
		const owner = this.owner();
		const snapshot = structuredClone(this.settings);
		const saved = owner.saves.catch(() => undefined).then(async () => {
			await owner.ready;
			// A queued preferences save must use the operation's current recovery record.
			snapshot.undo = structuredClone(this.settings.undo);
			this.pendingSettings = snapshot;
			await this.saveData(snapshot);
			this.pendingSettings = null;
		});
		owner.saves = saved;
		return saved;
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
		if (this.stopped || !this.settings.auto || file.extension !== 'md' || !this.pathAllowed(file.path)) return;
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
		if (this.stopped) return;
		if (this.mutationBusy) {
			// Keep the automatic update pending while a manual operation owns the controller.
			const old = this.timers.get(file.path);
			if (old !== undefined) window.clearTimeout(old);
			this.timers.set(file.path, window.setTimeout(() => {
				this.timers.delete(file.path);
				void this.settle(file);
			}, SETTLE_MS));
			return;
		}
		try {
			await this.mutate(() => this.settleNow(file), false);
		} catch (e) {
			console.warn('Task Date Links: could not update', file.path, e);
		}
	}

	private async settleNow(file: TFile): Promise<void> {
		try {
			const opts = this.autoOptions();
			const prev = this.memos.get(file.path);
			const text = await this.app.vault.read(file);
			if (this.stopped) return;
			const first = reconcile(text, prev, opts);
			if (first.changes.length === 0) {
				this.remember(file.path, first.memo);
				return;
			}
			await this.app.vault.process(file, (now) => {
				if (this.stopped) return now;
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
				if (this.stopped) return;
				if (!isPro()) {
					proNotice(PRO_VAULT_LEAD);
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
		await this.mutate(() => this.buildPreview(files, range, title, editor));
	}

	private async buildPreview(files: readonly TFile[], range: LineRange | undefined, title: string, editor?: Editor): Promise<void> {
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
			if (this.stopped) return;
			const text = editor && files.length === 1 ? editor.getValue() : await this.app.vault.cachedRead(f);
			if (this.stopped) return;
			const changes = linkText(text, opts, range).changes;
			if (changes.length > 0) preview.push({ path: f.path, changes });
		}
		if (preview.length === 0) {
			new Notice(['No done dates to link.', skippedText(skipped)].filter((t) => t !== '').join(' '));
			return;
		}
		if (this.exceedsUndoCapacity(preview)) return;
		new PreviewModal(this.app, title, preview, () => this.applyPlan(allowed, preview, range, skipped), skipped).open();
	}

	/** The same capacity check applies to preview and the full plan re-read before any note is written. */
	private exceedsUndoCapacity(plan: readonly PreviewFile[]): boolean {
		if (plan.length <= UNDO_MAX_FILES && plan.reduce((n, f) => n + f.changes.length, 0) <= UNDO_MAX_EDITS) return false;
		new Notice(`A back-fill accepts at most ${UNDO_MAX_FILES} notes and ${UNDO_MAX_EDITS} changed lines in total. Nothing was changed. Use smaller selections or folder rules.`);
		return true;
	}

	private async applyPlan(files: readonly TFile[], preview: readonly PreviewFile[], range: LineRange | undefined, skippedBefore: number): Promise<void> {
		await this.mutate(() => this.applyPlanNow(files, preview, range, skippedBefore));
	}

	private async applyPlanNow(files: readonly TFile[], preview: readonly PreviewFile[], range: LineRange | undefined, skippedBefore: number): Promise<void> {
		const opts = this.linkOptions(null);
		const planned = new Set(preview.map((p) => p.path));
		// Re-read the whole plan before the first mutation: a later note may have grown since preview.
		const checked = new Map<string, { before: string; after: string; changes: PreviewFile['changes'] }>();
		for (const f of files) {
			if (this.stopped) return;
			if (!planned.has(f.path) || this.noteOptedOut(f)) continue;
			try {
				const before = await this.app.vault.read(f);
				if (this.stopped) return;
				const result = linkText(before, opts, range);
				checked.set(f.path, { before, after: result.text, changes: result.changes });
			} catch (e) {
				// The write loop reports unavailable notes, while the rest still have a bounded plan.
				console.warn('Task Date Links: could not read', f.path, e);
			}
		}
		if (this.exceedsUndoCapacity(Array.from(checked, ([path, p]) => ({ path, changes: p.changes })).filter((p) => p.changes.length > 0))) return;
		const done: UndoFile[] = [];
		let skipped = skippedBefore;
		let failed = 0;
		for (const f of files) {
			if (this.stopped) break;
			if (!planned.has(f.path)) continue;
			// The property can change while the preview is open, for example through a sync.
			if (this.noteOptedOut(f)) {
				skipped++;
				continue;
			}
			// A note that cannot be written (deleted or renamed while the preview is open) does not stop the other notes,
			// and the undo still gets the notes that changed.
			try {
				const plan = checked.get(f.path);
				if (!plan) throw new Error('The note could not be read before applying the back-fill.');
				if (plan.changes.length === 0) continue;
				let applied = false;
				await this.app.vault.process(f, (now) => {
					// The host may retry this callback. Only the final accepted invocation counts.
					applied = false;
					if (this.stopped) return now;
					// A later change must not add edits beyond the capacity checked for the full plan.
					if (now !== plan.before) throw new Error('The note changed after the back-fill check. Preview it again.');
					applied = true;
					return plan.after;
				});
				if (applied) done.push({ path: f.path, edits: plan.changes.map(({ before, after }) => ({ before, after })) });
			} catch (e) {
				failed++;
				console.warn('Task Date Links: could not update', f.path, e);
			}
			this.memos.delete(f.path);
		}
		const n = done.reduce((sum, d) => sum + d.edits.length, 0);
		this.settings.undo = n > 0 ? { at: Date.now(), files: done } : this.settings.undo;
		await this.persistSettings();
		if (this.stopped) return;
		const linked = `Linked ${n} done ${n === 1 ? 'date' : 'dates'} in ${done.length} ${done.length === 1 ? 'note' : 'notes'}.`;
		const notChanged = failed > 0 ? `${failed === 1 ? '1 note' : `${failed} notes`} could not be changed. The console shows why.` : '';
		new Notice([linked, notChanged, skippedText(skipped), 'Run "Undo the last back-fill" to undo.'].filter((t) => t !== '').join(' '));
	}

	/** Puts back the lines of the last back-fill. A line that you changed since is left alone. */
	async undoLast(): Promise<void> {
		await this.mutate(() => this.undoLastNow());
	}

	private async undoLastNow(): Promise<void> {
		const batch = this.settings.undo;
		if (!batch) return;
		let restored = 0;
		let conflicts = 0;
		let failed = 0;
		let missing = 0;
		const outstanding: UndoFile[] = [];
		for (const [index, u] of batch.files.entries()) {
			if (this.stopped) {
				outstanding.push(...batch.files.slice(index));
				break;
			}
			const file = this.app.vault.getFileByPath(u.path);
			if (!file) {
				missing += u.edits.length;
				outstanding.push(u);
				continue;
			}
			try {
				let result: UndoResult | undefined;
				await this.app.vault.process(file, (now) => {
					result = undefined;
					if (this.stopped) return now;
					result = undoEdits(now, u.edits);
					return result.text;
				});
				// A callback result counts only after the write succeeds.
				if (!result) {
					if (!this.stopped) throw new Error('Undo did not read the note.');
					outstanding.push(u);
					continue;
				}
				restored += result.restored;
				conflicts += result.skipped;
				if (result.remaining.length > 0) outstanding.push({ path: u.path, edits: result.remaining });
			} catch (e) {
				failed += u.edits.length;
				outstanding.push(u);
				console.warn('Task Date Links: could not undo', u.path, e);
			}
			this.memos.delete(u.path);
		}
		this.settings.undo = outstanding.length > 0 ? { at: batch.at, files: outstanding } : null;
		await this.persistSettings();
		if (this.stopped) return;
		new Notice([
			`Undid ${restored} lines.`,
			conflicts > 0 ? `${conflicts} lines were changed since and stay as they are.` : '',
			failed > 0 ? `${failed} lines could not be undone because of a read or write error. The console shows why.` : '',
			missing > 0 ? `${missing} lines are in missing notes.` : '',
			outstanding.length > 0 ? 'Recovery entries were kept. Restore missing notes or the exact linked lines, then run "Undo the last back-fill" again to retry only outstanding lines.' : '',
		].filter((t) => t !== '').join(' '));
	}
}

/** The lines the selection touches. A selection that ends at the start of a line does not take that line. */
function selectedLines(editor: Editor): LineRange {
	const a = editor.getCursor('from');
	const b = editor.getCursor('to');
	return { from: a.line, to: b.ch === 0 && b.line > a.line ? b.line - 1 : b.line };
}
