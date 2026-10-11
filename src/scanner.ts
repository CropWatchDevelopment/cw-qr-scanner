import type { BitMatrix } from './bit-matrix.js';
import { binarizeAdaptive, binarizeGlobal, MIN_BLOCK_CONTRAST } from './binarizer.js';
import { decodeGrid, type GridDecodeResult } from './decoder.js';
import { findFinderPatterns, rankTriples, type FinderTriple } from './finder.js';
import { PerspectiveTransform, type Point } from './geometry.js';
import { estimateNoise, halve, smooth, type GrayImage } from './image.js';
import {
	estimateDimension,
	finderEdges,
	fitTransform,
	pointObservations,
	type Observation
} from './locator.js';
import { findAlignmentPattern, sampleGrid, sampleGridGray, timingScore } from './sampler.js';
import { dimensionOf, MAX_VERSION, MIN_VERSION } from './version.js';

export interface QrCode extends GridDecodeResult {
	/** True when the symbol was printed or photographed mirror-image. */
	mirrored: boolean;
	/** The symbol's outer corners in image pixels (not including the quiet zone). */
	corners: { topLeft: Point; topRight: Point; bottomRight: Point; bottomLeft: Point };
}

export interface ScanOptions {
	/** Also look for light-on-dark codes. Default true. */
	tryInverted?: boolean;
	/** Run every fallback (more binarizations, half size). Default true. */
	tryHarder?: boolean;
}

const minus = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

/**
 * Transforms (module space → image) worth sampling for a symbol of this
 * size, best first. They are computed lazily: most codes decode on the first.
 *
 * 1. A least-squares fit to the finder patterns' edges plus the bottom-right
 *    alignment pattern, searched for where the edge fit predicts it.
 * 2. The classic four-point map through the three finder centres and the
 *    alignment pattern.
 * 3. The edge fit alone (version 1 has no alignment pattern).
 * 4. The affine map through the finder centres (the parallelogram).
 */
function* candidateTransforms(
	bits: BitMatrix,
	triple: FinderTriple,
	dimension: number
): Generator<PerspectiveTransform> {
	const { topLeft: tl, topRight: tr, bottomLeft: bl } = triple;
	const near = 3.5;
	const far = dimension - 3.5;
	const throughCentres = (fourth: Point, at: number) =>
		PerspectiveTransform.quadToQuad(
			[
				{ x: near, y: near },
				{ x: far, y: near },
				{ x: at, y: at },
				{ x: near, y: far }
			],
			[tl, tr, fourth, bl]
		);
	const parallelogram = throughCentres({ x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y }, far);

	const centres = [
		...pointObservations(tl, near, near, 4),
		...pointObservations(tr, far, near, 4),
		...pointObservations(bl, near, far, 4)
	];
	// Fit twice: the first fit's local axes aim the second round of rays better.
	let fitted = parallelogram;
	let edges: Observation[] = [];
	for (let round = 0; round < 2; round++) {
		edges = finderEdges(bits, fitted, dimension);
		fitted = fitTransform([...centres, ...edges], dimension) ?? fitted;
	}

	if (dimension > 21) {
		// The alignment centre sits at module (n − 6.5, n − 6.5).
		const at = dimension - 6.5;
		const estimate = fitted.map(at, at);
		const stepX = minus(fitted.map(at + 0.5, at), fitted.map(at - 0.5, at));
		const stepY = minus(fitted.map(at, at + 0.5), fitted.map(at, at - 0.5));
		const found =
			findAlignmentPattern(bits, estimate, stepX, stepY, 3) ??
			findAlignmentPattern(bits, estimate, stepX, stepY, 7);
		if (found) {
			const withAlignment = fitTransform(
				[...centres, ...edges, ...pointObservations(found, at, at, 12)],
				dimension
			);
			if (withAlignment) yield withAlignment;
			yield throughCentres(found, at);
		}
	}
	yield fitted;
	yield parallelogram;
}

