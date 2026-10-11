import { describe, expect, it } from 'vitest';
import { correctErrors } from '../src/reed-solomon';
import { decodeFormat, decodeVersion } from '../src/format';
import {
	dimensionOf,
	errorCorrectionBlocks,
	functionPatternMask,
	totalCodewords,
	type ErrorCorrectionLevel
} from '../src/version';
import { random, rsEncode } from './helpers';

const LEVELS: ErrorCorrectionLevel[] = ['L', 'M', 'Q', 'H'];

describe('version tables', () => {
	it('match the data capacity of every version’s own module layout', () => {
		for (let version = 1; version <= 40; version++) {
			const mask = functionPatternMask(version);
			let dataModules = 0;
			for (const cell of mask.data) if (cell === 0) dataModules++;
			expect(Math.floor(dataModules / 8), `version ${version}`).toBe(totalCodewords(version));
		}
	});

	it('give every level the same total', () => {
		for (let version = 1; version <= 40; version++) {
			for (const level of LEVELS) {
				const { ecPerBlock, groups } = errorCorrectionBlocks(version, level);
				const total = groups.reduce((sum, [count, data]) => sum + count * (data + ecPerBlock), 0);
				expect(total, `version ${version}-${level}`).toBe(totalCodewords(version));
			}
		}
	});

	it('size symbols as 17 + 4 × version', () => {
		expect(dimensionOf(1)).toBe(21);
		expect(dimensionOf(40)).toBe(177);
	});
});

describe('format and version information', () => {
	it('recovers the format from a copy with 3 flipped bits', () => {
		// M (00) with mask 5: data 0b00101 → known codeword 0b100000011001110.
		const codeword = 0b100000011001110;
		expect(decodeFormat(codeword ^ 0b100100000000001, 0)).toEqual({ level: 'M', mask: 5 });
	});

	it('maps every 15-bit word to the codeword within 3 bits, or to nothing', () => {
		// Independent BCH(15,5) encoder: generator 0x537, then the 0x5412 mask.
		const encode = (data: number) => {
			let rest = data << 10;
			for (let bit = 14; bit >= 10; bit--) if (rest & (1 << bit)) rest ^= 0x537 << (bit - 10);
			return ((data << 10) | rest) ^ 0x5412;
		};
		const codewords = Array.from({ length: 32 }, (_, data) => encode(data));
		const bitCount = (value: number) => {
			let count = 0;
			for (let v = value; v; v &= v - 1) count++;
			return count;
		};
		const levels = ['M', 'L', 'H', 'Q'];
		const wrong: number[] = [];
		for (let word = 0; word < 1 << 15; word++) {
			const near = codewords.findIndex((codeword) => bitCount(codeword ^ word) <= 3);
			const expected = near < 0 ? null : { level: levels[near >> 3], mask: near & 7 };
			const actual = decodeFormat(word, word);
			if (JSON.stringify(actual) !== JSON.stringify(expected)) wrong.push(word);
		}
		expect(wrong).toEqual([]);
	});

	it('uses whichever copy is readable', () => {
		const codeword = 0b100000011001110; // M, mask 5
		expect(decodeFormat(codeword ^ 0b111111000000000, codeword ^ 0b11)).toEqual({
			level: 'M',
			mask: 5
		});
	});

	it('recovers versions 7–40 within 3 bit errors', () => {
		// Version 7's codeword is 0x07C94 (ISO/IEC 18004 table D.1).
		expect(decodeVersion(0x07c94, 0)).toBe(7);
		expect(decodeVersion(0x07c94 ^ 0b100000001000000001, 0)).toBe(7);
	});
});

describe('Reed–Solomon', () => {
	it('corrects up to ecCount / 2 errors anywhere in the block', () => {
		const rng = random(42);
		for (let trial = 0; trial < 200; trial++) {
			const ecCount = 2 * (1 + Math.floor(rng() * 15));
			const dataLength = 1 + Math.floor(rng() * 120);
			const data = Array.from({ length: dataLength }, () => Math.floor(rng() * 256));
			const codeword = rsEncode(data, ecCount);
			const received = Uint8Array.from(codeword);
			const errors = Math.floor(rng() * (ecCount / 2 + 1));
			const positions = new Set<number>();
			while (positions.size < errors) positions.add(Math.floor(rng() * received.length));
			for (const p of positions) received[p] ^= 1 + Math.floor(rng() * 255);

			expect(correctErrors(received, ecCount)).toBe(errors);
			expect(Array.from(received)).toEqual(codeword);
		}
	});

	it('reports blocks it cannot correct instead of returning wrong data', () => {
		const data = Array.from({ length: 20 }, (_, i) => i * 7);
		const received = Uint8Array.from(rsEncode(data, 10));
		for (let i = 0; i < 8; i++) received[i * 3] ^= 0x5a;
		expect(correctErrors(received, 10)).toBe(-1);
	});
});
