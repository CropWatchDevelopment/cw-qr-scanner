import { BitMatrix } from './bit-matrix.js';

export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export interface ErrorCorrectionBlocks {
	/** Error-correction codewords in every block. */
	ecPerBlock: number;
	/** Groups of blocks: [how many blocks, data codewords in each]. */
	groups: [number, number][];
}

/**
 * Per version (1–40), ISO/IEC 18004 tables 9 and E.1:
 * alignment pattern centres, then for L, M, Q and H
 * [EC codewords per block, blocks, data codewords (, blocks, data codewords)].
 */
// prettier-ignore
const VERSIONS: [number[], number[], number[], number[], number[]][] = [
	/*  1 */ [[], [7, 1, 19], [10, 1, 16], [13, 1, 13], [17, 1, 9]],
	/*  2 */ [[6, 18], [10, 1, 34], [16, 1, 28], [22, 1, 22], [28, 1, 16]],
	/*  3 */ [[6, 22], [15, 1, 55], [26, 1, 44], [18, 2, 17], [22, 2, 13]],
	/*  4 */ [[6, 26], [20, 1, 80], [18, 2, 32], [26, 2, 24], [16, 4, 9]],
	/*  5 */ [[6, 30], [26, 1, 108], [24, 2, 43], [18, 2, 15, 2, 16], [22, 2, 11, 2, 12]],
	/*  6 */ [[6, 34], [18, 2, 68], [16, 4, 27], [24, 4, 19], [28, 4, 15]],
	/*  7 */ [[6, 22, 38], [20, 2, 78], [18, 4, 31], [18, 2, 14, 4, 15], [26, 4, 13, 1, 14]],
	/*  8 */ [[6, 24, 42], [24, 2, 97], [22, 2, 38, 2, 39], [22, 4, 18, 2, 19], [26, 4, 14, 2, 15]],
	/*  9 */ [[6, 26, 46], [30, 2, 116], [22, 3, 36, 2, 37], [20, 4, 16, 4, 17], [24, 4, 12, 4, 13]],
	/* 10 */ [[6, 28, 50], [18, 2, 68, 2, 69], [26, 4, 43, 1, 44], [24, 6, 19, 2, 20], [28, 6, 15, 2, 16]],
	/* 11 */ [[6, 30, 54], [20, 4, 81], [30, 1, 50, 4, 51], [28, 4, 22, 4, 23], [24, 3, 12, 8, 13]],
	/* 12 */ [[6, 32, 58], [24, 2, 92, 2, 93], [22, 6, 36, 2, 37], [26, 4, 20, 6, 21], [28, 7, 14, 4, 15]],
	/* 13 */ [[6, 34, 62], [26, 4, 107], [22, 8, 37, 1, 38], [24, 8, 20, 4, 21], [22, 12, 11, 4, 12]],
	/* 14 */ [[6, 26, 46, 66], [30, 3, 115, 1, 116], [24, 4, 40, 5, 41], [20, 11, 16, 5, 17], [24, 11, 12, 5, 13]],
	/* 15 */ [[6, 26, 48, 70], [22, 5, 87, 1, 88], [24, 5, 41, 5, 42], [30, 5, 24, 7, 25], [24, 11, 12, 7, 13]],
	/* 16 */ [[6, 26, 50, 74], [24, 5, 98, 1, 99], [28, 7, 45, 3, 46], [24, 15, 19, 2, 20], [30, 3, 15, 13, 16]],
	/* 17 */ [[6, 30, 54, 78], [28, 1, 107, 5, 108], [28, 10, 46, 1, 47], [28, 1, 22, 15, 23], [28, 2, 14, 17, 15]],
	/* 18 */ [[6, 30, 56, 82], [30, 5, 120, 1, 121], [26, 9, 43, 4, 44], [28, 17, 22, 1, 23], [28, 2, 14, 19, 15]],
	/* 19 */ [[6, 30, 58, 86], [28, 3, 113, 4, 114], [26, 3, 44, 11, 45], [26, 17, 21, 4, 22], [26, 9, 13, 16, 14]],
	/* 20 */ [[6, 34, 62, 90], [28, 3, 107, 5, 108], [26, 3, 41, 13, 42], [30, 15, 24, 5, 25], [28, 15, 15, 10, 16]],
	/* 21 */ [[6, 28, 50, 72, 94], [28, 4, 116, 4, 117], [26, 17, 42], [28, 17, 22, 6, 23], [30, 19, 16, 6, 17]],
	/* 22 */ [[6, 26, 50, 74, 98], [28, 2, 111, 7, 112], [28, 17, 46], [30, 7, 24, 16, 25], [24, 34, 13]],
	/* 23 */ [[6, 30, 54, 78, 102], [30, 4, 121, 5, 122], [28, 4, 47, 14, 48], [30, 11, 24, 14, 25], [30, 16, 15, 14, 16]],
	/* 24 */ [[6, 28, 54, 80, 106], [30, 6, 117, 4, 118], [28, 6, 45, 14, 46], [30, 11, 24, 16, 25], [30, 30, 16, 2, 17]],
	/* 25 */ [[6, 32, 58, 84, 110], [26, 8, 106, 4, 107], [28, 8, 47, 13, 48], [30, 7, 24, 22, 25], [30, 22, 15, 13, 16]],
	/* 26 */ [[6, 30, 58, 86, 114], [28, 10, 114, 2, 115], [28, 19, 46, 4, 47], [28, 28, 22, 6, 23], [30, 33, 16, 4, 17]],
	/* 27 */ [[6, 34, 62, 90, 118], [30, 8, 122, 4, 123], [28, 22, 45, 3, 46], [30, 8, 23, 26, 24], [30, 12, 15, 28, 16]],
	/* 28 */ [[6, 26, 50, 74, 98, 122], [30, 3, 117, 10, 118], [28, 3, 45, 23, 46], [30, 4, 24, 31, 25], [30, 11, 15, 31, 16]],
	/* 29 */ [[6, 30, 54, 78, 102, 126], [30, 7, 116, 7, 117], [28, 21, 45, 7, 46], [30, 1, 23, 37, 24], [30, 19, 15, 26, 16]],
	/* 30 */ [[6, 26, 52, 78, 104, 130], [30, 5, 115, 10, 116], [28, 19, 47, 10, 48], [30, 15, 24, 25, 25], [30, 23, 15, 25, 16]],
	/* 31 */ [[6, 30, 56, 82, 108, 134], [30, 13, 115, 3, 116], [28, 2, 46, 29, 47], [30, 42, 24, 1, 25], [30, 23, 15, 28, 16]],
	/* 32 */ [[6, 34, 60, 86, 112, 138], [30, 17, 115], [28, 10, 46, 23, 47], [30, 10, 24, 35, 25], [30, 19, 15, 35, 16]],
	/* 33 */ [[6, 30, 58, 86, 114, 142], [30, 17, 115, 1, 116], [28, 14, 46, 21, 47], [30, 29, 24, 19, 25], [30, 11, 15, 46, 16]],
	/* 34 */ [[6, 34, 62, 90, 118, 146], [30, 13, 115, 6, 116], [28, 14, 46, 23, 47], [30, 44, 24, 7, 25], [30, 59, 16, 1, 17]],
	/* 35 */ [[6, 30, 54, 78, 102, 126, 150], [30, 12, 121, 7, 122], [28, 12, 47, 26, 48], [30, 39, 24, 14, 25], [30, 22, 15, 41, 16]],
	/* 36 */ [[6, 24, 50, 76, 102, 128, 154], [30, 6, 121, 14, 122], [28, 6, 47, 34, 48], [30, 46, 24, 10, 25], [30, 2, 15, 64, 16]],
	/* 37 */ [[6, 28, 54, 80, 106, 132, 158], [30, 17, 122, 4, 123], [28, 29, 46, 14, 47], [30, 49, 24, 10, 25], [30, 24, 15, 46, 16]],
	/* 38 */ [[6, 32, 58, 84, 110, 136, 162], [30, 4, 122, 18, 123], [28, 13, 46, 32, 47], [30, 48, 24, 14, 25], [30, 42, 15, 32, 16]],
	/* 39 */ [[6, 26, 54, 82, 110, 138, 166], [30, 20, 117, 4, 118], [28, 40, 47, 7, 48], [30, 43, 24, 22, 25], [30, 10, 15, 67, 16]],
	/* 40 */ [[6, 30, 58, 86, 114, 142, 170], [30, 19, 118, 6, 119], [28, 18, 47, 31, 48], [30, 34, 24, 34, 25], [30, 20, 15, 61, 16]],
];

