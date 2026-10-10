import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI, isPro } from './pro';
import { DEFAULT_MONTHLY, DEFAULT_WEEKLY, safeTarget } from './options';
import { normalizeUndo, type UndoBatch } from './undo';
import type TaskDateLinksPlugin from './main';

export interface TaskDateLinksSettings {
	/** Link a task when it is completed. */
	auto: boolean;
	/** Daily note format. Empty means the format of the Daily notes plugin, or YYYY-MM-DD. */
	format: string;
	/** Link text format after the pipe. Empty means no alias. */
	alias: string;
	/** Remove the links this plugin added when a task is reopened. */
	unlink: boolean;
	// Pro
	linkCreated: boolean;
	linkStart: boolean;
	linkScheduled: boolean;
	linkDue: boolean;
	weekly: boolean;
	weeklyFormat: string;
	monthly: boolean;
	monthlyFormat: string;
	/** Folders to use, one per line. Empty means the whole vault. */
	onlyFolders: string;
	/** Folders to skip, one per line. */
	ignoreFolders: string;
	/** The last back-fill, kept so one command can undo it. Not shown in the settings. */
	undo: UndoBatch | null;
}

export const DEFAULT_SETTINGS: TaskDateLinksSettings = {
	auto: true,
	format: '',
	alias: '',
	unlink: true,
	linkCreated: false,
	linkStart: false,
	linkScheduled: false,
	linkDue: false,
	weekly: false,
	weeklyFormat: DEFAULT_WEEKLY,
	monthly: false,
	monthlyFormat: DEFAULT_MONTHLY,
	onlyFolders: '',
	ignoreFolders: '',
	undo: null,
};

/** Most characters a saved format or folder list keeps. */
const TEXT_MAX = 2000;

function bool(v: unknown, d: boolean): boolean {
	return typeof v === 'boolean' ? v : d;
}

function text(v: unknown, d: string): string {
	return typeof v === 'string' ? v.slice(0, TEXT_MAX) : d;
}

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: Partial<TaskDateLinksSettings> | null | undefined): TaskDateLinksSettings {
	const s: Partial<Record<keyof TaskDateLinksSettings, unknown>> = saved ?? {};
	const d = DEFAULT_SETTINGS;
	return {
		auto: bool(s.auto, d.auto),
		format: text(s.format, d.format),
		alias: text(s.alias, d.alias),
		unlink: bool(s.unlink, d.unlink),
		linkCreated: bool(s.linkCreated, d.linkCreated),
		linkStart: bool(s.linkStart, d.linkStart),
		linkScheduled: bool(s.linkScheduled, d.linkScheduled),
		linkDue: bool(s.linkDue, d.linkDue),
		weekly: bool(s.weekly, d.weekly),
		weeklyFormat: text(s.weeklyFormat, d.weeklyFormat),
		monthly: bool(s.monthly, d.monthly),
		monthlyFormat: text(s.monthlyFormat, d.monthlyFormat),
		onlyFolders: text(s.onlyFolders, d.onlyFolders),
		ignoreFolders: text(s.ignoreFolders, d.ignoreFolders),
		undo: normalizeUndo(s.undo),
	};
}

