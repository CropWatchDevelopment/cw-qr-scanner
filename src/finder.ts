import type { BitMatrix } from './bit-matrix.js';
import type { Point } from './geometry.js';

/**
 * A finder pattern: the 7 × 7 "bull's eye" in three corners of every symbol
 * (dark ring, light ring, 3 × 3 dark centre). Any line through its centre
 * crosses dark, light, dark, light, dark runs in the ratio 1 : 1 : 3 : 1 : 1.
 */
export interface FinderPattern extends Point {
	/** Estimated module size in pixels. */
	moduleSize: number;
	/** How many scan lines found it: real patterns are hit by many. */
	count: number;
}

export interface FinderTriple {
	topLeft: FinderPattern;
	topRight: FinderPattern;
	bottomLeft: FinderPattern;
	/** Lower is better: how far the three are from a square symbol's corners. */
	score: number;
}

/** Runs within `tolerance` (a share of one module) of 1 : 1 : 3 : 1 : 1. */
function isFinderRatio(runs: ArrayLike<number>, offset: number, tolerance: number): boolean {
	const r0 = runs[offset];
	const r1 = runs[offset + 1];
	const r2 = runs[offset + 2];
	const r3 = runs[offset + 3];
	const r4 = runs[offset + 4];
	const total = r0 + r1 + r2 + r3 + r4;
	// Below ~1.4 pixels a module, sensor noise fakes patterns and codes can't be read anyway.
	if (total < 10) return false;
	const unit = total / 7;
	const slack = unit * tolerance;
	return (
		Math.abs(r0 - unit) < slack &&
		Math.abs(r1 - unit) < slack &&
		Math.abs(r2 - 3 * unit) < 3 * slack &&
		Math.abs(r3 - unit) < slack &&
		Math.abs(r4 - unit) < slack
	);
}

/**
 * Walks from (x, y) in steps of (dx, dy) and measures, in order: the rest of
 * the dark centre, the light ring, the dark ring. Null when the line runs
 * past `limit` steps or the pattern is cut short.
 */
function walk(
	bits: BitMatrix,
	x: number,
	y: number,
	dx: number,
	dy: number,
	limit: number
): [number, number, number] | null {
	const runs: [number, number, number] = [0, 0, 0];
	let state = 0;
	for (let step = 1; step <= limit; step++) {
		const dark = bits.get(Math.floor(x + dx * step), Math.floor(y + dy * step));
		if (state === 0) {
			if (dark) runs[0]++;
			else {
				state = 1;
				runs[1] = 1;
			}
		} else if (state === 1) {
			if (!dark) runs[1]++;
			else {
				state = 2;
				runs[2] = 1;
			}
		} else if (dark) {
			runs[2]++;
		} else {
			return runs;
		}
	}
	return null;
}

interface Crossing {
	/** The five runs, outside to outside. */
	runs: number[];
	/**
	 * Where the pattern's centre lies, in steps from the centre of the start
	 * pixel: the mean of the centre run's midpoint and the whole crossing's.
	 */
	offset: number;
}