const LEVEL_INDEX: Record<ErrorCorrectionLevel, number> = { L: 1, M: 2, Q: 3, H: 4 };

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

export const dimensionOf = (version: number): number => 17 + 4 * version;

export function versionOfDimension(dimension: number): number | null {
	const version = (dimension - 17) / 4;
	return Number.isInteger(version) && version >= MIN_VERSION && version <= MAX_VERSION
		? version
		: null;
}

export function alignmentCentres(version: number): number[] {
	return VERSIONS[version - 1][0];
}

export function errorCorrectionBlocks(
	version: number,
	level: ErrorCorrectionLevel
): ErrorCorrectionBlocks {
	const [ecPerBlock, ...rest] = VERSIONS[version - 1][LEVEL_INDEX[level]];
	const groups: [number, number][] = [];
	for (let i = 0; i < rest.length; i += 2) groups.push([rest[i], rest[i + 1]]);
	return { ecPerBlock, groups };
}

/**
 * Codewords the smallest symbols set aside to detect rather than correct
 * errors, so noise is less likely to decode as a wrong message
 * (ISO/IEC 18004 table 9, the "p" column).
 */
const MISDECODE_PROTECTION: Record<string, number> = {
	'1L': 3,
	'1M': 2,
	'1Q': 1,
	'1H': 1,
	'2L': 2,
	'3L': 1
};

