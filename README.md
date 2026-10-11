# @cropwatchdevelopment/qr-scanner

CropWatch's QR code reader. It finds and decodes QR codes in camera frames and photos, and is
written from the QR specification (ISO/IEC 18004) with no third-party decoder and no runtime
dependencies.

- Model 2 QR codes, versions 1–40, error correction levels L/M/Q/H, all eight masks
- Numeric, alphanumeric, byte (UTF-8, Shift_JIS, ECI character sets) and kanji segments;
  structured append and FNC1 headers
- Any rotation, strong perspective, mirror-image and light-on-dark codes
- Survives blur, sensor noise, glare, uneven light, low contrast and busy surroundings
- Never returns a wrong decode it could have caught: every block passes Reed–Solomon checks,
  keeping the standard's misdecode protection for the smallest symbols

## Usage

```ts
import { decodeQr } from '@cropwatchdevelopment/qr-scanner';

const image = context.getImageData(0, 0, canvas.width, canvas.height);
const code = decodeQr(image);
if (code) console.log(code.text); // also: bytes, version, errorCorrectionLevel, corners, …
```

`decodeQr` tries every strategy, which suits still photos. For a live camera feed, use a video
decoder: every frame gets the fast main pass and the slower fallbacks take turns across frames,
so each frame stays at a few milliseconds without giving up robustness.

```ts
import { createVideoDecoder } from '@cropwatchdevelopment/qr-scanner';

const decoder = createVideoDecoder();
function onFrame(frame: ImageData) {
	const code = decoder.decode(frame);
	if (code) handle(code.text);
}
```

Decoding is synchronous. In a browser, run it in a Web Worker so the camera preview never
stutters, and transfer each frame's pixel buffer to it.

### Options

| Option        | Default | Meaning                                                           |
| ------------- | ------- | ----------------------------------------------------------------- |
| `tryHarder`   | `true`  | Run every fallback (other thresholds and block sizes, half size). |
| `tryInverted` | `true`  | Also look for light-on-dark codes.                                |

### Result

| Field                  | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `text`                 | The decoded text.                                                |
| `bytes`                | The payload bytes (byte segments as stored).                     |
| `version`              | Symbol version, 1–40.                                            |
| `errorCorrectionLevel` | `'L'`, `'M'`, `'Q'` or `'H'`.                                    |
| `mask`                 | Data mask pattern, 0–7.                                          |
| `correctedCodewords`   | How many codewords error correction repaired.                    |
| `mirrored`             | The code was printed or photographed mirror-image.               |
| `corners`              | The symbol's four corners in image pixels (quiet zone excluded). |

## How it works

1. **Threshold.** The image is converted to grey levels. Noise is estimated from the quietest
   image blocks, and noisy images are smoothed first. A local, block-based threshold then copes
   with shadows and glare.
2. **Find.** Finder patterns are found as 1 : 1 : 3 : 1 : 1 runs, confirmed by vertical,
   horizontal and diagonal crossings. They are grouped into triples that look like a symbol's
   corners.
3. **Locate.** The module size is measured along the symbol's own sides, which gives the version.
   The full perspective transform is fitted by least squares to every edge of the three finder
   patterns: each edge point lies on a known module grid line. The bottom-right alignment
   pattern is then sought where that fit predicts it and added to the fit. A quick read of the
   timing patterns rejects wrong sizes before any full decode.
4. **Read.** Modules are sampled from the thresholded image and, if that fails, from the grey
   levels against the local dark and light levels of the module grid. The second path rescues
   soft-focus codes.
5. **Decode.** Format and version information are decoded (BCH / Golay, up to 3 bit errors per
   copy), the mask is removed, and the codewords are de-interleaved. Each block is corrected
   with Reed–Solomon over GF(256) (Berlekamp–Massey, Chien search, Forney), and the segments are
   decoded.

Fallbacks: other thresholds and block sizes, the unsmoothed image, light-on-dark, mirror-image
and a half-size copy.

## Development

```sh
pnpm install
pnpm test     # unit tests, every version × level, image degradations, robustness, speed
pnpm check    # type-check
pnpm build    # dist/
```

Test symbols come from an independent encoder (`qrcode`, a dev dependency only). They are
rendered into camera-like images by the test harness's own geometry, so a bug in the decoder
cannot hide behind shared code.
