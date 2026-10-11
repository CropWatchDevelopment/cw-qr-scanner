/**
 * @cropwatchdevelopment/qr-scanner — CropWatch's QR code reader.
 *
 * Finds and decodes QR codes (Model 2, versions 1–40, all error-correction
 * levels and masks; numeric, alphanumeric, byte, kanji and ECI segments) in
 * camera frames and photos. Written from ISO/IEC 18004; no dependencies.
 *
 *   const code = decodeQr(context.getImageData(0, 0, width, height));
 *   if (code) console.log(code.text);
 *
 * For a camera feed, {@link createVideoDecoder} keeps each frame fast and
 * spreads the slower fallbacks across successive frames.
 */
import { toGray, type GrayImage, type RgbaImage } from './image.js';
import { createFrameScanner, scanGray, type QrCode, type ScanOptions } from './scanner.js';

export type { GrayImage, RgbaImage } from './image.js';
export type { Point } from './geometry.js';
export type { QrCode, ScanOptions } from './scanner.js';
export type { ErrorCorrectionLevel } from './version.js';

/** Decodes the first QR code in an RGBA image (e.g. canvas ImageData), or null. */
export function decodeQr(image: RgbaImage, options?: ScanOptions): QrCode | null {
	return scanGray(toGray(image), options);
}

/** Same as {@link decodeQr} for an 8-bit luminance image. */
export function decodeQrGray(image: GrayImage, options?: ScanOptions): QrCode | null {
	return scanGray(image, options);
}

export interface VideoDecoder {
	/** Decodes one camera frame (RGBA, e.g. canvas ImageData), or null. */
	decode(frame: RgbaImage): QrCode | null;
}

/**
 * A decoder for successive frames of a live camera feed. Each call runs the
 * fast main strategy plus one fallback in rotation (light-on-dark, global
 * threshold, other block sizes, unsmoothed, half size), so a handful of
 * frames covers everything {@link decodeQr} tries on a still image.
 */
export function createVideoDecoder(): VideoDecoder {
	const scan = createFrameScanner();
	return { decode: (frame) => scan(toGray(frame)) };
}