/** Below this share of timing modules read right, a grid isn't worth decoding. */
const MIN_TIMING_SCORE = 0.6;

/** What a scan works from: the binarized image, plus the grey image it came from. */
export interface ScanSource {
	bits: BitMatrix;
	gray: GrayImage;
	/** The bits are the grey image inverted (a light-on-dark attempt). */
	inverted: boolean;
}

function decodeTriple(source: ScanSource, triple: FinderTriple): QrCode | null {
	const { bits, gray, inverted } = source;
	const estimated = Math.round((estimateDimension(bits, triple) - 17) / 4);
	const queue = [estimated, estimated + 1, estimated - 1, estimated + 2, estimated - 2].filter(
		(v) => v >= MIN_VERSION && v <= MAX_VERSION
	);
	const tried = new Set<number>();

	for (let q = 0; q < queue.length; q++) {
		const version = queue[q];
		if (tried.has(version)) continue;
		tried.add(version);
		const dimension = dimensionOf(version);

		for (const transform of candidateTransforms(bits, triple, dimension)) {
			// Small symbols are cheap to try; larger ones must show their timing patterns first.
			if (version >= 3 && timingScore(bits, transform, dimension) < MIN_TIMING_SCORE) continue;
			const readings = [
				() => sampleGrid(bits, transform, dimension),
				() => sampleGridGray(gray, transform, dimension, inverted)
			];
			for (const read of readings) {
				const grid = read();
				for (const mirrored of [false, true]) {
					const outcome = decodeGrid(mirrored ? grid.transposed() : grid);
					if (outcome.kind === 'resample') {
						// The symbol states its version: try that size next.
						if (!tried.has(outcome.version) && !queue.includes(outcome.version)) {
							queue.splice(q + 1, 0, outcome.version);
						}
						continue;
					}
					if (outcome.kind === 'decoded') {
						const topRight = transform.map(dimension, 0);
						const bottomLeft = transform.map(0, dimension);
						return {
							...outcome.result,
							mirrored,
							corners: {
								topLeft: transform.map(0, 0),
								topRight: mirrored ? bottomLeft : topRight,
								bottomRight: transform.map(dimension, dimension),
								bottomLeft: mirrored ? topRight : bottomLeft
							}
						};
					}
				}
			}
		}
	}
	return null;
}

const tripleKey = ({ topLeft, topRight, bottomLeft }: FinderTriple): string =>
	[topLeft, topRight, bottomLeft]
		.map((p) => `${Math.round(p.x / 3)},${Math.round(p.y / 3)}`)
		.join(' ');

/**
 * Finds finder patterns in a binarized image and decodes the best symbol.
 * Strict finder ratios first; then, if nothing decoded (and `thorough`, or
 * nothing was found at all), lenient ones for blurred or distorted patterns.
 */
export function scanBits(source: ScanSource, thorough = true): QrCode | null {
	const tried = new Set<string>();
	for (const tolerance of [0.5, 0.75]) {
		if (tolerance > 0.5 && !thorough && tried.size > 0) break;
		const triples = rankTriples(findFinderPatterns(source.bits, tolerance));
		for (const triple of triples) {
			const key = tripleKey(triple);
			if (tried.has(key)) continue;
			tried.add(key);
			const code = decodeTriple(source, triple);
			if (code) return code;
		}
	}
	return null;
}

const scale = (code: QrCode, factor: number): QrCode => {
	const s = (p: Point): Point => ({ x: p.x * factor, y: p.y * factor });
	return {
		...code,
		corners: {
			topLeft: s(code.corners.topLeft),
			topRight: s(code.corners.topRight),
			bottomRight: s(code.corners.bottomRight),
			bottomLeft: s(code.corners.bottomLeft)
		}
	};
};

interface Prepared {
	/** The image as given. */
	image: GrayImage;
	/** The image to threshold: smoothed when noisy. */
	gray: GrayImage;
	/** Block contrast that counts as an edge. */
	minContrast: number;
	smoothed: boolean;
}

