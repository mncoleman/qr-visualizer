// QR Code anatomy — builds a per-module type map for any version (1-40)
// Per ISO/IEC 18004. Types tell us what each module of the QR represents.

export const T = {
  FINDER: 'finder',
  SEPARATOR: 'separator',
  TIMING: 'timing',
  ALIGNMENT: 'alignment',
  FORMAT: 'format',
  VERSION: 'version',
  DARK: 'dark',
  DATA: 'data',
  QUIET: 'quiet',
};

// Center positions of alignment patterns per version (ISO/IEC 18004 Annex E)
// Indexed by version number (1..40). Version 1 has none.
export const ALIGNMENT_COORDS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
  14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74],
  17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
  20: [6, 34, 62, 90],
  21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98],
  23: [6, 30, 54, 78, 102], 24: [6, 28, 54, 80, 106],
  25: [6, 32, 58, 84, 110], 26: [6, 30, 58, 86, 114],
  27: [6, 34, 62, 90, 118],
  28: [6, 26, 50, 74, 98, 122], 29: [6, 30, 54, 78, 102, 126],
  30: [6, 26, 52, 78, 104, 130], 31: [6, 30, 56, 82, 108, 134],
  32: [6, 34, 60, 86, 112, 138], 33: [6, 30, 58, 86, 114, 142],
  34: [6, 34, 62, 90, 118, 146],
  35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154],
  37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162],
  39: [6, 26, 54, 82, 110, 138, 166], 40: [6, 30, 58, 86, 114, 142, 170],
};

export function sizeForVersion(v) {
  return 17 + 4 * v;
}

// Build a (size+2) × (size+2) module map — includes 1-module quiet zone padding.
// We'll return an object: { size, map: 2D array of cell descriptors, version }
// Each cell descriptor: { type, role, copy?, idx? }
export function buildModuleMap(version) {
  const size = sizeForVersion(version);
  const map = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({ type: T.DATA, role: 'Data / Error Correction' }))
  );

  const set = (r, c, type, role, extra = {}) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    map[r][c] = { type, role, ...extra };
  };

  // --- Finder patterns (3x 7×7) at TL, TR, BL ---
  const placeFinder = (br, bc, label) => {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        set(br + dr, bc + dc, T.FINDER, `Finder Pattern (${label})`, { sub: label });
      }
    }
  };
  placeFinder(0, 0, 'top-left');
  placeFinder(0, size - 7, 'top-right');
  placeFinder(size - 7, 0, 'bottom-left');

  // --- Separators (1-module white border around each finder) ---
  const placeSeparator = (label, cells) => {
    for (const [r, c] of cells) set(r, c, T.SEPARATOR, `Separator (${label})`, { sub: label });
  };
  // TL separator: row 7 cols 0..7, col 7 rows 0..6
  placeSeparator('top-left', [
    ...Array.from({ length: 8 }, (_, c) => [7, c]),
    ...Array.from({ length: 7 }, (_, r) => [r, 7]),
  ]);
  // TR separator: row 7 cols size-8..size-1, col size-8 rows 0..6
  placeSeparator('top-right', [
    ...Array.from({ length: 8 }, (_, c) => [7, size - 8 + c]),
    ...Array.from({ length: 7 }, (_, r) => [r, size - 8]),
  ]);
  // BL separator: row size-8 cols 0..7, col 7 rows size-7..size-1
  placeSeparator('bottom-left', [
    ...Array.from({ length: 8 }, (_, c) => [size - 8, c]),
    ...Array.from({ length: 7 }, (_, r) => [size - 7 + r, 7]),
  ]);

  // --- Timing patterns (row 6 and col 6, between the finder patterns) ---
  for (let c = 8; c <= size - 9; c++) {
    set(6, c, T.TIMING, 'Timing Pattern (horizontal)', { sub: 'horizontal' });
  }
  for (let r = 8; r <= size - 9; r++) {
    set(r, 6, T.TIMING, 'Timing Pattern (vertical)', { sub: 'vertical' });
  }

  // --- Alignment patterns (5×5) — skip ones overlapping finder patterns ---
  const coords = ALIGNMENT_COORDS[version] || [];
  if (coords.length > 0) {
    const last = coords[coords.length - 1];
    for (const r of coords) {
      for (const c of coords) {
        // Skip the three positions that overlap finder patterns:
        if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            set(r + dr, c + dc, T.ALIGNMENT, `Alignment Pattern (centered at ${r},${c})`, {
              sub: `${r},${c}`,
            });
          }
        }
      }
    }
  }

  // --- Format Info (15 bits, two copies) ---
  // Copy 1: around top-left finder
  //   (8, 0..5), (8, 7), (8, 8), (7, 8), (5..0, 8) — skipping (8, 6) which is timing
  const fmt1 = [];
  for (let c = 0; c <= 5; c++) fmt1.push([8, c]);
  fmt1.push([8, 7]);
  fmt1.push([8, 8]);
  fmt1.push([7, 8]);
  for (let r = 5; r >= 0; r--) fmt1.push([r, 8]);
  fmt1.forEach(([r, c], idx) => {
    set(r, c, T.FORMAT, `Format Information (copy 1, bit ${idx})`, { copy: 1, idx });
  });
  // Copy 2: bottom-left vertical strip and top-right horizontal strip
  //   (size-1..size-7, 8), then (8, size-8..size-1)
  const fmt2 = [];
  for (let r = size - 1; r >= size - 7; r--) fmt2.push([r, 8]);
  for (let c = size - 8; c <= size - 1; c++) fmt2.push([8, c]);
  fmt2.forEach(([r, c], idx) => {
    set(r, c, T.FORMAT, `Format Information (copy 2, bit ${idx})`, { copy: 2, idx });
  });

  // --- Dark Module — always at (4V + 9, 8), always 1 ---
  set(4 * version + 9, 8, T.DARK, 'Dark Module (always 1)');

  // --- Version Info (V >= 7, two 6×3 blocks of 18 bits) ---
  if (version >= 7) {
    // Block 1: rows 0..5, cols size-11..size-9
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 3; c++) {
        set(r, size - 11 + c, T.VERSION, `Version Information (copy 1)`, { copy: 1 });
      }
    }
    // Block 2: rows size-11..size-9, cols 0..5
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 6; c++) {
        set(size - 11 + r, c, T.VERSION, `Version Information (copy 2)`, { copy: 2 });
      }
    }
  }

  return { size, version, map };
}

