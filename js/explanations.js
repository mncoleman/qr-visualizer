// Long-form explanations shown in the info panel when a region is tapped.
// Keep these conversational but technically accurate — they're the educational payload.

import { T } from './qr-anatomy.js';

export const EXPLANATIONS = {
  [T.FINDER]: {
    title: 'Finder Pattern',
    short: 'The three big squares — they let scanners locate and orient the code.',
    body: `Three identical 7×7 squares sit in the top-left, top-right, and bottom-left corners of every QR code. Each one is a nested set of black-white-black rings (a 1:1:3:1:1 ratio along any line through the center).

Scanners scan rows and columns looking for that exact ratio. Once they find three of them, they know:
• Where the QR code is in the image
• Its rough orientation (which corner is which — the missing fourth marks the bottom-right)
• The approximate module size (one "pixel" of the QR)

Fun consequence: a QR code is still readable if rotated, mirrored, or slightly skewed, because the finder pattern is geometrically distinctive from almost any angle.`,
  },

  [T.SEPARATOR]: {
    title: 'Separator',
    short: 'A 1-module-wide white border around each finder pattern.',
    body: `These white strips wrap the inside edges of each finder pattern. They keep the finder's distinctive 1:1:3:1:1 ratio from being corrupted by neighboring data modules.

Without separators, a dark data module right next to the finder could trick the scanner's ratio detector into reading the wrong width.

Separators are always white (zero bits) and are not used for data — they exist purely as visual padding.`,
  },

  [T.TIMING]: {
    title: 'Timing Pattern',
    short: 'Alternating black/white modules — a ruler that maps out the grid.',
    body: `Two strips of strictly alternating dark/light modules: one horizontal (row 6) and one vertical (column 6), running between the finder patterns.

The timing pattern is the QR code's coordinate system. Once a scanner finds the finder patterns, it counts the alternations along the timing pattern to determine exactly how many modules wide the code is — which tells it the version.

Without the timing pattern, the scanner would drift: after dozens of modules of warped or perspective-distorted image, it couldn't tell which cell is which. Timing modules act as gridline anchors.`,
  },

  [T.ALIGNMENT]: {
    title: 'Alignment Pattern',
    short: 'Small 5×5 markers that correct for distortion on large QR codes.',
    body: `Version 2 and up contain one or more 5×5 alignment patterns — nested squares with a single dark center. The number and placement grow with the QR's version.

These help scanners cope with perspective distortion (the QR is photographed at an angle) or surface curvature (printed on a coffee mug, t-shirt, package). The finder patterns alone aren't enough on larger codes because the warping between them accumulates.

By locating each alignment pattern's center, the scanner can build a local map of how the grid is bent and re-sample modules accurately.`,
  },

  [T.FORMAT]: {
    title: 'Format Information',
    short: '15 bits encoding the error-correction level and mask pattern.',
    body: `Format info appears in two copies (so it survives even if one is damaged) wrapping around the top-left finder pattern, and along the top-right and bottom-left edges.

It encodes just 5 bits of real information:
• 2 bits = error correction level (L / M / Q / H — roughly 7% / 15% / 25% / 30% recovery)
• 3 bits = which of 8 mask patterns was XORed onto the data

Those 5 bits are then BCH(15,5)-encoded (adding 10 redundancy bits to make 15) and XORed with the fixed mask 0x5412 to prevent an all-zero format string. The result is the 15 bits you see here.

Format info is the very first thing decoded after finding the code, because nothing else can be read correctly until the mask is known.`,
  },

  [T.VERSION]: {
    title: 'Version Information',
    short: '18 bits identifying the QR version (only present on V7+).',
    body: `On QR versions 7 and up, two 6×3 blocks of 18 bits each appear next to the top-right and bottom-left finder patterns. They redundantly encode the version number (7 through 40).

Smaller versions (1–6) don't include this — the scanner just counts modules along the timing pattern to determine the size.

The version bits are also error-correction-encoded (Golay-style BCH), so a few damaged modules don't break the decode.`,
  },

  [T.DARK]: {
    title: 'Dark Module',
    short: 'A single module that is always black. Always.',
    body: `One specific module — at row (4 × version + 9), column 8 — is always set to dark, regardless of the encoded data or mask. It sits right above the bottom-left finder pattern's separator.

It exists for a slightly silly historical reason: it guarantees that no QR code, regardless of content, can be entirely white in that region. It also serves as a known anchor point during decoding.`,
  },

  [T.DATA]: {
    title: 'Data & Error Correction',
    short: 'The actual payload — and Reed-Solomon redundancy that protects it.',
    body: `Everything that isn't a function pattern (finder, separator, timing, alignment, format, version, dark module) is data + error correction codewords.

Modules are filled in a zigzag pattern starting from the bottom-right corner, snaking up and down 2-column-wide channels, skipping over function patterns.

Each 8-bit codeword represents either:
• A data byte (encoded content — numeric, alphanumeric, byte/UTF-8, or kanji mode)
• A Reed-Solomon error correction byte

The data starts with a 4-bit mode indicator, then a length field, then the encoded content, then a terminator. The remaining capacity is error-correction codewords, which can recover the data even if a fraction of the modules are unreadable.

Finally, a mask pattern is XORed onto these modules to break up large dark or light regions that could confuse the scanner. The mask used is recorded in the format info.`,
  },

  [T.QUIET]: {
    title: 'Quiet Zone',
    short: 'The blank margin around the QR. Required, even though it carries no data.',
    body: `The QR specification calls for a 4-module-wide white border around the entire code. Without it, the scanner can struggle to distinguish where the QR ends and the surrounding artwork or text begins.

It's tempting to print QR codes flush with other content — and many work anyway — but reliability drops, especially on imperfect images or curved surfaces.`,
  },
};

// Friendly description for the decoded content modes
export const MODE_INFO = {
  numeric: 'Numeric mode — encodes digits 0-9 only, 3 digits per 10 bits (most efficient).',
  alphanumeric: 'Alphanumeric mode — encodes 0-9, A-Z, space, and $%*+-./:  (2 chars per 11 bits).',
  byte: 'Byte mode — encodes arbitrary bytes, typically interpreted as ISO-8859-1 or UTF-8 text.',
  kanji: 'Kanji mode — encodes Shift-JIS Japanese characters (13 bits per character).',
};
