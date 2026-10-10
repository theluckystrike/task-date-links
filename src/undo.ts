// The one undo of a back-fill. It stores each changed line as before and after. Undo looks for the "after" line by its
// text, not by its number, so a note that gained or lost lines since still undoes. A line you edited since stays as it is.

export interface UndoEdit {
	before: string;
	after: string;
}

export interface UndoFile {
	path: string;
	edits: UndoEdit[];
}

export interface UndoBatch {
	/** Time of the back-fill, in ms since 1970. */
	at: number;
	files: UndoFile[];
}

/** Most files and lines one undo keeps, so a hand-edited data.json cannot grow without bound. */
export const UNDO_MAX_FILES = 5000;
export const UNDO_MAX_EDITS = 20000;

export interface UndoResult {
	text: string;
	restored: number;
	skipped: number;
}

/** Puts the "before" lines back. Each edit is used once, on the first line that still equals its "after" text. */
export function undoEdits(text: string, edits: readonly UndoEdit[]): UndoResult {
	const lines = text.split('\n');
	const used = new Set<number>();
	let restored = 0;
	for (const e of edits) {
		let at = -1;
		for (let i = 0; i < lines.length; i++) {
			if (!used.has(i) && lines[i] === e.after) {
				at = i;
				break;
			}
		}
		if (at < 0) continue;
		lines[at] = e.before;
		used.add(at);
		restored++;
	}
	return { text: lines.join('\n'), restored, skipped: edits.length - restored };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function cleanEdits(raw: unknown, room: number): UndoEdit[] {
	if (!Array.isArray(raw)) return [];
	const out: UndoEdit[] = [];
	for (const e of (raw as unknown[]).slice(0, room)) {
		if (isRecord(e) && typeof e.before === 'string' && typeof e.after === 'string') out.push({ before: e.before, after: e.after });
	}
	return out;
}

/** Reads a saved batch. Anything that is not a well formed batch gives null. */
export function normalizeUndo(saved: unknown): UndoBatch | null {
	if (!isRecord(saved) || typeof saved.at !== 'number' || !Array.isArray(saved.files)) return null;
	const files: UndoFile[] = [];
	let room = UNDO_MAX_EDITS;
	for (const f of (saved.files as unknown[]).slice(0, UNDO_MAX_FILES)) {
		if (!isRecord(f) || typeof f.path !== 'string') continue;
		const edits = cleanEdits(f.edits, room);
		room -= edits.length;
		if (edits.length > 0) files.push({ path: f.path, edits });
	}
	return files.length > 0 ? { at: saved.at, files } : null;
}
