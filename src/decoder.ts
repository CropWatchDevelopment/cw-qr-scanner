import type { BitMatrix } from './bit-matrix.js';
import { decodeData } from './data.js';
import { decodeFormat, decodeVersion, readFormatBits, readVersionBits } from './format.js';
import { correctErrors } from './reed-solomon.js';
import {
	correctableErrors,
	errorCorrectionBlocks,
	functionPatternMask,
	totalCodewords,
	versionOfDimension,
	type ErrorCorrectionLevel
} from './version.js';

/** Whether data mask `mask` flips the module at (row, column) — §7.8.2. */
function maskFlips(mask: number, row: number, column: number): boolean {
	switch (mask) {
		case 0:
			return (row + column) % 2 === 0;
		case 1:
			return row % 2 === 0;
		case 2:
			return column % 3 === 0;
		case 3:
			return (row + column) % 3 === 0;
		case 4:
			return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
		case 5:
			return ((row * column) % 2) + ((row * column) % 3) === 0;
		case 6:
			return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
		default:
			return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
	}
}

/**
 * Reads the codewords in placement order (§7.7.3): two-module-wide columns
 * from the right edge, alternating upwards and downwards, skipping the
 * vertical timing column and every function module; unmasking as it goes.
 */
export function readCodewords(grid: BitMatrix, version: number, mask: number): Uint8Array {
	const n = grid.width;
	const reserved = functionPatternMask(version);
	const codewords = new Uint8Array(totalCodewords(version));
	let index = 0;
	let current = 0;
	let bits = 0;
	let upwards = true;
	for (let right = n - 1; right > 0; right -= 2) {
		if (right === 6) right = 5;
		for (let step = 0; step < n; step++) {
			const y = upwards ? n - 1 - step : step;
			for (let c = 0; c < 2; c++) {
				const x = right - c;
				if (reserved.get(x, y)) continue;
				const dark = grid.get(x, y) !== maskFlips(mask, y, x);
				current = (current << 1) | (dark ? 1 : 0);
				if (++bits === 8) {
					if (index < codewords.length) codewords[index++] = current;
					current = 0;
					bits = 0;
				}
			}
		}
		upwards = !upwards;
	}
	return codewords;
}

interface Block {
	codewords: Uint8Array;
	dataCount: number;
}

/** Undoes the interleaving of data and EC codewords across blocks (§7.6). */
function deinterleave(codewords: Uint8Array, version: number, level: ErrorCorrectionLevel) {
	const { ecPerBlock, groups } = errorCorrectionBlocks(version, level);
	const blocks: Block[] = [];
	for (const [count, dataCount] of groups) {
		for (let i = 0; i < count; i++) {
			blocks.push({ codewords: new Uint8Array(dataCount + ecPerBlock), dataCount });
		}
	}
	const longest = Math.max(...blocks.map((block) => block.dataCount));
	let k = 0;
	for (let i = 0; i < longest; i++) {
		for (const block of blocks) if (i < block.dataCount) block.codewords[i] = codewords[k++];
	}
	for (let i = 0; i < ecPerBlock; i++) {
		for (const block of blocks) block.codewords[block.dataCount + i] = codewords[k++];
	}
	return { blocks, ecPerBlock };
}

export interface GridDecodeResult {
	text: string;
	bytes: Uint8Array;
	version: number;
	errorCorrectionLevel: ErrorCorrectionLevel;
	mask: number;
	correctedCodewords: number;
}

export type GridDecodeOutcome =
	| { kind: 'decoded'; result: GridDecodeResult }
	/** The version information names another version: sample again at that size. */
	| { kind: 'resample'; version: number }
	| { kind: 'failed' };

/** Decodes a sampled module grid (dark = true), top-left finder at (0, 0). */
export function decodeGrid(grid: BitMatrix): GridDecodeOutcome {
	const dimensionVersion = versionOfDimension(grid.width);
	if (dimensionVersion === null || grid.width !== grid.height) return { kind: 'failed' };

	const format = decodeFormat(...readFormatBits(grid));
	if (!format) return { kind: 'failed' };

	const version = dimensionVersion;
	if (version >= 7) {
		const stated = decodeVersion(...readVersionBits(grid));
		if (stated !== null && stated !== version) return { kind: 'resample', version: stated };
	}

	const { blocks, ecPerBlock } = deinterleave(
		readCodewords(grid, version, format.mask),
		version,
		format.level
	);
	const maxErrors = correctableErrors(version, format.level);
	let corrected = 0;
	const data: number[] = [];
	for (const block of blocks) {
		const fixed = correctErrors(block.codewords, ecPerBlock, maxErrors);
		if (fixed < 0) return { kind: 'failed' };
		corrected += fixed;
		for (let i = 0; i < block.dataCount; i++) data.push(block.codewords[i]);
	}

	const decoded = decodeData(Uint8Array.from(data), version);
	if (!decoded) return { kind: 'failed' };
	return {
		kind: 'decoded',
		result: {
			text: decoded.text,
			bytes: decoded.bytes,
			version,
			errorCorrectionLevel: format.level,
			mask: format.mask,
			correctedCodewords: corrected
		}
	};
}
