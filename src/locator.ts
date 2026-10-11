import type { BitMatrix } from './bit-matrix.js';
import { widthToward, type FinderTriple } from './finder.js';
import { PerspectiveTransform, type Point } from './geometry.js';

/**
 * Locating the module grid in the image. Three finder centres fix an affine
 * map, which is enough for a code held square-on but drifts by modules under
 * perspective. So the full homography is fitted by least squares to every
 * edge of the three finder patterns: each edge point lies on a known module
 * grid line, which is one linear equation in the transform's coefficients.
 */

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const minus = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

/**
 * Modules per side implied by the finder patterns: their spacing over the
 * module size measured along the symbol's own sides — straight through a
 * finder pattern toward its neighbour, where it is exactly 7 modules wide —
 * so rotation does not distort the estimate.
 */
export function estimateDimension(bits: BitMatrix, triple: FinderTriple): number {
	const { topLeft: tl, topRight: tr, bottomLeft: bl } = triple;
	const width = (from: typeof tl, to: typeof tl) =>
		widthToward(bits, from, to) ?? 7 * from.moduleSize;
	const alongTop = (width(tl, tr) + width(tr, tl)) / 14;
	const alongLeft = (width(tl, bl) + width(bl, tl)) / 14;
	return (distance(tl, tr) / alongTop + distance(tl, bl) / alongLeft) / 2 + 7;
}

/** An image point known to lie on module grid line u = value or v = value. */
export interface Observation {
	x: number;
	y: number;
	axis: 'u' | 'v';
	value: number;
	weight: number;
}

/** Both coordinates of a point whose module position is known. */
export function pointObservations(
	image: Point,
	u: number,
	v: number,
	weight: number
): Observation[] {
	return [
		{ x: image.x, y: image.y, axis: 'u', value: u, weight },
		{ x: image.x, y: image.y, axis: 'v', value: v, weight }
	];
}

/**
 * Walks out from inside a finder pattern's dark centre along `moduleStep`
 * (one module, in pixels) and returns where it crosses the three edges —
 * centre to light ring, light ring to dark ring, dark ring to the light
 * outside — in modules from the start, or null when the line doesn't show
 * that pattern in roughly the right places.
 */
function traceFinderEdges(bits: BitMatrix, start: Point, moduleStep: Point): number[] | null {
	const pixelsPerModule = Math.hypot(moduleStep.x, moduleStep.y);
	if (pixelsPerModule < 1) return null;
	const dt = Math.min(0.25, 0.5 / pixelsPerModule);
	const dark = (t: number) =>
		bits.get(Math.floor(start.x + moduleStep.x * t), Math.floor(start.y + moduleStep.y * t));
	if (!dark(0)) return null;
	const edges: number[] = [];
	let previous = true;
	for (let t = dt; t <= 6 && edges.length < 3; t += dt) {
		const current = dark(t);
		if (current !== previous) edges.push(t - dt / 2);
		previous = current;
	}
	if (edges.length < 3) return null;
	// The ray's own scale, from the outer edge 3.5 modules out.
	const scale = edges[2] / 3.5;
	if (scale < 0.6 || scale > 1.6) return null;
	if (Math.abs(edges[0] - 1.5 * scale) > 0.5 * scale) return null;
	if (Math.abs(edges[1] - 2.5 * scale) > 0.5 * scale) return null;
	return edges;
}

/**
 * Edge points around the three finder patterns of a `dimension`-module
 * symbol. Rays leave each pattern's centre square along both axes of
 * `guide` (module space → image, approximately right), at five offsets
 * across it; every edge a ray crosses lies on a known grid line
 * (±1.5, ±2.5 or ±3.5 modules from the pattern's centre).
 */
export function finderEdges(
	bits: BitMatrix,
	guide: PerspectiveTransform,
	dimension: number
): Observation[] {
	const centres: [number, number][] = [
		[3.5, 3.5],
		[dimension - 3.5, 3.5],
		[3.5, dimension - 3.5]
	];
	const observations: Observation[] = [];
	for (const [cu, cv] of centres) {
		const centre = guide.map(cu, cv);
		const stepU = minus(guide.map(cu + 0.5, cv), guide.map(cu - 0.5, cv));
		const stepV = minus(guide.map(cu, cv + 0.5), guide.map(cu, cv - 0.5));
		const axes = [
			{ axis: 'u' as const, along: stepU, across: stepV, centre: cu },
			{ axis: 'v' as const, along: stepV, across: stepU, centre: cv }
		];
		for (const { axis, along, across, centre: at } of axes) {
			for (const sign of [1, -1]) {
				const step = { x: sign * along.x, y: sign * along.y };
				for (const offset of [-1, -0.5, 0, 0.5, 1]) {
					const start = { x: centre.x + offset * across.x, y: centre.y + offset * across.y };
					const edges = traceFinderEdges(bits, start, step);
					if (!edges) continue;
					for (let k = 0; k < 3; k++) {
						observations.push({
							x: start.x + step.x * edges[k],
							y: start.y + step.y * edges[k],
							axis,
							value: at + sign * (1.5 + k),
							weight: 1
						});
					}
				}
			}
		}
	}
	return observations;
}

