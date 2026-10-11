import type { BitMatrix } from './bit-matrix.js';
import type { ErrorCorrectionLevel } from './version.js';

/**
 * Format information (15 bits: EC level, mask, 10-bit BCH check, XOR-masked)
 * and version information (18 bits: version, 12-bit Golay check), per
 * ISO/IEC 18004 §7.9 and §7.10. Both are stored twice in every symbol and
 * read back by nearest valid codeword, which corrects up to 3 bit errors.
 */

const FORMAT_GENERATOR = 0b10100110111; // x^10 + x^8 + x^5 + x^4 + x^2 + x + 1
const FORMAT_MASK = 0b101010000010010;
const VERSION_GENERATOR = 0b1111100100101; // x^12 + x^11 + x^10 + x^9 + x^8 + x^5 + x^2 + 1

/** EC level by its 2-bit indicator. */
const LEVEL_BY_BITS: ErrorCorrectionLevel[] = ['M', 'L', 'H', 'Q'];

/** Remainder of `value` divided by `generator` over GF(2). */
function remainder(value: number, generator: number): number {
	const degree = 31 - Math.clz32(generator);
	let rest = value;
	for (let bit = 31 - Math.clz32(rest); bit >= degree; bit--) {
		if (rest & (1 << bit)) rest ^= generator << (bit - degree);
	}
	return rest;
}

const popcount = (value: number): number => {
	let v = value;
	let count = 0;
	while (v) {
		v &= v - 1;
		count++;
	}
	return count;
};

/** The 32 valid format codewords, indexed by their 5 data bits. */
const FORMAT_CODEWORDS = Array.from({ length: 32 }, (_, data) => {
	const shifted = data << 10;
	return (shifted | remainder(shifted, FORMAT_GENERATOR)) ^ FORMAT_MASK;
});

/** Valid version codewords for versions 7–40. */
const VERSION_CODEWORDS = Array.from({ length: 34 }, (_, i) => {
	const shifted = (i + 7) << 12;
	return shifted | remainder(shifted, VERSION_GENERATOR);
});

export interface FormatInformation {
	level: ErrorCorrectionLevel;
	mask: number;
}

/** Nearest valid format codeword to either copy, within 3 bit errors. */
export function decodeFormat(copy1: number, copy2: number): FormatInformation | null {
	let best = -1;
	let bestDistance = 4;
	for (let data = 0; data < 32; data++) {
		const codeword = FORMAT_CODEWORDS[data];
		const distance = Math.min(popcount(codeword ^ copy1), popcount(codeword ^ copy2));
		if (distance < bestDistance) {
			bestDistance = distance;
			best = data;
		}
	}
	if (best < 0) return null;
	return { level: LEVEL_BY_BITS[best >> 3], mask: best & 7 };
}

/** Nearest valid version (7–40) to either copy, within 3 bit errors. */
export function decodeVersion(copy1: number, copy2: number): number | null {
	let best: number | null = null;
	let bestDistance = 4;
	for (let i = 0; i < VERSION_CODEWORDS.length; i++) {
		const codeword = VERSION_CODEWORDS[i];
		const distance = Math.min(popcount(codeword ^ copy1), popcount(codeword ^ copy2));
		if (distance < bestDistance) {
			bestDistance = distance;
			best = i + 7;
		}
	}
	return best;
}

/**
 * Both copies of the format information, most significant bit first.
 * Copy 1 wraps the top-left finder: row 8 left to right (skipping the
 * timing column), then column 8 upwards. Copy 2 is split: column 8 from the
 * bottom edge upwards (beside the bottom-left finder), then row 8 left to
 * right beside the top-right finder.
 */
export function readFormatBits(grid: BitMatrix): [number, number] {
	const n = grid.width;
	let copy1 = 0;
	const read1 = (x: number, y: number) => (copy1 = (copy1 << 1) | (grid.get(x, y) ? 1 : 0));
	for (let x = 0; x <= 5; x++) read1(x, 8);
	read1(7, 8);
	read1(8, 8);
	read1(8, 7);
	for (let y = 5; y >= 0; y--) read1(8, y);

	let copy2 = 0;
	const read2 = (x: number, y: number) => (copy2 = (copy2 << 1) | (grid.get(x, y) ? 1 : 0));
	for (let y = n - 1; y >= n - 7; y--) read2(8, y);
	for (let x = n - 8; x < n; x++) read2(x, 8);
	return [copy1, copy2];
}

/**
 * Both copies of the version information (version 7+), most significant bit
 * first: the 3 × 6 block left of the top-right finder and the 6 × 3 block
 * above the bottom-left finder.
 */
export function readVersionBits(grid: BitMatrix): [number, number] {
	const n = grid.width;
	let topRight = 0;
	for (let y = 5; y >= 0; y--) {
		for (let x = n - 9; x >= n - 11; x--) topRight = (topRight << 1) | (grid.get(x, y) ? 1 : 0);
	}
	let bottomLeft = 0;
	for (let x = 5; x >= 0; x--) {
		for (let y = n - 9; y >= n - 11; y--) bottomLeft = (bottomLeft << 1) | (grid.get(x, y) ? 1 : 0);
	}
	return [topRight, bottomLeft];
}