export class TaskDateLinksSettingTab extends PluginSettingTab {
	plugin: TaskDateLinksPlugin;

	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], plugin: TaskDateLinksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** A format check for a text control: the example date must give a name that fits inside a link. */
	private checkFormat(format: string): string | void {
		if (format.trim() === '') return;
		if (!safeTarget(this.plugin.formatDate('2026-10-10', format))) return 'This format gives a name with a character that cannot be in a link, such as [ ] | # or ^.';
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const off = (): boolean => !isPro();
		const example = this.plugin.exampleLink();
		return [
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
			{
				name: 'Link a task when it is completed',
				desc: 'When the Tasks plugin writes a done date, add a link to that day. The link goes before the Tasks fields, so Tasks still reads the line.',
				control: { type: 'toggle', key: 'auto', defaultValue: DEFAULT_SETTINGS.auto },
			},
			{
				name: 'Daily note format',
				desc: `A moment format. Leave it empty to use the format of the Daily notes plugin. Now the link looks like ${example}.`,
				control: { type: 'text', key: 'format', defaultValue: DEFAULT_SETTINGS.format, placeholder: 'YYYY-MM-DD', validate: (v) => this.checkFormat(v) },
			},
			{
				name: 'Link text format',
				desc: 'An optional moment format for the text that shows in place of the note name, such as MMM D. Leave it empty for the plain link.',
				control: { type: 'text', key: 'alias', defaultValue: DEFAULT_SETTINGS.alias, placeholder: 'MMM D', validate: (v) => this.checkFormat(v) },
			},
			{
				name: 'Remove the link when a task is reopened',
				desc: 'When you uncheck a task, remove the links this plugin added to it. Links you typed yourself stay.',
				control: { type: 'toggle', key: 'unlink', defaultValue: DEFAULT_SETTINGS.unlink },
			},
			{ name: 'Link the start date (Pro)', desc: 'Also link the start date of a completed task.', control: { type: 'toggle', key: 'linkStart', defaultValue: false, disabled: off } },
			{ name: 'Link the scheduled date (Pro)', desc: 'Also link the scheduled date of a completed task.', control: { type: 'toggle', key: 'linkScheduled', defaultValue: false, disabled: off } },
			{ name: 'Link the due date (Pro)', desc: 'Also link the due date of a completed task.', control: { type: 'toggle', key: 'linkDue', defaultValue: false, disabled: off } },
			{ name: 'Link the created date (Pro)', desc: 'Also link the created date of a completed task.', control: { type: 'toggle', key: 'linkCreated', defaultValue: false, disabled: off } },
			{ name: 'Link the weekly note (Pro)', desc: 'Also link the weekly note of each linked date.', control: { type: 'toggle', key: 'weekly', defaultValue: false, disabled: off } },
			{
				name: 'Weekly note format (Pro)',
				desc: 'A moment format. The default is the one of the Periodic Notes plugin.',
				control: { type: 'text', key: 'weeklyFormat', defaultValue: DEFAULT_WEEKLY, placeholder: DEFAULT_WEEKLY, disabled: off, validate: (v) => this.checkFormat(v) },
			},
			{ name: 'Link the monthly note (Pro)', desc: 'Also link the monthly note of each linked date.', control: { type: 'toggle', key: 'monthly', defaultValue: false, disabled: off } },
			{
				name: 'Monthly note format (Pro)',
				desc: 'A moment format.',
				control: { type: 'text', key: 'monthlyFormat', defaultValue: DEFAULT_MONTHLY, placeholder: DEFAULT_MONTHLY, disabled: off, validate: (v) => this.checkFormat(v) },
			},
			{
				name: 'Only these folders (Pro)',
				desc: 'One folder per line. Empty means the whole vault. Applies to links on completion and to the back-fill.',
				control: { type: 'textarea', key: 'onlyFolders', defaultValue: '', placeholder: 'Projects', disabled: off },
			},
			{
				name: 'Skip these folders (Pro)',
				desc: 'One folder per line. Notes in these folders and below are never changed.',
				control: { type: 'textarea', key: 'ignoreFolders', defaultValue: '', placeholder: 'Archive', disabled: off },
			},
			{
				name: 'Pro features',
				desc: isPro()
					? 'Pro is on: back-fill of the whole vault, links for the start, scheduled, due and created dates, weekly and monthly note links, and folder rules.'
					: 'Free version: links on completion, the back-fill of one note or a selection with a preview and one undo. Pro adds the back-fill of the whole vault, links for the start, scheduled, due and created dates, weekly and monthly note links, and folder rules.',
			},
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await super.setControlValue(key, value);
		this.plugin.settings = normalizeSettings(this.plugin.settings);
		this.plugin.settingsChanged();
	}
}
