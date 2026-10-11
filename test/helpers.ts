/**
 * Test fixtures: QR symbols made by an independent encoder (the `qrcode`
 * package — a dev dependency only), rendered into camera-like images with
 * this file's own geometry, so a decoder bug can't hide behind shared code.
 */
import QRCode from 'qrcode';
import { createRequire } from 'node:module';
import type { RgbaImage } from '../src';

const require = createRequire(import.meta.url);
/** Shift_JIS converter that lets the encoder use kanji mode. */
export const toSJIS = require('qrcode/helper/to-sjis') as (codepoint: string) => number;

export interface Symbol {
	size: number;
	version: number;
	dark(x: number, y: number): boolean;
}

export function makeSymbol(
	content: string | QRCode.QRCodeSegment[],
	options: QRCode.QRCodeOptions = {}
): Symbol {
	const qr = QRCode.create(content as string, options);
	const { size } = qr.modules;
	return { size, version: qr.version, dark: (x, y) => qr.modules.get(y, x) === 1 };
}

/** Deterministic PRNG (mulberry32). */
export function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Flips `count` random modules in the data region (away from function patterns). */
export function damaged(symbol: Symbol, count: number, seed = 1): Symbol {
	const rng = random(seed);
	const flipped = new Set<number>();
	while (flipped.size < count) {
		const x = 9 + Math.floor(rng() * (symbol.size - 18));
		const y = 9 + Math.floor(rng() * (symbol.size - 18));
		if (x === 6 || y === 6) continue;
		flipped.add(y * symbol.size + x);
	}
	return { ...symbol, dark: (x, y) => symbol.dark(x, y) !== flipped.has(y * symbol.size + x) };
}

interface Pt {
	x: number;
	y: number;
}

/** Solves the 8 × 8 system for the homography taking `from[i]` to `to[i]`. */
function homography(from: Pt[], to: Pt[]): (x: number, y: number) => Pt {
	const a: number[][] = [];
	const b: number[] = [];
	for (let i = 0; i < 4; i++) {
		const { x, y } = from[i];
		const { x: u, y: v } = to[i];
		a.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
		b.push(u);
		a.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
		b.push(v);
	}
	// Gaussian elimination with partial pivoting.
	for (let col = 0; col < 8; col++) {
		let pivot = col;
		for (let row = col + 1; row < 8; row++) {
			if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
		}
		[a[col], a[pivot]] = [a[pivot], a[col]];
		[b[col], b[pivot]] = [b[pivot], b[col]];
		for (let row = 0; row < 8; row++) {
			if (row === col) continue;
			const f = a[row][col] / a[col][col];
			for (let k = col; k < 8; k++) a[row][k] -= f * a[col][k];
			b[row] -= f * b[col];
		}
	}
	const h = b.map((value, i) => value / a[i][i]);
	return (x, y) => {
		const w = h[6] * x + h[7] * y + 1;
		return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
	};
}

export interface RenderOptions {
	/** Pixels per module before rotation/tilt. Default 6. */
	moduleSize?: number;
	/** Quiet zone in modules. Default 4. */
	quietZone?: number;
	/** Rotation in degrees. */
	rotate?: number;
	/** Perspective: the right edge shrinks by this share (0–0.5). */
	tilt?: number;
	/** Canvas size; defaults to 1.5 × the symbol, enough for any rotation. */
	width?: number;
	height?: number;
	/** Symbol centre offset from the canvas centre, in pixels. */
	offsetX?: number;
	offsetY?: number;
	dark?: number;
	light?: number;
	/** Box blur radius in pixels (applied twice ≈ Gaussian). */
	blur?: number;
	/** Gaussian noise sigma in grey levels. */
	noise?: number;
	/** Illumination falloff across the image, 0–1. */
	gradient?: number;
	invert?: boolean;
	mirror?: boolean;
	/** Share (0–1) of the background covered in dark, text-like blocks. */
	clutter?: number;
	/** A bright specular spot: centre and radius as shares of the symbol, strength 0–1. */
	glare?: { x: number; y: number; radius: number; strength: number };
	seed?: number;
}

function boxBlur(gray: Float64Array, width: number, height: number, radius: number) {
	const tmp = new Float64Array(gray.length);
	const span = 2 * radius + 1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let acc = 0;
			for (let k = -radius; k <= radius; k++) {
				acc += gray[y * width + Math.min(width - 1, Math.max(0, x + k))];
			}
			tmp[y * width + x] = acc / span;
		}
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let acc = 0;
			for (let k = -radius; k <= radius; k++) {
				acc += tmp[Math.min(height - 1, Math.max(0, y + k)) * width + x];
			}
			gray[y * width + x] = acc / span;
		}
	}
}

export interface RenderedImage extends RgbaImage {
	/** Image positions of the symbol's corners (without quiet zone): TL, TR, BR, BL. */
	symbolCorners: Pt[];
}

