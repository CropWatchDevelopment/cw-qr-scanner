import type { QRCodeMaskPattern } from 'qrcode';
import { describe, expect, it } from 'vitest';
import { createVideoDecoder, decodeQr, type RgbaImage } from '../src';
import { BitMatrix } from '../src/bit-matrix';
import { decodeGrid } from '../src/decoder';
import { errorCorrectionBlocks, type ErrorCorrectionLevel } from '../src/version';
import {
	damaged,
	makeSymbol,
	random,
	render,
	toSJIS,
	type RenderOptions,
	type Symbol
} from './helpers';

const LEVELS: ErrorCorrectionLevel[] = ['L', 'M', 'Q', 'H'];
const EUI = '24E124126E270425';
const TR005 = 'LW:D0:24E124C0002A0001:24E124126E270425:P-1234ABCD:CAF4E';

function gridOf(symbol: Symbol): BitMatrix {
	const grid = new BitMatrix(symbol.size, symbol.size);
	for (let y = 0; y < symbol.size; y++) {
		for (let x = 0; x < symbol.size; x++) grid.set(x, y, symbol.dark(x, y));
	}
	return grid;
}

function decodeSymbol(symbol: Symbol) {
	const outcome = decodeGrid(gridOf(symbol));
	return outcome.kind === 'decoded' ? outcome.result : null;
}

/** Bytes that fill a version / level completely in one byte segment. */
function byteCapacity(version: number, level: ErrorCorrectionLevel): number {
	const { groups } = errorCorrectionBlocks(version, level);
	const dataCodewords = groups.reduce((sum, [count, data]) => sum + count * data, 0);
	const countBits = version <= 9 ? 8 : 16;
	return Math.floor((dataCodewords * 8 - 4 - countBits) / 8);
}

/** Errors every block can correct, keeping ISO/IEC 18004's misdecode protection. */
function correctable(version: number, level: ErrorCorrectionLevel): number {
	const protection: Record<string, number> = {
		'1L': 3,
		'1M': 2,
		'1Q': 1,
		'1H': 1,
		'2L': 2,
		'3L': 1
	};
	const { ecPerBlock } = errorCorrectionBlocks(version, level);
	return Math.floor((ecPerBlock - (protection[`${version}${level}`] ?? 0)) / 2);
}

describe('module grids', () => {
	it('reads every version and level, filled to capacity', () => {
		const rng = random(5);
		for (let version = 1; version <= 40; version++) {
			for (const level of LEVELS) {
				const payload = Uint8Array.from({ length: byteCapacity(version, level) }, () =>
					Math.floor(rng() * 256)
				);
				const symbol = makeSymbol([{ data: payload, mode: 'byte' }], {
					version,
					errorCorrectionLevel: level
				});
				const result = decodeSymbol(symbol);
				expect(result, `${version}-${level}`).not.toBeNull();
				expect(result!.version).toBe(version);
				expect(result!.errorCorrectionLevel).toBe(level);
				expect(Array.from(result!.bytes)).toEqual(Array.from(payload));
			}
		}
	});

	it('reads all eight data masks', () => {
		for (let mask = 0; mask < 8; mask++) {
			const maskPattern = mask as QRCodeMaskPattern;
			const result = decodeSymbol(makeSymbol(EUI, { maskPattern }));
			expect(result?.mask).toBe(mask);
			expect(result?.text).toBe(EUI);
		}
	});

	it.each([
		['numeric', '01234567890123456789012345678901234567'],
		['alphanumeric', 'HELLO WORLD $%*+-./:0123'],
		['TR005 (mixed segments)', TR005],
		['UTF-8 bytes', 'センサー 24.5°C — Kona'],
		['URL', 'https://app.cropwatch.io/devices?eui=24e124126e270425']
	])('decodes %s', (_, text) => {
		expect(decodeSymbol(makeSymbol(text))?.text).toBe(text);
	});

	it('decodes kanji segments', () => {
		const symbol = makeSymbol([{ data: '温度センサー設置済み', mode: 'kanji' }], {
			toSJISFunc: toSJIS
		});
		expect(decodeSymbol(symbol)?.text).toBe('温度センサー設置済み');
	});

	it('decodes kanji next to other modes', () => {
		const text = '農場A棟 24E124126E270425';
		expect(decodeSymbol(makeSymbol(text, { toSJISFunc: toSJIS }))?.text).toBe(text);
	});

	it('corrects as many damaged modules as every level allows', () => {
		for (let version = 1; version <= 40; version += version < 10 ? 1 : 3) {
			for (const level of LEVELS) {
				// Short enough for version 1-H.
				const symbol = makeSymbol('CW-0425', { version, errorCorrectionLevel: level });
				const flips = correctable(version, level);
				const result = decodeSymbol(damaged(symbol, flips, version * 7 + flips));
				expect(result?.text, `${version}-${level}, ${flips} flips`).toBe('CW-0425');
			}
		}
	});

	it('refuses symbols damaged past their error correction', () => {
		const symbol = makeSymbol(EUI, { version: 2, errorCorrectionLevel: 'L' });
		expect(decodeSymbol(damaged(symbol, 40, 3))).toBeNull();
	});
});