/**
 * The grey image to threshold, and the block contrast that counts as an edge:
 * noisy images are smoothed first and need more contrast, so sensor noise
 * can't punch holes in finder patterns or speckle the background.
 */
function prepare(image: GrayImage): Prepared {
	const noise = estimateNoise(image);
	if (noise < 4) return { image, gray: image, minContrast: MIN_BLOCK_CONTRAST, smoothed: false };
	return {
		image,
		gray: smooth(image),
		minContrast: Math.max(MIN_BLOCK_CONTRAST, Math.round(2 * noise)),
		smoothed: true
	};
}

/** Dark-on-light, then (when wanted) light-on-dark, from one binarization. */
function readBoth(gray: GrayImage, bits: BitMatrix, inverted: boolean, thorough: boolean) {
	return (
		scanBits({ bits, gray, inverted: false }, thorough) ??
		(inverted ? scanBits({ bits: bits.inverted(), gray, inverted: true }, thorough) : null)
	);
}

/** A half-size copy: averages away noise and brings huge modules down to size. */
function readHalf(image: GrayImage, inverted: boolean): QrCode | null {
	if (Math.min(image.width, image.height) < 200) return null;
	const half = prepare(halve(image));
	const code =
		readBoth(half.gray, binarizeAdaptive(half.gray, 8, half.minContrast), inverted, true) ??
		readBoth(half.gray, binarizeGlobal(half.gray), inverted, true);
	return code && scale(code, 2);
}

/**
 * Decodes the first QR code found in a luminance image, trying progressively
 * more forgiving strategies: local thresholds, one global threshold, other
 * block sizes, the unsmoothed image, light-on-dark, and a half-size copy.
 */
export function scanGray(image: GrayImage, options: ScanOptions = {}): QrCode | null {
	const inverted = options.tryInverted !== false;
	const tryHarder = options.tryHarder !== false;
	const frame = prepare(image);
	const { gray, minContrast } = frame;

	const main = readBoth(gray, binarizeAdaptive(gray, 8, minContrast), inverted, tryHarder);
	if (main || !tryHarder) return main;
	for (const fallback of FALLBACKS) {
		const code = fallback(frame, inverted);
		if (code) return code;
	}
	return null;
}

/** The slower strategies, each a separate chance at a frame the main one missed. */
const FALLBACKS: ((frame: Prepared, inverted: boolean) => QrCode | null)[] = [
	({ gray }, inverted) => readBoth(gray, binarizeGlobal(gray), inverted, true),
	({ gray, minContrast }, inverted) =>
		readBoth(gray, binarizeAdaptive(gray, 4, minContrast), inverted, true),
	({ gray, minContrast }, inverted) =>
		readBoth(gray, binarizeAdaptive(gray, 16, minContrast), inverted, true),
	// Smoothing costs the finest detail: tiny modules may read better raw.
	({ image, minContrast, smoothed }, inverted) =>
		smoothed ? readBoth(image, binarizeAdaptive(image, 8, minContrast), inverted, true) : null,
	({ image }, inverted) => readHalf(image, inverted)
];

/**
 * For live video: every frame gets the fast main strategy, and one of the
 * slower fallbacks in turn, so a few consecutive frames cover everything
 * {@link scanGray} tries on a still image while each frame stays quick.
 */
export function createFrameScanner(): (image: GrayImage) => QrCode | null {
	let turn = 0;
	return (image) => {
		const frame = prepare(image);
		const bits = binarizeAdaptive(frame.gray, 8, frame.minContrast);
		const main = scanBits({ bits, gray: frame.gray, inverted: false }, false);
		if (main) return main;
		// Light-on-dark gets every other turn; the fallbacks share the rest.
		const step = turn++;
		if (step % 2 === 0)
			return scanBits({ bits: bits.inverted(), gray: frame.gray, inverted: true }, true);
		return FALLBACKS[(step >> 1) % FALLBACKS.length](frame, false);
	};
}
