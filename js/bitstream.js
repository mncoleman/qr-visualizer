// Bitstream analysis for QR Visualizer.
// Given a sampled bit matrix, the read path, the mask, and the version,
// produces (a) the un-masked bits in placement order, (b) a parsed byte stream
// with per-byte semantic roles (mode / length / content / terminator / ecc),
// and (c) a way to look up what role/byte each bit-position belongs to.

const MASK_FORMULAS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
  (r, c) => (((r * c) % 2 + (r * c) % 3) % 2) === 0,
  (r, c) => (((r + c) % 2 + (r * c) % 3) % 2) === 0,
];

const MODE_NAMES = {
  0b0000: 'terminator',
  0b0001: 'numeric',
  0b0010: 'alphanumeric',
  0b0100: 'byte',
  0b0111: 'eci',
  0b1000: 'kanji',
  0b0011: 'structured-append',
  0b0101: 'fnc1-first',
  0b1001: 'fnc1-second',
};

// Length-of-length-field by mode + version-range.
function lengthBits(modeBits, version) {
  // returns number of bits used to encode "length" for the given mode + version
  if (modeBits === 0b0001) return version <= 9 ? 10 : version <= 26 ? 12 : 14; // numeric
  if (modeBits === 0b0010) return version <= 9 ?  9 : version <= 26 ? 11 : 13; // alphanumeric
  if (modeBits === 0b0100) return version <= 9 ?  8 : 16;                       // byte
  if (modeBits === 0b1000) return version <= 9 ?  8 : version <= 26 ? 10 : 12;  // kanji
  return 0;
}

const ALPHANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// Read N consecutive bits from a bits array (MSB first) starting at offset.
function readBitsMSB(bits, offset, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 1) | (bits[offset + i] || 0);
  return v;
}

// Decode a numeric chunk: groups of 10 bits = 3 digits; final group is 4 (1 digit) or 7 (2 digits).
function decodeNumeric(bits, offset, len) {
  let out = '';
  let i = 0;
  while (i + 3 <= len) {
    out += String(readBitsMSB(bits, offset, 10)).padStart(3, '0');
    offset += 10; i += 3;
  }
  if (len - i === 2) { out += String(readBitsMSB(bits, offset, 7)).padStart(2, '0'); offset += 7; }
  else if (len - i === 1) { out += String(readBitsMSB(bits, offset, 4)); offset += 4; }
  return { text: out, consumedBits: offset };
}
function decodeAlphanumeric(bits, offset, len) {
  let out = '';
  let i = 0;
  while (i + 2 <= len) {
    const v = readBitsMSB(bits, offset, 11);
    out += ALPHANUM[Math.floor(v / 45)] + ALPHANUM[v % 45];
    offset += 11; i += 2;
  }
  if (len - i === 1) { out += ALPHANUM[readBitsMSB(bits, offset, 6)]; offset += 6; }
  return { text: out, consumedBits: offset };
}
function decodeByte(bits, offset, len) {
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = readBitsMSB(bits, offset + i * 8, 8);
  offset += len * 8;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
  catch { text = Array.from(bytes).map((b) => String.fromCharCode(b)).join(''); }
  return { text, consumedBits: offset, bytes };
}

// Walk a bit matrix in path order to produce the bits (XOR with mask at data modules).
// `bitMatrix` is { bits: Uint8Array, size } from sampleBitMatrix.
export function extractPathBits(bitMatrix, readPath, maskIndex) {
  const formula = MASK_FORMULAS[maskIndex] || MASK_FORMULAS[0];
  const flat = bitMatrix.bits;
  const size = bitMatrix.size;
  const bits = new Uint8Array(readPath.length);
  for (let i = 0; i < readPath.length; i++) {
    const [r, c] = readPath[i];
    const raw = flat[r * size + c];
    const flip = formula(r, c) ? 1 : 0;
    bits[i] = raw ^ flip;
  }
  return bits;
}

