// Wraps jsQR + adds: bilinear corner→module mapping, module-bit re-sampling from
// the source image, and format-info BCH decoding so we can show mask + EC level.

import { sizeForVersion } from './qr-anatomy.js';

// --- Bilinear corner → image-pixel mapping ---
// u, v in [0, 1] where (0,0) is top-left corner of the QR (outer edge of TL finder).
export function projectUV(loc, u, v) {
  const tl = loc.topLeftCorner;
  const tr = loc.topRightCorner;
  const bl = loc.bottomLeftCorner;
  const br = loc.bottomRightCorner;
  const x = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + (1 - u) * v * bl.x + u * v * br.x;
  const y = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + (1 - u) * v * bl.y + u * v * br.y;
  return { x, y };
}

// Convert module (row, col) to image pixel — center of that module.
// size = total modules per side. Returns image-space (x, y).
export function moduleToPixel(loc, size, row, col) {
  return projectUV(loc, (col + 0.5) / size, (row + 0.5) / size);
}

// Project a module's 4 corners to image space (for drawing quads / hit-test buffer).
export function moduleCorners(loc, size, row, col) {
  return [
    projectUV(loc, col / size,       row / size),
    projectUV(loc, (col + 1) / size, row / size),
    projectUV(loc, (col + 1) / size, (row + 1) / size),
    projectUV(loc, col / size,       (row + 1) / size),
  ];
}

// Sample the bit at every module by reading the center pixel from imageData.
// Returns size×size boolean array (true = dark/1).
export function sampleBitMatrix(imageData, loc, size) {
  const { data, width, height } = imageData;
  const bits = Array.from({ length: size }, () => new Array(size).fill(false));
  // Determine a threshold: average a small grid of samples.
  let sum = 0, count = 0;
  for (let i = 0; i < size; i += 2) {
    for (let j = 0; j < size; j += 2) {
      const p = moduleToPixel(loc, size, i, j);
      const x = Math.max(0, Math.min(width - 1, Math.round(p.x)));
      const y = Math.max(0, Math.min(height - 1, Math.round(p.y)));
      const idx = (y * width + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      sum += lum;
      count++;
    }
  }
  const threshold = sum / count;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const p = moduleToPixel(loc, size, i, j);
      const x = Math.max(0, Math.min(width - 1, Math.round(p.x)));
      const y = Math.max(0, Math.min(height - 1, Math.round(p.y)));
      const idx = (y * width + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      bits[i][j] = lum < threshold;
    }
  }
  return bits;
}

// --- Format info BCH(15,5) decoding ---
// The 32 valid format-info bit strings (already XORed with mask 0x5412 per spec).
// Index = (ecLevel << 3) | maskPattern where ecLevel encodes L=01, M=00, Q=11, H=10.
const FORMAT_INFO_TABLE = [
  // ec=M (00), masks 0-7
  0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
  // ec=L (01), masks 0-7
  0x77C4, 0x72F3, 0x7DAA, 0x789D, 0x662F, 0x6318, 0x6C41, 0x6976,
  // ec=H (10), masks 0-7
  0x1689, 0x13BE, 0x1CE7, 0x19D0, 0x0762, 0x0255, 0x0D0C, 0x083B,
  // ec=Q (11), masks 0-7
  0x355F, 0x3068, 0x3F31, 0x3A06, 0x24B4, 0x2183, 0x2EDA, 0x2BED,
];

const EC_LEVEL_NAMES = ['M', 'L', 'H', 'Q']; // indexed by 2-bit raw value
const EC_LEVEL_RECOVERY = { L: '~7%', M: '~15%', Q: '~25%', H: '~30%' };

// Read 15 bits of format info copy 1 from a bitMatrix (true=1).
// Order: (8,0..5), (8,7), (8,8), (7,8), (5..0, 8)
function readFormatCopy1(bm) {
  let v = 0;
  const positions = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
    [8, 7], [8, 8], [7, 8],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (const [r, c] of positions) v = (v << 1) | (bm[r][c] ? 1 : 0);
  return v;
}

function readFormatCopy2(bm, size) {
  let v = 0;
  const positions = [];
  for (let r = size - 1; r >= size - 7; r--) positions.push([r, 8]);
  for (let c = size - 8; c <= size - 1; c++) positions.push([8, c]);
  for (const [r, c] of positions) v = (v << 1) | (bm[r][c] ? 1 : 0);
  return v;
}

