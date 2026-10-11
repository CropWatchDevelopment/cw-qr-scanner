/**
 * Decodes the data codewords of a symbol into text (ISO/IEC 18004 §7.4):
 * numeric, alphanumeric, byte and kanji segments, ECI character-set
 * designators, structured append and FNC1 headers.
 */

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

class BitReader {
	private offset = 0;

	constructor(private readonly bytes: Uint8Array) {}

	get remaining(): number {
		return this.bytes.length * 8 - this.offset;
	}

	read(count: number): number {
		if (count > this.remaining) throw new RangeError('Ran out of data bits.');
		let value = 0;
		for (let i = 0; i < count; i++) {
			const byte = this.bytes[this.offset >> 3];
			value = (value << 1) | ((byte >> (7 - (this.offset & 7))) & 1);
			this.offset++;
		}
		return value;
	}
}

/** Character count indicator length by mode, for versions 1–9, 10–26, 27–40. */
const COUNT_BITS = {
	numeric: [10, 12, 14],
	alphanumeric: [9, 11, 13],
	byte: [8, 16, 16],
	kanji: [8, 10, 12]
} as const;

/** Character sets by ECI assignment number (the common ones). */
const ECI_CHARSETS: Record<number, string> = {
	1: 'iso-8859-1',
	3: 'iso-8859-1',
	4: 'iso-8859-2',
	5: 'iso-8859-3',
	6: 'iso-8859-4',
	7: 'iso-8859-5',
	8: 'iso-8859-6',
	9: 'iso-8859-7',
	10: 'iso-8859-8',
	11: 'iso-8859-9',
	13: 'iso-8859-11',
	15: 'iso-8859-13',
	16: 'iso-8859-14',
	17: 'iso-8859-15',
	18: 'iso-8859-16',
	20: 'shift_jis',
	21: 'windows-1250',
	22: 'windows-1251',
	23: 'windows-1252',
	24: 'windows-1256',
	25: 'utf-16be',
	26: 'utf-8',
	28: 'big5',
	29: 'gb18030',
	30: 'euc-kr'
};

function decodeWith(charset: string, bytes: Uint8Array, fatal: boolean): string | null {
	try {
		return new TextDecoder(charset, { fatal }).decode(bytes);
	} catch {
		return null;
	}
}

const latin1 = (bytes: Uint8Array): string => {
	let text = '';
	for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
	return text;
};

/**
 * Byte segments: an ECI names the character set; without one, UTF-8 is by
 * far the most common in practice, then Shift_JIS (Japanese labels), then
 * the standard's default ISO-8859-1.
 */
function decodeBytes(bytes: Uint8Array, eci: number | null): string {
	if (eci !== null && ECI_CHARSETS[eci]) {
		const text = decodeWith(ECI_CHARSETS[eci], bytes, false);
		if (text !== null) return text;
	}
	return decodeWith('utf-8', bytes, true) ?? decodeWith('shift_jis', bytes, true) ?? latin1(bytes);
}

export interface DecodedData {
	text: string;
	/** The payload bytes (byte segments as stored; other modes as their text). */
	bytes: Uint8Array;
}

/** Returns null when the bit stream is not a valid encoding. */
export function decodeData(codewords: Uint8Array, version: number): DecodedData | null {
	const reader = new BitReader(codewords);
	const sizeIndex = version <= 9 ? 0 : version <= 26 ? 1 : 2;
	let text = '';
	const bytes: number[] = [];
	let eci: number | null = null;
	const pushAscii = (s: string) => {
		for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
	};

	try {
		while (reader.remaining >= 4) {
			const mode = reader.read(4);
			if (mode === 0b0000) break; // terminator
			switch (mode) {
				case 0b0001: {
					let count = reader.read(COUNT_BITS.numeric[sizeIndex]);
					let digits = '';
					while (count >= 3) {
						const value = reader.read(10);
						if (value > 999) return null;
						digits += value.toString().padStart(3, '0');
						count -= 3;
					}
					if (count === 2) {
						const value = reader.read(7);
						if (value > 99) return null;
						digits += value.toString().padStart(2, '0');
					} else if (count === 1) {
						const value = reader.read(4);
						if (value > 9) return null;
						digits += value.toString();
					}
					text += digits;
					pushAscii(digits);
					break;
				}
				case 0b0010: {
					let count = reader.read(COUNT_BITS.alphanumeric[sizeIndex]);
					let chars = '';
					while (count >= 2) {
						const value = reader.read(11);
						const first = Math.floor(value / 45);
						if (first >= 45) return null;
						chars += ALPHANUMERIC[first] + ALPHANUMERIC[value % 45];
						count -= 2;
					}
					if (count === 1) {
						const value = reader.read(6);
						if (value >= 45) return null;
						chars += ALPHANUMERIC[value];
					}
					text += chars;
					pushAscii(chars);
					break;
				}
				case 0b0100: {
					const count = reader.read(COUNT_BITS.byte[sizeIndex]);
					const segment = new Uint8Array(count);
					for (let i = 0; i < count; i++) segment[i] = reader.read(8);
					text += decodeBytes(segment, eci);
					for (const b of segment) bytes.push(b);
					break;
				}
				case 0b1000: {
					const count = reader.read(COUNT_BITS.kanji[sizeIndex]);
					const sjis = new Uint8Array(count * 2);
					for (let i = 0; i < count; i++) {
						const value = reader.read(13);
						let code = (Math.floor(value / 0xc0) << 8) | (value % 0xc0);
						code += code < 0x1f00 ? 0x8140 : 0xc140;
						sjis[2 * i] = code >> 8;
						sjis[2 * i + 1] = code & 0xff;
					}
					text += decodeWith('shift_jis', sjis, false) ?? '';
					for (const b of sjis) bytes.push(b);
					break;
				}
				case 0b0111: {
					const first = reader.read(8);
					if ((first & 0x80) === 0) eci = first;
					else if ((first & 0xc0) === 0x80) eci = ((first & 0x3f) << 8) | reader.read(8);
					else if ((first & 0xe0) === 0xc0) eci = ((first & 0x1f) << 16) | reader.read(16);
					else return null;
					break;
				}
				case 0b0011:
					reader.read(16); // structured append: position, total, parity
					break;
				case 0b0101:
					break; // FNC1 in first position (GS1)
				case 0b1001:
					reader.read(8); // FNC1 in second position: application indicator
					break;
				default:
					return null; // reserved, or a mode this reader does not support
			}
		}
	} catch {
		return null;
	}
	return { text, bytes: Uint8Array.from(bytes) };
}
