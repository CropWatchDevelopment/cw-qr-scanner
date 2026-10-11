import { BitMatrix } from './bit-matrix.js';
import type { Point, PerspectiveTransform } from './geometry.js';
import { sampleBilinear, type GrayImage } from './image.js';

/**
 * Looks for the bottom-right alignment pattern (5 × 5 modules: dark ring,
 * light ring, dark centre) around `estimate`, by matching that template along
 * the symbol's own axes — `stepX` / `stepY` are one module along each — so
 * rotation and skew don't matter. Returns the best-matching centre, or null
 * when nothing in the window looks like an alignment pattern.
 */
export function findAlignmentPattern(
	bits: BitMatrix,
	estimate: Point,
	stepX: Point,
	stepY: Point,
	radiusModules: number
): Point | null {
	const moduleSize = (Math.hypot(stepX.x, stepX.y) + Math.hypot(stepY.x, stepY.y)) / 2;
	const radius = Math.max(2, Math.ceil(radiusModules * moduleSize));

	const score = (cx: number, cy: number): number => {
		let matches = 0;
		for (let j = -2; j <= 2; j++) {
			for (let i = -2; i <= 2; i++) {
				const ring = Math.max(Math.abs(i), Math.abs(j));
				const shouldBeDark = ring !== 1;
				const x = cx + i * stepX.x + j * stepY.x;
				const y = cy + i * stepX.y + j * stepY.y;
				if (bits.get(Math.floor(x), Math.floor(y)) === shouldBeDark) matches++;
			}
		}
		return matches;
	};

	// Coarse pass a few pixels at a time, then every pixel around the winners.
	const coarse = Math.max(1, Math.floor(moduleSize / 3));
	let bestScore = -1;
	let candidates: Point[] = [];
	for (let dy = -radius; dy <= radius; dy += coarse) {
		for (let dx = -radius; dx <= radius; dx += coarse) {
			const s = score(estimate.x + dx, estimate.y + dy);
			if (s > bestScore) {
				bestScore = s;
				candidates = [{ x: estimate.x + dx, y: estimate.y + dy }];
			} else if (s === bestScore) {
				candidates.push({ x: estimate.x + dx, y: estimate.y + dy });
			}
		}
	}
	if (bestScore < 21) return null;

	// Refine around the candidate nearest the estimate.
	candidates.sort(
		(a, b) =>
			Math.hypot(a.x - estimate.x, a.y - estimate.y) -
			Math.hypot(b.x - estimate.x, b.y - estimate.y)
	);
	const seed = candidates[0];
	let best = -1;
	let sumX = 0;
	let sumY = 0;
	let count = 0;
	for (let dy = -coarse; dy <= coarse; dy++) {
		for (let dx = -coarse; dx <= coarse; dx++) {
			const s = score(seed.x + dx, seed.y + dy);
			if (s > best) {
				best = s;
				sumX = seed.x + dx;
				sumY = seed.y + dy;
				count = 1;
			} else if (s === best) {
				sumX += seed.x + dx;
				sumY += seed.y + dy;
				count++;
			}
		}
	}
	// Every position scoring best lies inside the centre module: their mean is
	// the pattern's centre.
	return { x: sumX / count, y: sumY / count };
}

/**
 * Samples a dimension × dimension module grid through `transform` (module
 * space → image). Each module is the majority of five points around its
 * centre, which rides out noise and a little blur.
 */
export function sampleGrid(
	bits: BitMatrix,
	transform: PerspectiveTransform,
	dimension: number
): BitMatrix {
	const grid = new BitMatrix(dimension, dimension);
	const offsets = [
		[0, 0],
		[-0.22, 0],
		[0.22, 0],
		[0, -0.22],
		[0, 0.22]
	];
	for (let y = 0; y < dimension; y++) {
		for (let x = 0; x < dimension; x++) {
			let dark = 0;
			for (const [ox, oy] of offsets) {
				const p = transform.map(x + 0.5 + ox, y + 0.5 + oy);
				if (bits.get(Math.floor(p.x), Math.floor(p.y))) dark++;
			}
			grid.set(x, y, dark >= 3);
		}
	}
	return grid;
}

/**
 * Reads the module grid from the grey image instead of the binarized one:
 * each module's grey level (averaged over its centre) is compared with the
 * midpoint of the darkest and lightest modules around it. Thresholds measured
 * on the module grid follow blur, glare and shading that a pixel-level
 * threshold gets wrong, which rescues soft-focus and unevenly lit codes.
 * `invert` reads light-on-dark codes.
 */
export function sampleGridGray(
	image: GrayImage,
	transform: PerspectiveTransform,
	dimension: number,
	invert = false
): BitMatrix {
	const n = dimension;
	const values = new Float32Array(n * n);
	const offsets = [
		[0, 0],
		[-0.2, 0],
		[0.2, 0],
		[0, -0.2],
		[0, 0.2]
	];
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			let sum = 0;
			for (const [ox, oy] of offsets) {
				const p = transform.map(x + 0.5 + ox, y + 0.5 + oy);
				sum += sampleBilinear(image, p.x, p.y);
			}
			values[y * n + x] = invert ? 255 - sum / 5 : sum / 5;
		}
	}

	// One threshold per 3 × 3 modules, from the darkest and lightest fifth of
	// the modules within 4 (or, in flat areas, more) modules of it.
	const grid = new BitMatrix(n, n);
	const window: number[] = [];
	for (let by = 0; by < n; by += 3) {
		for (let bx = 0; bx < n; bx += 3) {
			let threshold = 0;
			for (let r = 4; ; r *= 2) {
				window.length = 0;
				for (let v = Math.max(0, by + 1 - r); v <= Math.min(n - 1, by + 1 + r); v++) {
					for (let u = Math.max(0, bx + 1 - r); u <= Math.min(n - 1, bx + 1 + r); u++) {
						window.push(values[v * n + u]);
					}
				}
				window.sort((a, b) => a - b);
				const k = Math.max(1, Math.floor(window.length / 5));
				let low = 0;
				let high = 0;
				for (let i = 0; i < k; i++) {
					low += window[i];
					high += window[window.length - 1 - i];
				}
				threshold = (low + high) / (2 * k);
				if ((high - low) / k >= 12 || r >= n) break;
			}
			for (let y = by; y < Math.min(n, by + 3); y++) {
				for (let x = bx; x < Math.min(n, bx + 3); x++)
					grid.set(x, y, values[y * n + x] < threshold);
			}
		}
	}
	return grid;
}

/**
 * Share of the timing patterns' modules (row and column 6 between the finder
 * patterns, alternating dark and light) that read correctly through
 * `transform`. A grid of the wrong size or in the wrong place reads them about
 * half right, so this rejects hopeless candidates before a full sample.
 */
export function timingScore(
	bits: BitMatrix,
	transform: PerspectiveTransform,
	dimension: number
): number {
	let right = 0;
	let total = 0;
	for (let i = 8; i <= dimension - 9; i++) {
		const dark = i % 2 === 0;
		const along = transform.map(i + 0.5, 6.5);
		const down = transform.map(6.5, i + 0.5);
		if (bits.get(Math.floor(along.x), Math.floor(along.y)) === dark) right++;
		if (bits.get(Math.floor(down.x), Math.floor(down.y)) === dark) right++;
		total += 2;
	}
	return right / total;
}
