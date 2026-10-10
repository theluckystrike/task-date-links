// A small stand-in for moment, enough for the formats in the tests: YYYY YY MMMM MMM MM M DD D dddd ddd gggg ww and [text].
// Weeks follow the en locale of moment: they start on Sunday and week 1 is the week that holds January 1.
import type { FormatFn } from '../src/options';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** Week year and week number of a date, en locale. The week year is the year of the Saturday that ends the week. */
function weekOf(d: Date): { year: number; week: number } {
	const sat = new Date(d.getTime());
	sat.setUTCDate(sat.getUTCDate() + (6 - sat.getUTCDay()));
	const jan1 = Date.UTC(sat.getUTCFullYear(), 0, 1);
	const doy = Math.floor((sat.getTime() - jan1) / 86400000);
	return { year: sat.getUTCFullYear(), week: Math.floor(doy / 7) + 1 };
}

export const fmt: FormatFn = (iso, format) => {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return '';
	const d = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return '';
	const w = weekOf(d);
	const tokens: Record<string, string> = {
		YYYY: pad(d.getUTCFullYear(), 4),
		YY: pad(d.getUTCFullYear() % 100),
		MMMM: MONTHS[d.getUTCMonth()] ?? '',
		MMM: (MONTHS[d.getUTCMonth()] ?? '').slice(0, 3),
		MM: pad(d.getUTCMonth() + 1),
		M: String(d.getUTCMonth() + 1),
		DD: pad(d.getUTCDate()),
		D: String(d.getUTCDate()),
		dddd: DAYS[d.getUTCDay()] ?? '',
		ddd: (DAYS[d.getUTCDay()] ?? '').slice(0, 3),
		gggg: pad(w.year, 4),
		ww: pad(w.week),
	};
	return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|gggg|ww/g, (t, lit: string | undefined) => (lit !== undefined ? lit : (tokens[t] ?? t)));
};