// Parse the bit stream into semantic chunks. Returns:
//   { chunks: [{mode, modeName, length, text, startBit, endBit, contentStartBit}],
//     terminatorBit, eccStartBit }
// Plus a per-bit role lookup: array length = total bits, each entry:
//   { byteIndex, bitInByte, role: 'mode'|'length'|'content'|'terminator'|'padding'|'ecc',
//     chunkIndex, char?: string }
export function parseBitstream(bits, version) {
  const totalBits = bits.length;
  const chunks = [];
  const perBit = new Array(totalBits);
  let off = 0;
  let chunkIdx = 0;

  // Helper to mark a range with role
  const markRange = (from, to, role, chunkIndex = null, charMap = null) => {
    for (let i = from; i < to && i < totalBits; i++) {
      perBit[i] = perBit[i] || {};
      perBit[i].role = role;
      if (chunkIndex != null) perBit[i].chunkIndex = chunkIndex;
      if (charMap && charMap[i] !== undefined) perBit[i].char = charMap[i];
    }
  };

  let terminatorBit = null;
  while (off + 4 <= totalBits) {
    const modeBits = readBitsMSB(bits, off, 4);
    const modeName = MODE_NAMES[modeBits] || `unknown-${modeBits.toString(2).padStart(4, '0')}`;
    const modeStart = off;
    markRange(modeStart, modeStart + 4, 'mode', chunkIdx);
    off += 4;

    if (modeBits === 0b0000) {
      terminatorBit = modeStart;
      // Terminator — rest is padding then ECC. We'll handle below.
      break;
    }
    if (!(modeBits === 0b0001 || modeBits === 0b0010 || modeBits === 0b0100 || modeBits === 0b1000)) {
      // Unsupported / rare mode — bail
      chunks.push({ mode: modeBits, modeName, startBit: modeStart, endBit: off, length: null, text: '(unsupported mode)' });
      chunkIdx++;
      break;
    }

    const lenBitsCount = lengthBits(modeBits, version);
    if (off + lenBitsCount > totalBits) break;
    const length = readBitsMSB(bits, off, lenBitsCount);
    const lengthStart = off;
    markRange(lengthStart, lengthStart + lenBitsCount, 'length', chunkIdx);
    off += lenBitsCount;

    const contentStart = off;
    let text = '';
    if (modeBits === 0b0001) {
      const { text: t, consumedBits } = decodeNumeric(bits, off, length);
      text = t; off = consumedBits;
    } else if (modeBits === 0b0010) {
      const { text: t, consumedBits } = decodeAlphanumeric(bits, off, length);
      text = t; off = consumedBits;
    } else if (modeBits === 0b0100) {
      const { text: t, consumedBits } = decodeByte(bits, off, length);
      text = t; off = consumedBits;
    } else if (modeBits === 0b1000) {
      off += length * 13;
      text = '(kanji)';
    }
    markRange(contentStart, off, 'content', chunkIdx);

    chunks.push({
      mode: modeBits,
      modeName,
      length,
      text,
      startBit: modeStart,
      endBit: off,
      contentStartBit: contentStart,
    });
    chunkIdx++;
  }

  // Anything between off (or terminator) and the byte boundary that completes the final data byte
  // is "padding within byte". Anything after, up to a multiple of 8, is also data-padding bytes
  // (alternating 0xEC, 0x11). Everything beyond the data capacity is ECC. We approximate by
  // marking from current position to the end as 'ecc' since we don't know the exact data byte
  // count without consulting the spec table per version+EC level.
  const dataPadStart = off;
  let i = dataPadStart;
  // Mark padding bits in the same chunk-less role
  if (terminatorBit !== null) {
    for (let t = terminatorBit + 4; t < terminatorBit + 4; t++) {} // noop
  }
  for (; i < totalBits; i++) {
    if (!perBit[i]) perBit[i] = { role: 'ecc' };
  }
  // The terminator nibble itself
  if (terminatorBit !== null) {
    markRange(terminatorBit, terminatorBit + 4, 'terminator', null);
  }

  // Add byte index / bitInByte to all entries
  for (let k = 0; k < totalBits; k++) {
    if (!perBit[k]) perBit[k] = { role: 'ecc' };
    perBit[k].byteIndex = Math.floor(k / 8);
    perBit[k].bitInByte = k % 8;
  }

  return { chunks, perBit, terminatorBit, eccStartBit: dataPadStart };
}