/** Errors a single block of this version and level may have corrected. */
export function correctableErrors(version: number, level: ErrorCorrectionLevel): number {
	const { ecPerBlock } = errorCorrectionBlocks(version, level);
	return Math.floor((ecPerBlock - (MISDECODE_PROTECTION[`${version}${level}`] ?? 0)) / 2);
}

/** All codewords (data + error correction) a version holds. */
export function totalCodewords(version: number): number {
	const { ecPerBlock, groups } = errorCorrectionBlocks(version, 'L');
	return groups.reduce((total, [count, data]) => total + count * (data + ecPerBlock), 0);
}

const functionPatternCache = new Map<number, BitMatrix>();

/**
 * Modules that carry no data: finder patterns with their separators and the
 * format information beside them, timing patterns, alignment patterns,
 * version information (version 7+) and the dark module.
 */
export function functionPatternMask(version: number): BitMatrix {
	const cached = functionPatternCache.get(version);
	if (cached) return cached;
	const n = dimensionOf(version);
	const mask = new BitMatrix(n, n);
	const fill = (x: number, y: number, width: number, height: number) => {
		for (let yy = y; yy < y + height; yy++) {
			for (let xx = x; xx < x + width; xx++) mask.set(xx, yy, true);
		}
	};
	fill(0, 0, 9, 9); // top-left finder, separator, format information
	fill(n - 8, 0, 8, 9); // top-right finder, separator, format information
	fill(0, n - 8, 9, 8); // bottom-left finder, separator, format information, dark module
	fill(6, 9, 1, n - 17); // vertical timing pattern
	fill(9, 6, n - 17, 1); // horizontal timing pattern
	const centres = alignmentCentres(version);
	const last = centres.length - 1;
	for (let i = 0; i < centres.length; i++) {
		for (let j = 0; j < centres.length; j++) {
			// The three positions under finder patterns carry no alignment pattern.
			if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
			fill(centres[i] - 2, centres[j] - 2, 5, 5);
		}
	}
	if (version >= 7) {
		fill(n - 11, 0, 3, 6); // version information, top right
		fill(0, n - 11, 6, 3); // version information, bottom left
	}
	functionPatternCache.set(version, mask);
	return mask;
}