/** Solves the n × n system a·x = b (Gaussian elimination, partial pivoting). */
function solve(a: number[][], b: number[]): number[] | null {
	const n = b.length;
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let row = col + 1; row < n; row++) {
			if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
		}
		if (Math.abs(a[pivot][col]) < 1e-12) return null;
		[a[col], a[pivot]] = [a[pivot], a[col]];
		[b[col], b[pivot]] = [b[pivot], b[col]];
		for (let row = col + 1; row < n; row++) {
			const factor = a[row][col] / a[col][col];
			if (factor === 0) continue;
			for (let k = col; k < n; k++) a[row][k] -= factor * a[col][k];
			b[row] -= factor * b[col];
		}
	}
	const x = new Array<number>(n);
	for (let row = n - 1; row >= 0; row--) {
		let acc = b[row];
		for (let k = row + 1; k < n; k++) acc -= a[row][k] * x[k];
		x[row] = acc / a[row][row];
	}
	return x;
}

/**
 * Image → module space for the observations, by linear least squares on
 * u·w = g0·x + g1·y + g2 and v·w = g3·x + g4·y + g5, w = g6·x + g7·y + 1,
 * in normalised coordinates for numerical stability.
 */
function fitOnce(observations: Observation[], dimension: number): PerspectiveTransform | null {
	let mx = 0;
	let my = 0;
	for (const o of observations) {
		mx += o.x;
		my += o.y;
	}
	mx /= observations.length;
	my /= observations.length;
	let spread = 0;
	for (const o of observations) spread += Math.hypot(o.x - mx, o.y - my);
	const scale = spread / observations.length || 1;
	const half = dimension / 2;

	const ata = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
	const atb = new Array<number>(8).fill(0);
	const row = new Array<number>(8);
	for (const o of observations) {
		const x = (o.x - mx) / scale;
		const y = (o.y - my) / scale;
		const value = o.value / half - 1;
		row.fill(0);
		const base = o.axis === 'u' ? 0 : 3;
		row[base] = x;
		row[base + 1] = y;
		row[base + 2] = 1;
		row[6] = -value * x;
		row[7] = -value * y;
		for (let i = 0; i < 8; i++) {
			if (row[i] === 0) continue;
			const wi = o.weight * row[i];
			atb[i] += wi * value;
			for (let j = 0; j < 8; j++) ata[i][j] += wi * row[j];
		}
	}
	const g = solve(ata, atb);
	if (!g || g.some((value) => !Number.isFinite(value))) return null;

	const normalise = new PerspectiveTransform([
		1 / scale,
		0,
		0,
		0,
		1 / scale,
		0,
		-mx / scale,
		-my / scale,
		1
	]);
	const fitted = new PerspectiveTransform([g[0], g[3], g[6], g[1], g[4], g[7], g[2], g[5], 1]);
	const toModules = new PerspectiveTransform([half, 0, 0, 0, half, 0, half, half, 1]);
	return normalise.then(fitted).then(toModules);
}

const residual = (imageToModule: PerspectiveTransform, o: Observation): number => {
	const p = imageToModule.map(o.x, o.y);
	return Math.abs((o.axis === 'u' ? p.x : p.y) - o.value);
};

/**
 * The module space → image transform that best fits the observations,
 * refitted without outliers (edges a ray misread) until it settles.
 */
export function fitTransform(
	observations: Observation[],
	dimension: number
): PerspectiveTransform | null {
	let active = observations;
	let imageToModule: PerspectiveTransform | null = null;
	for (let round = 0; round < 4 && active.length >= 12; round++) {
		imageToModule = fitOnce(active, dimension);
		if (!imageToModule) return null;
		const fitted = imageToModule;
		const residuals = active.map((o) => residual(fitted, o));
		const sorted = [...residuals].sort((a, b) => a - b);
		const limit = Math.max(0.25, 3 * sorted[sorted.length >> 1]);
		const kept = active.filter((_, i) => residuals[i] <= limit);
		if (kept.length === active.length) break;
		active = kept;
	}
	return imageToModule?.inverse() ?? null;
}
