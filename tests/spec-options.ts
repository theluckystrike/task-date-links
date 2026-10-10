// Turns the JSON options of a golden vector into LinkOptions, with the stand-in formatter.
import type { Kind, LinkOptions } from '../src/links';
import { buildLinksFor, type LinkConfig } from '../src/options';
import { fmt } from './fmt';

export interface VectorSpec {
	format?: string;
	alias?: string;
	kinds?: Kind[];
	/** [from, to] as YYYY-MM-DD; absent means every done date. */
	window?: [string, string];
	weekly?: boolean;
	monthly?: boolean;
	/** [from, to] zero-based line range, for a selection. */
	range?: [number, number];
}

export function toOptions(spec: VectorSpec | undefined): LinkOptions {
	const s = spec ?? {};
	const cfg: LinkConfig = {
		format: s.format ?? 'YYYY-MM-DD',
		alias: s.alias ?? '',
		weekly: s.weekly === true,
		weeklyFormat: 'gggg-[W]ww',
		monthly: s.monthly === true,
		monthlyFormat: 'YYYY-MM',
	};
	return { kinds: s.kinds ?? ['done'], linksFor: buildLinksFor(fmt, cfg), window: s.window ? { from: s.window[0], to: s.window[1] } : null };
}
