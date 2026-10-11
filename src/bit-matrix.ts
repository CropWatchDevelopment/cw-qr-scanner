/**
 * A width × height grid of dark (1) and light (0) cells: a binarized image,
 * or the module grid sampled from a symbol.
 */
export class BitMatrix {
	readonly data: Uint8Array;

	constructor(
		readonly width: number,
		readonly height: number,
		data?: Uint8Array
	) {
		this.data = data ?? new Uint8Array(width * height);
	}

	/** True when the cell is dark. Reads outside the grid are light. */
	get(x: number, y: number): boolean {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
		return this.data[y * this.width + x] === 1;
	}

	set(x: number, y: number, dark: boolean): void {
		this.data[y * this.width + x] = dark ? 1 : 0;
	}

	/** Light-on-dark codes are read by flipping every cell. */
	inverted(): BitMatrix {
		const data = new Uint8Array(this.data.length);
		for (let i = 0; i < data.length; i++) data[i] = this.data[i] ^ 1;
		return new BitMatrix(this.width, this.height, data);
	}

	/** Mirror across the main diagonal: how a mirrored symbol is read. */
	transposed(): BitMatrix {
		const out = new BitMatrix(this.height, this.width);
		for (let y = 0; y < this.height; y++) {
			for (let x = 0; x < this.width; x++) {
				out.data[x * this.height + y] = this.data[y * this.width + x];
			}
		}
		return out;
	}
}
