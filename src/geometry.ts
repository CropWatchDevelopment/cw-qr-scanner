export interface Point {
	x: number;
	y: number;
}

export type Matrix = [number, number, number, number, number, number, number, number, number];

/**
 * A planar projective transform (homography), row-vector convention:
 * [x', y', w'] = [u, v, 1] · M, then (x, y) = (x' / w', y' / w').
 * It maps the symbol's module grid onto the image, so tilted or skewed
 * codes are sampled in the right places.
 */
export class PerspectiveTransform {
	constructor(private readonly m: Matrix) {}

	map(u: number, v: number): Point {
		const [a11, a12, a13, a21, a22, a23, a31, a32, a33] = this.m;
		const w = a13 * u + a23 * v + a33;
		return { x: (a11 * u + a21 * v + a31) / w, y: (a12 * u + a22 * v + a32) / w };
	}

	/** The unit square's corners (0,0), (1,0), (1,1), (0,1) → p0, p1, p2, p3. */
	static squareToQuad(p0: Point, p1: Point, p2: Point, p3: Point): PerspectiveTransform {
		const dx3 = p0.x - p1.x + p2.x - p3.x;
		const dy3 = p0.y - p1.y + p2.y - p3.y;
		if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
			// A parallelogram: the affine case.
			return new PerspectiveTransform([
				p1.x - p0.x,
				p1.y - p0.y,
				0,
				p2.x - p1.x,
				p2.y - p1.y,
				0,
				p0.x,
				p0.y,
				1
			]);
		}
		const dx1 = p1.x - p2.x;
		const dx2 = p3.x - p2.x;
		const dy1 = p1.y - p2.y;
		const dy2 = p3.y - p2.y;
		const denominator = dx1 * dy2 - dx2 * dy1;
		const a13 = (dx3 * dy2 - dx2 * dy3) / denominator;
		const a23 = (dx1 * dy3 - dx3 * dy1) / denominator;
		return new PerspectiveTransform([
			p1.x - p0.x + a13 * p1.x,
			p1.y - p0.y + a13 * p1.y,
			a13,
			p3.x - p0.x + a23 * p3.x,
			p3.y - p0.y + a23 * p3.y,
			a23,
			p0.x,
			p0.y,
			1
		]);
	}

	/** The inverse up to scale (the adjugate), which is all a homography needs. */
	inverse(): PerspectiveTransform {
		const [a, b, c, d, e, f, g, h, i] = this.m;
		return new PerspectiveTransform([
			e * i - f * h,
			c * h - b * i,
			b * f - c * e,
			f * g - d * i,
			a * i - c * g,
			c * d - a * f,
			d * h - e * g,
			b * g - a * h,
			a * e - b * d
		]);
	}

	/** This transform followed by `next`. */
	then(next: PerspectiveTransform): PerspectiveTransform {
		const a = this.m;
		const b = next.m;
		const out = new Array<number>(9) as Matrix;
		for (let row = 0; row < 3; row++) {
			for (let col = 0; col < 3; col++) {
				out[row * 3 + col] =
					a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
			}
		}
		return new PerspectiveTransform(out);
	}

	/** Maps quadrilateral `from` (4 corners in order) onto quadrilateral `to`. */
	static quadToQuad(from: [Point, Point, Point, Point], to: [Point, Point, Point, Point]) {
		const toSquare = PerspectiveTransform.squareToQuad(...from).inverse();
		return toSquare.then(PerspectiveTransform.squareToQuad(...to));
	}
}