const read = (image: RgbaImage) => decodeQr(image)?.text ?? null;

describe('camera images', () => {
	const label = makeSymbol(EUI, { errorCorrectionLevel: 'M' });

	it.each([0, 5, 10, 22, 30, 45, 60, 90, 135, 180, 200, 270, 315])(
		'reads a code rotated %i°',
		(rotate) => {
			expect(read(render(label, { rotate }))).toBe(EUI);
		}
	);

	it.each([
		[0.1, 0],
		[0.2, 30],
		[0.3, 0],
		[0.3, 120],
		[0.4, 45],
		[0.45, 260]
	])('reads a code in perspective (tilt %f, rotated %i°)', (tilt, rotate) => {
		expect(read(render(label, { tilt, rotate, moduleSize: 8 }))).toBe(EUI);
	});

	it.each([2, 3, 4, 8, 16, 32])('reads %i-pixel modules', (moduleSize) => {
		expect(read(render(label, { moduleSize, rotate: 8 }))).toBe(EUI);
	});

	it.each([2, 3, 5, 7, 10, 15, 25, 40])('reads version %i', (version) => {
		const text = version < 4 ? EUI : TR005;
		const symbol = makeSymbol(text, { version, errorCorrectionLevel: 'Q' });
		const result = decodeQr(render(symbol, { moduleSize: 4, rotate: 17 }));
		expect(result?.text).toBe(text);
		expect(result?.version).toBe(version);
	});

	it.each([1, 2, 3])('reads a soft-focus code (blur radius %i)', (blur) => {
		expect(read(render(label, { blur, moduleSize: 8, rotate: 12 }))).toBe(EUI);
	});

	it.each([10, 25, 40])('reads through sensor noise (σ = %i)', (noise) => {
		expect(read(render(label, { noise, rotate: 33 }))).toBe(EUI);
	});

	it('reads a faded, low-contrast print', () => {
		expect(read(render(label, { dark: 120, light: 165, noise: 4 }))).toBe(EUI);
	});

	it('reads under uneven light', () => {
		expect(read(render(label, { gradient: 0.75, rotate: 20 }))).toBe(EUI);
	});

	it('reads light-on-dark codes', () => {
		expect(read(render(label, { invert: true, rotate: 40 }))).toBe(EUI);
	});

	it('reads mirror-image codes', () => {
		const result = decodeQr(render(label, { mirror: true, rotate: 70 }));
		expect(result?.text).toBe(EUI);
		expect(result?.mirrored).toBe(true);
	});

	it('reads a code with a thin quiet zone', () => {
		expect(read(render(label, { quietZone: 1, rotate: 3 }))).toBe(EUI);
	});

	it('reports the corners where the code sits', () => {
		const result = decodeQr(render(label, { moduleSize: 10, quietZone: 4 }))!;
		// The quiet-zone square is centred on a canvas 1.5 × its size.
		const side = (label.size + 8) * 10;
		const topLeft = Math.ceil(side * 1.5) / 2 - side / 2 + 40;
		const bottomRight = topLeft + label.size * 10;
		expect(Math.abs(result.corners.topLeft.x - topLeft)).toBeLessThan(1);
		expect(Math.abs(result.corners.topLeft.y - topLeft)).toBeLessThan(1);
		expect(Math.abs(result.corners.bottomRight.x - bottomRight)).toBeLessThan(1);
		expect(Math.abs(result.corners.bottomRight.y - bottomRight)).toBeLessThan(1);
	});

	it('reads a small code anywhere in a 1080p frame', () => {
		const frame = render(label, {
			moduleSize: 5,
			width: 1920,
			height: 1080,
			offsetX: 620,
			offsetY: -300,
			rotate: 25,
			noise: 8,
			gradient: 0.3
		});
		expect(read(frame)).toBe(EUI);
	});
});

