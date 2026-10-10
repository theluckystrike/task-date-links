// The date library of Obsidian (moment). It is read from the module by name and typed here, so the plugin needs no
// moment typings of its own.
import * as obsidian from 'obsidian';

export interface MomentLike {
	isValid(): boolean;
	format(format: string): string;
}

type MomentFn = (input?: string, format?: string, strict?: boolean) => MomentLike;

function moment(): MomentFn {
	const m = (obsidian as unknown as { moment?: MomentFn }).moment;
	if (typeof m !== 'function') throw new Error('Task Date Links: the moment library of Obsidian is missing');
	return m;
}

/** An ISO date (YYYY-MM-DD) in a moment format; '' when the date does not exist. */
export function formatIso(iso: string, format: string): string {
	const m = moment()(iso, 'YYYY-MM-DD', true);
	return m.isValid() ? m.format(format) : '';
}

/** Today as YYYY-MM-DD in the local time zone. */
export function todayIso(): string {
	return moment()().format('YYYY-MM-DD');
}