function hamming(a, b) {
  let v = a ^ b, n = 0;
  while (v) { n += v & 1; v >>>= 1; }
  return n;
}

// Returns { ecLevel: 'L'|'M'|'Q'|'H', mask: 0-7, distance: number } or null.
export function decodeFormatInfo(bm, size) {
  const candidates = [readFormatCopy1(bm), readFormatCopy2(bm, size)];
  let best = null;
  for (const raw of candidates) {
    for (let i = 0; i < 32; i++) {
      const d = hamming(raw, FORMAT_INFO_TABLE[i]);
      if (!best || d < best.distance) {
        best = { distance: d, ecLevel: EC_LEVEL_NAMES[i >> 3], mask: i & 7, raw };
      }
    }
  }
  if (!best || best.distance > 3) return null;
  best.recovery = EC_LEVEL_RECOVERY[best.ecLevel];
  return best;
}

// Human-readable mask formula descriptions.
export const MASK_FORMULAS = {
  0: '(row + col) mod 2 == 0',
  1: 'row mod 2 == 0',
  2: 'col mod 3 == 0',
  3: '(row + col) mod 3 == 0',
  4: '(⌊row/2⌋ + ⌊col/3⌋) mod 2 == 0',
  5: '(row · col) mod 2 + (row · col) mod 3 == 0',
  6: '((row · col) mod 2 + (row · col) mod 3) mod 2 == 0',
  7: '((row + col) mod 2 + (row · col) mod 3) mod 2 == 0',
};

// Detect the mode used in the encoded data, given the raw decoded bytes / chunks
// from jsQR's result. jsQR exposes `chunks` with `type` already — we just label.
export function summarizeChunks(chunks) {
  if (!chunks || !chunks.length) return [];
  return chunks.map((c) => ({
    mode: c.type, // 'numeric' | 'alphanumeric' | 'byte' | 'kanji' | 'eci' | 'fnc1...'
    text: c.text ?? null,
    bytes: c.bytes ?? null,
  }));
}

// Pretty-print a "translated" view of decoded data: detect URL, vCard, wifi, etc.
export function interpretContent(data) {
  if (!data) return { kind: 'empty', label: 'Empty', detail: '' };
  const trimmed = data.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      return {
        kind: 'url',
        label: 'URL',
        detail: `Opens ${u.hostname}${u.pathname !== '/' ? u.pathname : ''}`,
        url: trimmed,
      };
    } catch {
      return { kind: 'url', label: 'URL (malformed)', detail: trimmed };
    }
  }
  if (/^WIFI:/i.test(trimmed)) {
    const parts = {};
    trimmed.replace(/^WIFI:/i, '').split(';').forEach((kv) => {
      const m = kv.match(/^([A-Z]):(.*)$/);
      if (m) parts[m[1]] = m[2];
    });
    return {
      kind: 'wifi',
      label: 'Wi-Fi network',
      detail: `SSID "${parts.S || '?'}", security ${parts.T || 'none'}${parts.P ? ', password set' : ''}`,
      fields: parts,
    };
  }
  if (/^mailto:/i.test(trimmed)) {
    return { kind: 'email', label: 'Email', detail: trimmed.replace(/^mailto:/i, '') };
  }
  if (/^tel:/i.test(trimmed)) {
    return { kind: 'tel', label: 'Phone number', detail: trimmed.replace(/^tel:/i, '') };
  }
  if (/^sms:/i.test(trimmed)) {
    return { kind: 'sms', label: 'SMS', detail: trimmed.replace(/^sms:/i, '') };
  }
  if (/^geo:/i.test(trimmed)) {
    return { kind: 'geo', label: 'Geographic location', detail: trimmed.replace(/^geo:/i, '') };
  }
  if (/^BEGIN:VCARD/i.test(trimmed)) {
    return { kind: 'vcard', label: 'Contact (vCard)', detail: 'Phone-importable contact info' };
  }
  if (/^BEGIN:VEVENT/i.test(trimmed) || /^BEGIN:VCALENDAR/i.test(trimmed)) {
    return { kind: 'event', label: 'Calendar event', detail: 'iCal/vEvent format' };
  }
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    return { kind: 'number', label: 'Plain number', detail: trimmed };
  }
  return { kind: 'text', label: 'Plain text', detail: trimmed };
}