/** Renders a symbol the way a camera might see it. */
export function render(symbol: Symbol, options: RenderOptions = {}): RenderedImage {
	const moduleSize = options.moduleSize ?? 6;
	const quiet = options.quietZone ?? 4;
	const total = symbol.size + 2 * quiet;
	const side = total * moduleSize;
	const width = options.width ?? Math.ceil(side * 1.5);
	const height = options.height ?? Math.ceil(side * 1.5);
	const dark = options.dark ?? 25;
	const light = options.light ?? 230;
	const rng = random(options.seed ?? 7);

	// The quiet-zone square's corners: tilt, rotate, then move into place.
	const tilt = options.tilt ?? 0;
	const half = side / 2;
	const raw: Pt[] = [
		{ x: -half, y: -half },
		{ x: half, y: -half * (1 - tilt) },
		{ x: half, y: half * (1 - tilt) },
		{ x: -half, y: half }
	];
	const angle = ((options.rotate ?? 0) * Math.PI) / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const cx = width / 2 + (options.offsetX ?? 0);
	const cy = height / 2 + (options.offsetY ?? 0);
	const corners = raw.map((p) => ({
		x: cx + p.x * cos - p.y * sin,
		y: cy + p.x * sin + p.y * cos
	}));
	const toModules = homography(corners, [
		{ x: 0, y: 0 },
		{ x: total, y: 0 },
		{ x: total, y: total },
		{ x: 0, y: total }
	]);
	const toImage = homography(
		[
			{ x: 0, y: 0 },
			{ x: total, y: 0 },
			{ x: total, y: total },
			{ x: 0, y: total }
		],
		corners
	);
	const near = quiet;
	const far = quiet + symbol.size;
	const mirrored = (x: number) => (options.mirror ? total - x : x);
	const symbolCorners = [
		toImage(mirrored(near), near),
		toImage(mirrored(far), near),
		toImage(mirrored(far), far),
		toImage(mirrored(near), far)
	];

	// Background clutter: a grid of glyph-sized cells, some dark, never
	// inside the symbol's quiet zone.
	const cell = Math.max(2, Math.round(moduleSize * 1.3));
	const clutter = options.clutter ?? 0;
	const clutterRng = random((options.seed ?? 7) + 1000);
	const cellsX = Math.ceil(width / cell);
	const darkCells = new Uint8Array(cellsX * Math.ceil(height / cell));
	for (let i = 0; i < darkCells.length; i++) darkCells[i] = clutterRng() < clutter ? 1 : 0;

	const gray = new Float64Array(width * height);
	const sub = 3;
	for (let py = 0; py < height; py++) {
		for (let px = 0; px < width; px++) {
			let darkSamples = 0;
			for (let j = 0; j < sub; j++) {
				for (let i = 0; i < sub; i++) {
					const sx = px + (i + 0.5) / sub;
					const sy = py + (j + 0.5) / sub;
					const m = toModules(sx, sy);
					const inQuiet = m.x >= 0 && m.y >= 0 && m.x < total && m.y < total;
					if (!inQuiet) {
						if (darkCells[Math.floor(sy / cell) * cellsX + Math.floor(sx / cell)]) darkSamples++;
						continue;
					}
					const mx = Math.floor(m.x) - quiet;
					const my = Math.floor(m.y) - quiet;
					if (mx < 0 || my < 0 || mx >= symbol.size || my >= symbol.size) continue;
					const x = options.mirror ? symbol.size - 1 - mx : mx;
					if (symbol.dark(x, my)) darkSamples++;
				}
			}
			let shade = light - ((light - dark) * darkSamples) / (sub * sub);
			shade *= 1 - (options.gradient ?? 0) * (px / width);
			if (options.glare) {
				const g = options.glare;
				const m = toModules(px + 0.5, py + 0.5);
				const d = Math.hypot(m.x / total - g.x, m.y / total - g.y) / g.radius;
				if (d < 1) shade += (255 - shade) * g.strength * (1 - d * d);
			}
			gray[py * width + px] = shade;
		}
	}
	if (options.blur) {
		boxBlur(gray, width, height, options.blur);
		boxBlur(gray, width, height, options.blur);
	}

	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < gray.length; i++) {
		let value = gray[i];
		if (options.noise) {
			const u = Math.max(rng(), 1e-12);
			value += options.noise * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
		}
		if (options.invert) value = 255 - value;
		const v = Math.max(0, Math.min(255, Math.round(value)));
		data[4 * i] = v;
		data[4 * i + 1] = v;
		data[4 * i + 2] = v;
		data[4 * i + 3] = 255;
	}
	return { data, width, height, symbolCorners };
}

/** Reed–Solomon encoder for tests (independent of the decoder's GF code). */
export function rsEncode(data: number[], ecCount: number): number[] {
	const exp: number[] = [];
	const log: number[] = new Array(256).fill(0);
	let x = 1;
	for (let i = 0; i < 255; i++) {
		exp[i] = x;
		log[x] = i;
		x = x << 1;
		if (x & 256) x ^= 0x11d;
	}
	const mul = (a: number, b: number) => (a && b ? exp[(log[a] + log[b]) % 255] : 0);
	// g(x) = Π (x − α^i), highest degree first.
	let g = [1];
	for (let i = 0; i < ecCount; i++) {
		const next = new Array(g.length + 1).fill(0);
		for (let j = 0; j < g.length; j++) {
			next[j] ^= g[j];
			next[j + 1] ^= mul(g[j], exp[i]);
		}
		g = next;
	}
	const remainder = [...data, ...new Array(ecCount).fill(0)];
	for (let i = 0; i < data.length; i++) {
		const coef = remainder[i];
		if (!coef) continue;
		for (let j = 1; j < g.length; j++) remainder[i + j] ^= mul(g[j], coef);
	}
	return [...data, ...remainder.slice(data.length)];
}
