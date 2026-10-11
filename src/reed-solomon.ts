/**
 * Reed–Solomon decoding over GF(256) as QR codes use it: primitive
 * polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D), generator α = 2, and a code
 * generator polynomial whose roots are α^0 … α^(n−1).
 *
 * Decoding: syndromes → Berlekamp–Massey (error locator Λ) → Chien search
 * (error positions) → Forney (error values).
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
	let value = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = value;
		LOG[value] = i;
		value <<= 1;
		if (value & 0x100) value ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const multiply = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const divide = (a: number, b: number): number => (a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]]);
/** α^k for any integer k. */
const alphaPower = (k: number): number => EXP[((k % 255) + 255) % 255];

/** Evaluates a polynomial stored highest degree first (a codeword block) at x. */
function evaluateHighFirst(poly: Uint8Array, x: number): number {
	let acc = 0;
	for (let i = 0; i < poly.length; i++) acc = multiply(acc, x) ^ poly[i];
	return acc;
}

/** Evaluates a polynomial stored lowest degree first at x. */
function evaluateLowFirst(poly: ArrayLike<number>, x: number): number {
	let acc = 0;
	for (let i = poly.length - 1; i >= 0; i--) acc = multiply(acc, x) ^ poly[i];
	return acc;
}

function syndromes(block: Uint8Array, ecCount: number): Uint8Array | null {
	const s = new Uint8Array(ecCount);
	let errors = false;
	for (let j = 0; j < ecCount; j++) {
		s[j] = evaluateHighFirst(block, alphaPower(j));
		if (s[j] !== 0) errors = true;
	}
	return errors ? s : null;
}

/**
 * Corrects a block (data codewords then EC codewords) in place.
 * Returns how many codewords were corrected, or −1 when the block holds more
 * than `maxErrors` errors (at most half the EC codewords can be repaired).
 */
export function correctErrors(
	block: Uint8Array,
	ecCount: number,
	maxErrors = ecCount >> 1
): number {
	const s = syndromes(block, ecCount);
	if (!s) return 0;

	// Berlekamp–Massey: the shortest LFSR (error locator Λ, lowest degree
	// first, Λ0 = 1) that generates the syndrome sequence.
	let locator: number[] = [1];
	let previous: number[] = [1];
	let length = 0;
	let shift = 1;
	let previousDiscrepancy = 1;
	for (let k = 0; k < ecCount; k++) {
		let discrepancy = s[k];
		for (let i = 1; i <= length; i++) discrepancy ^= multiply(locator[i] ?? 0, s[k - i]);
		if (discrepancy === 0) {
			shift++;
			continue;
		}
		const factor = divide(discrepancy, previousDiscrepancy);
		const before = locator.slice();
		while (locator.length < previous.length + shift) locator.push(0);
		for (let i = 0; i < previous.length; i++) locator[i + shift] ^= multiply(factor, previous[i]);
		if (2 * length <= k) {
			length = k + 1 - length;
			previous = before;
			previousDiscrepancy = discrepancy;
			shift = 1;
		} else {
			shift++;
		}
	}
	if (2 * length > ecCount || length > maxErrors) return -1;
	const lambda = locator.slice(0, length + 1);

	// Chien search: a codeword at index i is coefficient of x^(n−1−i); it is in
	// error when Λ vanishes at the inverse of its locator α^(n−1−i).
	const n = block.length;
	const positions: number[] = [];
	for (let i = 0; i < n; i++) {
		if (evaluateLowFirst(lambda, alphaPower(-(n - 1 - i))) === 0) positions.push(i);
	}
	if (positions.length !== length) return -1;

	// Error evaluator Ω = S·Λ mod x^ecCount.
	const omega = new Uint8Array(ecCount);
	for (let i = 0; i < ecCount; i++) {
		let acc = 0;
		for (let k = 0; k <= Math.min(i, length); k++) acc ^= multiply(lambda[k], s[i - k]);
		omega[i] = acc;
	}

	// Forney, for a first consecutive root of α^0: e = X · Ω(X⁻¹) / Λ'(X⁻¹).
	// In characteristic 2 the formal derivative keeps only the odd terms.
	for (const i of positions) {
		const power = n - 1 - i;
		const inverse = alphaPower(-power);
		let derivative = 0;
		for (let k = 1; k <= length; k += 2) {
			derivative ^= multiply(lambda[k], alphaPower(-power * (k - 1)));
		}
		if (derivative === 0) return -1;
		const value = multiply(alphaPower(power), divide(evaluateLowFirst(omega, inverse), derivative));
		block[i] ^= value;
	}

	// A miscorrection would leave non-zero syndromes behind.
	return syndromes(block, ecCount) ? -1 : positions.length;
}
