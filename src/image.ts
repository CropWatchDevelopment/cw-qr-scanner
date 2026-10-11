/** Pixels as the browser hands them over: 4 bytes (R, G, B, A) per pixel. */
export interface RgbaImage {
	data: ArrayLike<number>;
	width: number;
	height: number;
}

/** One 8-bit luminance value per pixel. */
export interface GrayImage {
	data: Uint8Array;
	width: number;
	height: number;
}

/**
 * RGBA → luminance (Rec. 601 weights in fixed point). Transparent pixels are
 * composited onto white, the way a page shows a PNG with alpha.
 */
export function toGray(image: RgbaImage): GrayImage {
	const { data, width, height } = image;
	const count = width * height;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new RangeError('Image width and height must be positive integers.');
	}
	if (data.length < count * 4) {
		throw new RangeError('Expected 4 bytes (RGBA) per pixel.');
	}
	const gray = new Uint8Array(count);
	for (let i = 0, p = 0; i < count; i++, p += 4) {
		const luma = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
		const alpha = data[p + 3];
		gray[i] = alpha === 255 ? luma : ((luma * alpha + 255 * (255 - alpha)) / 255) | 0;
	}
	return { data: gray, width, height };
}

/** Half-size copy (2 × 2 box average): smooths sensor noise and soft focus. */
export function halve(image: GrayImage): GrayImage {
	const width = image.width >> 1;
	const height = image.height >> 1;
	const out = new Uint8Array(width * height);
	const src = image.data;
	const stride = image.width;
	for (let y = 0; y < height; y++) {
		const row = 2 * y * stride;
		for (let x = 0; x < width; x++) {
			const i = row + 2 * x;
			out[y * width + x] = (src[i] + src[i + 1] + src[i + stride] + src[i + stride + 1] + 2) >> 2;
		}
	}
	return { data: out, width, height };
}

/**
 * Sensor noise (standard deviation in grey levels). The image is cut into
 * 4 × 4 pixel blocks; edges and texture only ever raise a block's spread, so
 * the quieter blocks (the 20th percentile) measure the noise alone.
 */
export function estimateNoise(image: GrayImage): number {
	const { data, width, height } = image;
	const histogram = new Uint32Array(256);
	let blocks = 0;
	for (let y = 0; y + 4 <= height; y += 8) {
		for (let x = 0; x + 4 <= width; x += 8) {
			let sum = 0;
			let squares = 0;
			for (let j = 0; j < 4; j++) {
				const row = (y + j) * width + x;
				for (let i = 0; i < 4; i++) {
					const v = data[row + i];
					sum += v;
					squares += v * v;
				}
			}
			const variance = Math.max(0, (squares - (sum * sum) / 16) / 15);
			histogram[Math.min(255, Math.round(Math.sqrt(variance)))]++;
			blocks++;
		}
	}
	let seen = 0;
	for (let sd = 0; sd < 256; sd++) {
		seen += histogram[sd];
		// A 16-pixel sample's spread runs low; its 20th percentile is ≈ 0.85 σ.
		if (seen * 5 >= blocks) return sd / 0.85;
	}
	return 0;
}

/** 3 × 3 box blur: cuts sensor noise to a third before thresholding. */
export function smooth(image: GrayImage): GrayImage {
	const { data, width, height } = image;
	const across = new Uint16Array(width * height);
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			const left = data[row + (x > 0 ? x - 1 : 0)];
			const right = data[row + (x + 1 < width ? x + 1 : x)];
			across[row + x] = left + data[row + x] + right;
		}
	}
	const out = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		const above = (y > 0 ? y - 1 : 0) * width;
		const row = y * width;
		const below = (y + 1 < height ? y + 1 : y) * width;
		for (let x = 0; x < width; x++) {
			out[row + x] =
				((across[above + x] + across[row + x] + across[below + x]) * 7282 + 32768) >> 16;
		}
	}
	return { data: out, width, height };
}

/** Bilinearly interpolated grey level at (x, y), pixel centres at +0.5. */
export function sampleBilinear(image: GrayImage, x: number, y: number): number {
	const { data, width, height } = image;
	const fx = Math.min(width - 1, Math.max(0, x - 0.5));
	const fy = Math.min(height - 1, Math.max(0, y - 0.5));
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const x1 = Math.min(width - 1, x0 + 1);
	const y1 = Math.min(height - 1, y0 + 1);
	const tx = fx - x0;
	const ty = fy - y0;
	const top = data[y0 * width + x0] * (1 - tx) + data[y0 * width + x1] * tx;
	const bottom = data[y1 * width + x0] * (1 - tx) + data[y1 * width + x1] * tx;
	return top * (1 - ty) + bottom * ty;
}