/** The full five-run crossing through (x, y) along ±(dx, dy). */
function cross(
	bits: BitMatrix,
	x: number,
	y: number,
	dx: number,
	dy: number,
	limit: number
): Crossing | null {
	if (!bits.get(Math.floor(x), Math.floor(y))) return null;
	const back = walk(bits, x, y, -dx, -dy, limit);
	if (!back) return null;
	const forward = walk(bits, x, y, dx, dy, limit);
	if (!forward) return null;
	const inner = forward[0] - back[0];
	const outer = forward[0] + forward[1] + forward[2] - back[0] - back[1] - back[2];
	return {
		runs: [back[2], back[1], back[0] + forward[0] + 1, forward[1], forward[2]],
		offset: (inner + outer) / 4
	};
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/**
 * Confirms a candidate found on a horizontal scan line: vertical, horizontal
 * and diagonal crossings must all show the finder ratio at a similar size.
 * Returns the refined centre and module size.
 */
function confirm(
	bits: BitMatrix,
	x: number,
	y: number,
	rowTotal: number,
	tolerance: number
): FinderPattern | null {
	const limit = Math.ceil(rowTotal * 2);
	const vertical = cross(bits, x, y, 0, 1, limit);
	if (!vertical || !isFinderRatio(vertical.runs, 0, tolerance)) return null;
	const verticalTotal = sum(vertical.runs);
	if (Math.abs(verticalTotal - rowTotal) > 0.6 * Math.max(verticalTotal, rowTotal)) return null;
	let cy = Math.floor(y) + 0.5 + vertical.offset;

	const horizontal = cross(bits, x, cy, 1, 0, limit);
	if (!horizontal || !isFinderRatio(horizontal.runs, 0, tolerance)) return null;
	const horizontalTotal = sum(horizontal.runs);
	const cx = Math.floor(x) + 0.5 + horizontal.offset;

	// Once more down the refined centre column, for a better centre row.
	const recheck = cross(bits, cx, cy, 0, 1, limit);
	if (recheck && isFinderRatio(recheck.runs, 0, tolerance)) {
		cy = Math.floor(cy) + 0.5 + recheck.offset;
	}

	// The diagonals reject lookalikes in text and graphics; they are measured
	// in diagonal steps (√2 pixels), so only their proportions are compared,
	// leniently.
	const lenient = Math.max(tolerance, 0.75);
	const diagonal = cross(bits, cx, cy, 1, 1, limit);
	if (!diagonal || !isFinderRatio(diagonal.runs, 0, lenient)) return null;
	const antiDiagonal = cross(bits, cx, cy, 1, -1, limit);

	// A crossing parallel to a side is 7 modules; at any other angle it is
	// longer. Of four directions 45° apart, the shortest is within 8 %.
	const widths = [horizontalTotal, verticalTotal, sum(diagonal.runs) * Math.SQRT2];
	if (antiDiagonal && isFinderRatio(antiDiagonal.runs, 0, lenient)) {
		widths.push(sum(antiDiagonal.runs) * Math.SQRT2);
	}
	return { x: cx, y: cy, moduleSize: Math.min(...widths) / 7, count: 1 };
}

/**
 * Width in pixels (7 modules) of a finder pattern measured through its centre
 * toward `toward` — along a symbol side when `toward` is another finder
 * pattern. Null when that line doesn't cross the pattern cleanly.
 */
export function widthToward(bits: BitMatrix, pattern: FinderPattern, toward: Point): number | null {
	const length = Math.hypot(toward.x - pattern.x, toward.y - pattern.y);
	if (length === 0) return null;
	const dx = (toward.x - pattern.x) / length;
	const dy = (toward.y - pattern.y) / length;
	const crossing = cross(bits, pattern.x, pattern.y, dx, dy, Math.ceil(pattern.moduleSize * 14));
	if (!crossing || !isFinderRatio(crossing.runs, 0, 0.75)) return null;
	return sum(crossing.runs);
}

/** Folds a confirmed pattern into one already seen nearby, or adds it. */
function merge(found: FinderPattern[], candidate: FinderPattern): void {
	for (const existing of found) {
		const size = Math.max(existing.moduleSize, candidate.moduleSize);
		if (
			Math.abs(existing.x - candidate.x) <= 2 * size &&
			Math.abs(existing.y - candidate.y) <= 2 * size &&
			Math.max(existing.moduleSize, candidate.moduleSize) /
				Math.min(existing.moduleSize, candidate.moduleSize) <
				1.6
		) {
			const n = existing.count;
			existing.x = (existing.x * n + candidate.x) / (n + 1);
			existing.y = (existing.y * n + candidate.y) / (n + 1);
			existing.moduleSize = (existing.moduleSize * n + candidate.moduleSize) / (n + 1);
			existing.count = n + 1;
			return;
		}
	}
	found.push(candidate);
}

/**
 * Scans every row for dark/light runs in the finder ratio and confirms each
 * hit with crossings through its centre. `tolerance` is how far each run may
 * stray from its ideal length, as a share of one module.
 */
export function findFinderPatterns(bits: BitMatrix, tolerance = 0.5): FinderPattern[] {
	const { width, height, data } = bits;
	const runs = new Int32Array(width + 1);
	const starts = new Int32Array(width + 1);
	const found: FinderPattern[] = [];

	for (let y = 0; y < height; y++) {
		const row = y * width;
		let count = 0;
		let x = 0;
		while (x < width) {
			const colour = data[row + x];
			const start = x;
			while (x < width && data[row + x] === colour) x++;
			starts[count] = start;
			runs[count] = x - start;
			count++;
		}
		// Five-run windows that start (and so also end) on a dark run.
		for (let i = data[row] === 1 ? 0 : 1; i + 4 < count; i += 2) {
			if (!isFinderRatio(runs, i, tolerance)) continue;
			const total = runs[i] + runs[i + 1] + runs[i + 2] + runs[i + 3] + runs[i + 4];
			const centreX = starts[i + 2] + runs[i + 2] / 2;
			const confirmed = confirm(bits, centreX, y + 0.5, total, tolerance);
			if (confirmed) merge(found, confirmed);
		}
	}
	return found;
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Picks the triples of finder patterns that best fit a symbol's corners: two
 * sides of similar length meeting at a right angle, patterns of similar size.
 * The corner at the right angle is the top-left; the cross product of the two
 * sides tells top-right from bottom-left (image y grows downwards).
 */
export function rankTriples(patterns: FinderPattern[], limit = 5): FinderTriple[] {
	let pool = patterns.filter((pattern) => pattern.count >= 2);
	if (pool.length < 3) pool = patterns.slice();
	pool = pool.sort((a, b) => b.count - a.count).slice(0, 12);

	const triples: FinderTriple[] = [];
	for (let i = 0; i < pool.length; i++) {
		for (let j = i + 1; j < pool.length; j++) {
			for (let k = j + 1; k < pool.length; k++) {
				const a = pool[i];
				const b = pool[j];
				const c = pool[k];
				const sizes = [a.moduleSize, b.moduleSize, c.moduleSize];
				const meanSize = (sizes[0] + sizes[1] + sizes[2]) / 3;
				const sizeSpread = (Math.max(...sizes) - Math.min(...sizes)) / meanSize;
				if (sizeSpread > 0.6) continue;

				const ab = distance(a, b);
				const bc = distance(b, c);
				const ac = distance(a, c);
				let corner: FinderPattern;
				let p: FinderPattern;
				let q: FinderPattern;
				let hypotenuse: number;
				let side1: number;
				let side2: number;
				if (bc >= ab && bc >= ac) {
					[corner, p, q, hypotenuse, side1, side2] = [a, b, c, bc, ab, ac];
				} else if (ac >= ab && ac >= bc) {
					[corner, p, q, hypotenuse, side1, side2] = [b, a, c, ac, ab, bc];
				} else {
					[corner, p, q, hypotenuse, side1, side2] = [c, a, b, ab, ac, bc];
				}

				// Finder centres are 14 (version 1) to 170 (version 40) modules apart;
				// foreshortening can make a side look shorter.
				if (Math.min(side1, side2) < 8 * meanSize || Math.max(side1, side2) > 200 * meanSize)
					continue;
				const sideMismatch = Math.abs(side1 - side2) / Math.max(side1, side2);
				const rightAngleError = Math.abs(hypotenuse - Math.hypot(side1, side2)) / hypotenuse;
				if (sideMismatch > 0.5 || rightAngleError > 0.25) continue;

				const turn = (p.x - corner.x) * (q.y - corner.y) - (p.y - corner.y) * (q.x - corner.x);
				const [topRight, bottomLeft] = turn > 0 ? [p, q] : [q, p];
				triples.push({
					topLeft: corner,
					topRight,
					bottomLeft,
					score: sideMismatch + 2 * rightAngleError + 0.5 * sizeSpread
				});
			}
		}
	}
	return triples.sort((a, b) => a.score - b.score).slice(0, limit);
}