describe('false positives', () => {
	const gray = (
		width: number,
		height: number,
		shade: (x: number, y: number) => number
	): RgbaImage => {
		const data = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const v = shade(x, y);
				data.set([v, v, v, 255], 4 * (y * width + x));
			}
		}
		return { data, width, height };
	};

	it('finds nothing in a blank frame', () => {
		expect(decodeQr(gray(640, 480, () => 200))).toBeNull();
	});

	it('finds nothing in noise', () => {
		const rng = random(11);
		expect(decodeQr(gray(640, 480, () => Math.floor(rng() * 256)))).toBeNull();
	});

	it('finds nothing in blocky, text-like patterns', () => {
		const rng = random(12);
		const cells = Array.from({ length: 60 * 80 }, () => rng() < 0.4);
		expect(
			decodeQr(gray(640, 480, (x, y) => (cells[(y >> 3) * 80 + (x >> 3)] ? 30 : 220)))
		).toBeNull();
	});
});

describe('robustness', () => {
	const TEXTS = [EUI, TR005, 'https://app.cropwatch.io/d/24e124126e270425'];

	/** Camera-like conditions drawn at random: angle, perspective, focus, noise, light, clutter. */
	function scene(seed: number) {
		const rng = random(seed);
		const range = (a: number, b: number) => a + rng() * (b - a);
		const text = TEXTS[Math.floor(rng() * TEXTS.length)];
		const level = LEVELS[Math.floor(rng() * LEVELS.length)];
		const options: RenderOptions = {
			moduleSize: range(3.5, 9),
			rotate: range(0, 360),
			tilt: rng() < 0.6 ? range(0, 0.35) : 0,
			blur: rng() < 0.4 ? 1 : 0,
			noise: range(0, 18),
			dark: range(10, 90),
			light: range(160, 245),
			gradient: rng() < 0.4 ? range(0, 0.6) : 0,
			clutter: rng() < 0.6 ? range(0.1, 0.4) : 0,
			glare:
				rng() < 0.3
					? {
							x: range(0.2, 0.8),
							y: range(0.2, 0.8),
							radius: range(0.15, 0.35),
							strength: range(0.3, 0.6)
						}
					: undefined,
			seed
		};
		return { text, image: render(makeSymbol(text, { errorCorrectionLevel: level }), options) };
	}

	it('reads at least 95 % of 120 hard, camera-like scenes', () => {
		let read = 0;
		for (let seed = 1; seed <= 120; seed++) {
			const { text, image } = scene(seed);
			if (decodeQr(image)?.text === text) read++;
		}
		expect(read).toBeGreaterThanOrEqual(114);
	});

	it('reads the same scenes as a video feed within a few frames', () => {
		let read = 0;
		for (let seed = 1; seed <= 60; seed++) {
			const { text, image } = scene(seed);
			const video = createVideoDecoder();
			for (let frame = 0; frame < 12; frame++) {
				if (video.decode(image)?.text === text) {
					read++;
					break;
				}
			}
		}
		expect(read).toBeGreaterThanOrEqual(57);
	});
});

describe('speed', () => {
	it('decodes a 1080p camera frame quickly', () => {
		const frame = render(makeSymbol(EUI, { errorCorrectionLevel: 'M' }), {
			moduleSize: 7,
			width: 1920,
			height: 1080,
			rotate: 10,
			noise: 6
		});
		decodeQr(frame); // warm up the JIT
		const start = performance.now();
		const result = decodeQr(frame);
		const elapsed = performance.now() - start;
		expect(result?.text).toBe(EUI);
		expect(elapsed).toBeLessThan(250);
	});

	it('gives up on an empty 1080p frame quickly in video mode', () => {
		const rng = random(3);
		const data = new Uint8ClampedArray(1920 * 1080 * 4);
		for (let i = 0; i < 1920 * 1080; i++) {
			const v = 128 + Math.floor((rng() - 0.5) * 60);
			data.set([v, v, v, 255], 4 * i);
		}
		const video = createVideoDecoder();
		video.decode({ data, width: 1920, height: 1080 }); // warm up
		const start = performance.now();
		for (let i = 0; i < 6; i++)
			expect(video.decode({ data, width: 1920, height: 1080 })).toBeNull();
		expect((performance.now() - start) / 6).toBeLessThan(250);
	});
});
