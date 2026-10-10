import { describe, expect, it } from 'vitest';
import vectors from './vectors/task-date-links.json';
import { linkText } from '../src/links';
import { toOptions, type VectorSpec } from './spec-options';

describe('golden vectors (packages/spec/vectors/task-date-links.json)', () => {
	it('has at least 40 cases', () => {
		expect(vectors.cases.length).toBeGreaterThanOrEqual(40);
	});
	for (const c of vectors.cases) {
		it(c.name, () => {
			const [text, spec] = c.args as [string, VectorSpec];
			const range = spec.range ? { from: spec.range[0], to: spec.range[1] } : undefined;
			const r = linkText(text, toOptions(spec), range);
			const expected = c.expected as { text: string; changed: number[] };
			expect(r.text).toBe(expected.text);
			expect(r.changes.map((x) => x.line)).toEqual(expected.changed);
			// A second run changes nothing: the links are found again.
			expect(linkText(r.text, toOptions(spec), range).changes).toEqual([]);
		});
	}
});