// Color per type — used by overlay
export const COLORS = {
  [T.FINDER]:    { fill: 'rgba(244, 63, 94, 0.55)',  stroke: '#f43f5e' },  // rose
  [T.SEPARATOR]: { fill: 'rgba(251, 191, 36, 0.45)', stroke: '#fbbf24' },  // amber
  [T.TIMING]:    { fill: 'rgba(34, 197, 94, 0.55)',  stroke: '#22c55e' },  // green
  [T.ALIGNMENT]: { fill: 'rgba(59, 130, 246, 0.55)', stroke: '#3b82f6' },  // blue
  [T.FORMAT]:    { fill: 'rgba(168, 85, 247, 0.55)', stroke: '#a855f7' },  // violet
  [T.VERSION]:   { fill: 'rgba(236, 72, 153, 0.55)', stroke: '#ec4899' },  // pink
  [T.DARK]:      { fill: 'rgba(14, 165, 233, 0.7)',  stroke: '#0ea5e9' },  // sky
  [T.DATA]:      { fill: 'rgba(148, 163, 184, 0.45)', stroke: '#94a3b8' }, // slate
  [T.QUIET]:     { fill: 'rgba(229, 231, 235, 0.3)', stroke: '#e5e7eb' },
};

// Compute the canonical zigzag placement order for data + ECC codewords.
// Returns an ordered list of [row, col] module positions, in the same order a
// QR encoder/decoder reads them. Length = 8 × (data + ecc codewords).
// Per ISO/IEC 18004 §7.7.3.
export function computeReadPath(grid) {
  const { size, map } = grid;
  const isData = (r, c) => map[r][c].type === T.DATA;
  const path = [];
  let row = size - 1;
  let col = size - 1;
  let goingUp = true;

  while (col > 0) {
    if (col === 6) col--; // skip vertical timing column
    while (row >= 0 && row < size) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (c >= 0 && isData(row, c)) path.push([row, c]);
      }
      row += goingUp ? -1 : 1;
    }
    goingUp = !goingUp;
    row += goingUp ? -1 : 1; // step back into bounds
    col -= 2;
  }
  return path;
}

// Group adjacent same-type cells into rectangular regions for cleaner overlay.
// Returns array of { type, role, sub, copy, cells: [[r,c],...] }
export function groupRegions(grid) {
  const { size, map } = grid;
  const visited = Array.from({ length: size }, () => Array(size).fill(false));
  const regions = [];

  const keyOf = (cell) => `${cell.type}|${cell.role}|${cell.sub || ''}|${cell.copy || ''}`;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (visited[r][c]) continue;
      const cell = map[r][c];
      const k = keyOf(cell);
      // BFS flood-fill
      const stack = [[r, c]];
      const cells = [];
      while (stack.length) {
        const [rr, cc] = stack.pop();
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        if (visited[rr][cc]) continue;
        if (keyOf(map[rr][cc]) !== k) continue;
        visited[rr][cc] = true;
        cells.push([rr, cc]);
        stack.push([rr + 1, cc], [rr - 1, cc], [rr, cc + 1], [rr, cc - 1]);
      }
      // Precompute bounding rows/cols once at construction so per-frame draw
       // doesn't have to .map() + spread Math.min/max over potentially-many cells.
      let r0 = cells[0][0], r1 = r0, c0 = cells[0][1], c1 = c0;
      for (const [rr, cc] of cells) {
        if (rr < r0) r0 = rr; else if (rr > r1) r1 = rr;
        if (cc < c0) c0 = cc; else if (cc > c1) c1 = cc;
      }
      regions.push({ ...cell, cells, bounds: { r0, r1: r1 + 1, c0, c1: c1 + 1 } });
    }
  }
  return regions;
}
