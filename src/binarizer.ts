import { BitMatrix } from './bit-matrix.js';
import type { GrayImage } from './image.js';

/** Smallest dark-to-light spread (grey levels) for a block to carry an edge. */
export const MIN_BLOCK_CONTRAST = 20;

/**
 * Otsu's threshold: the grey level that best separates the histogram into
 * two classes (largest between-class variance). Pixels at or below it are dark.
 */
export function otsuThreshold(image: GrayImage): number {
	const histogram = new Uint32Array(256);
	for (let i = 0; i < image.data.length; i++) histogram[image.data[i]]++;
	const total = image.data.length;
	let weightedTotal = 0;
	for (let level = 0; level < 256; level++) weightedTotal += level * histogram[level];

	let backgroundWeight = 0;
	let backgroundSum = 0;
	let best = 127;
	let bestVariance = -1;
	for (let level = 0; level < 256; level++) {
		backgroundWeight += histogram[level];
		if (backgroundWeight === 0) continue;
		const foregroundWeight = total - backgroundWeight;
		if (foregroundWeight === 0) break;
		backgroundSum += level * histogram[level];
		const backgroundMean = backgroundSum / backgroundWeight;
		const foregroundMean = (weightedTotal - backgroundSum) / foregroundWeight;
		const spread = backgroundMean - foregroundMean;
		const variance = backgroundWeight * foregroundWeight * spread * spread;
		if (variance > bestVariance) {
			bestVariance = variance;
			best = level;
		}
	}
	return best;
}

/** One threshold for the whole image: right for evenly lit, sharp codes. */
export function binarizeGlobal(image: GrayImage): BitMatrix {
	const threshold = otsuThreshold(image);
	const bits = new BitMatrix(image.width, image.height);
	for (let i = 0; i < image.data.length; i++) bits.data[i] = image.data[i] <= threshold ? 1 : 0;
	return bits;
}

/**
 * Local thresholds that survive uneven light (a shadow across a label, glare
 * on plastic) and large flat areas such as the solid centre of a finder
 * pattern, where purely local methods turn dark pixels light.
 *
 * The image is cut into blocks. A block whose pixels span real contrast
 * (`minContrast`, raised for noisy images so noise alone can't vote) votes
 * the midpoint of its darkest and lightest pixel. Every block — flat or not —
 * is then classified against the average vote of the blocks around it,
 * widening the neighbourhood until some block has voted, and falling back to
 * the image's Otsu threshold for featureless regions.
 */
export function binarizeAdaptive(
	image: GrayImage,
	blockSize = 8,
	minContrast = MIN_BLOCK_CONTRAST
): BitMatrix {
	const radius = 2;
	const { width, height, data } = image;
	const blocksX = Math.ceil(width / blockSize);
	const blocksY = Math.ceil(height / blockSize);

	// Prefix sums over the blocks' votes (and vote counts) for O(1) window sums.
	const stride = blocksX + 1;
	const voteSum = new Float64Array(stride * (blocksY + 1));
	const voteCount = new Int32Array(stride * (blocksY + 1));
	for (let by = 0; by < blocksY; by++) {
		const y0 = by * blockSize;
		const y1 = Math.min(height, y0 + blockSize);
		for (let bx = 0; bx < blocksX; bx++) {
			const x0 = bx * blockSize;
			const x1 = Math.min(width, x0 + blockSize);
			let min = 255;
			let max = 0;
			for (let y = y0; y < y1; y++) {
				let i = y * width + x0;
				for (let x = x0; x < x1; x++, i++) {
					const value = data[i];
					if (value < min) min = value;
					if (value > max) max = value;
				}
			}
			const voted = max - min >= minContrast;
			const at = (by + 1) * stride + (bx + 1);
			voteSum[at] =
				(voted ? (min + max) / 2 : 0) +
				voteSum[at - 1] +
				voteSum[at - stride] -
				voteSum[at - stride - 1];
			voteCount[at] =
				(voted ? 1 : 0) + voteCount[at - 1] + voteCount[at - stride] - voteCount[at - stride - 1];
		}
	}

	// Only needed when a whole image has no contrast anywhere near a block.
	let fallback = -1;
	const thresholds = new Float64Array(blocksX * blocksY);
	const largest = Math.max(blocksX, blocksY);
	for (let by = 0; by < blocksY; by++) {
		for (let bx = 0; bx < blocksX; bx++) {
			let threshold = -1;
			for (let r = radius; r <= Math.max(radius, largest); r *= 2) {
				const left = Math.max(0, bx - r);
				const top = Math.max(0, by - r);
				const right = Math.min(blocksX - 1, bx + r) + 1;
				const bottom = Math.min(blocksY - 1, by + r) + 1;
				const count =
					voteCount[bottom * stride + right] -
					voteCount[top * stride + right] -
					voteCount[bottom * stride + left] +
					voteCount[top * stride + left];
				if (count > 0) {
					const sum =
						voteSum[bottom * stride + right] -
						voteSum[top * stride + right] -
						voteSum[bottom * stride + left] +
						voteSum[top * stride + left];
					threshold = sum / count;
					break;
				}
				if (r >= largest) break;
			}
			if (threshold < 0) {
				if (fallback < 0) fallback = otsuThreshold(image);
				threshold = fallback;
			}
			thresholds[by * blocksX + bx] = threshold;
		}
	}

	// Pixels are integers, so `value < threshold` ⇔ `value < ⌈threshold⌉`:
	// expand each block row's thresholds to one per pixel column, then compare
	// whole image rows in one tight loop.
	const bits = new BitMatrix(width, height);
	const out = bits.data;
	const columnThreshold = new Int32Array(width);
	for (let by = 0; by < blocksY; by++) {
		for (let bx = 0; bx < blocksX; bx++) {
			const threshold = Math.ceil(thresholds[by * blocksX + bx]);
			columnThreshold.fill(threshold, bx * blockSize, Math.min(width, (bx + 1) * blockSize));
		}
		const y1 = Math.min(height, (by + 1) * blockSize);
		for (let y = by * blockSize; y < y1; y++) {
			const row = y * width;
			for (let x = 0; x < width; x++) out[row + x] = (data[row + x] - columnThreshold[x]) >>> 31;
		}
	}
	return bits;
}
