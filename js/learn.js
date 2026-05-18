// Inline visuals for learn.html — extracted to support a strict CSP.

import { buildModuleMap, computeReadPath } from './qr-anatomy.js';

// --- Render the 8 mask patterns inline from their formulas ---
(function () {
  const formulas = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
    (r, c) => (((r * c) % 2 + (r * c) % 3) % 2) === 0,
    (r, c) => (((r + c) % 2 + (r * c) % 3) % 2) === 0,
  ];
  const svgNS = 'http://www.w3.org/2000/svg';
  const root = document.getElementById('masks');
  if (!root) return;
  const N = 12, cell = 4;
  for (let m = 0; m < 8; m++) {
    const col = m % 4, row = Math.floor(m / 4);
    const ox = 4 + col * 64, oy = 4 + row * 62;
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('transform', `translate(${ox} ${oy})`);
    const bg = document.createElementNS(svgNS, 'rect');
    bg.setAttribute('width', String(N * cell));
    bg.setAttribute('height', String(N * cell));
    bg.setAttribute('fill', 'white');
    g.appendChild(bg);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (formulas[m](r, c)) {
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', String(c * cell));
        rect.setAttribute('y', String(r * cell));
        rect.setAttribute('width', String(cell));
        rect.setAttribute('height', String(cell));
        rect.setAttribute('fill', '#0b1020');
        g.appendChild(rect);
      }
    }
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', String(N * cell / 2));
    label.setAttribute('y', String(N * cell + 8));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-family', 'ui-monospace, monospace');
    label.setAttribute('font-size', '7');
    label.setAttribute('fill', '#0b1020');
    label.textContent = `Mask ${m}`;
    g.appendChild(label);
    root.appendChild(g);
  }
})();

// --- Wikipedia-style annotated byte-group diagram on a V2 QR ---
(function () {
  try {
    const grid = buildModuleMap(2);
    const path = computeReadPath(grid);
    const size = grid.size;
    const svgNS = 'http://www.w3.org/2000/svg';
    const root = document.getElementById('byte-groups');
    if (!root) return;
    const margin = 6;
    const cell = (300 - 2 * margin) / size;
    const oy = margin;

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const t = grid.map[r][c].type;
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', String(margin + c * cell));
        rect.setAttribute('y', String(oy + r * cell));
        rect.setAttribute('width', String(cell));
        rect.setAttribute('height', String(cell));
        if (t === 'finder' || t === 'separator') rect.setAttribute('fill', '#0b1020');
        else if (t === 'timing') rect.setAttribute('fill', '#22c55e');
        else if (t === 'format') rect.setAttribute('fill', '#a855f7');
        else if (t === 'alignment') rect.setAttribute('fill', '#3b82f6');
        else if (t === 'dark') rect.setAttribute('fill', '#0ea5e9');
        else { rect.setAttribute('fill', '#fff'); rect.setAttribute('stroke', '#e5e7eb'); rect.setAttribute('stroke-width', '0.2'); }
        root.appendChild(rect);
      }
    }

    const totalBytes = Math.floor(path.length / 8);
    const dataBytes = Math.min(totalBytes, Math.floor(totalBytes * 0.55));
    const labelFor = (idx) => {
      if (idx === 0) return 'Mode';
      if (idx === 1) return 'Len';
      if (idx < dataBytes) return `c${idx - 1}`;
      return `E${idx - dataBytes + 1}`;
    };
    const colorFor = (idx) => {
      if (idx < 2) return '#fbbf24';
      if (idx < dataBytes) return '#6ee7b7';
      return '#ef4444';
    };

    for (let b = 0; b < totalBytes; b++) {
      const cells = path.slice(b * 8, b * 8 + 8);
      for (const [r, c] of cells) {
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', String(margin + c * cell));
        rect.setAttribute('y', String(oy + r * cell));
        rect.setAttribute('width', String(cell));
        rect.setAttribute('height', String(cell));
        rect.setAttribute('fill', colorFor(b));
        rect.setAttribute('fill-opacity', '0.55');
        root.appendChild(rect);
      }
      for (const [r, c] of cells) {
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('x', String(margin + c * cell + 0.4));
        rect.setAttribute('y', String(oy + r * cell + 0.4));
        rect.setAttribute('width', String(cell - 0.8));
        rect.setAttribute('height', String(cell - 0.8));
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', colorFor(b));
        rect.setAttribute('stroke-width', '0.6');
        root.appendChild(rect);
      }
      const cx = cells.reduce((s, [, c]) => s + c, 0) / cells.length;
      const cy = cells.reduce((s, [r]) => s + r, 0) / cells.length;
      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', String(margin + cx * cell + cell / 2));
      text.setAttribute('y', String(oy + cy * cell + cell / 2 + 1.3));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-family', 'ui-monospace, Menlo, monospace');
      text.setAttribute('font-size', String(Math.max(3.5, cell * 0.45)));
      text.setAttribute('font-weight', '700');
      text.setAttribute('fill', '#0b1020');
      text.textContent = labelFor(b);
      root.appendChild(text);
    }

    const [sr, sc] = path[0];
    const sx = margin + sc * cell + cell / 2;
    const sy = oy + sr * cell + cell / 2;
    const startLbl = document.createElementNS(svgNS, 'text');
    startLbl.setAttribute('x', String(sx + 12));
    startLbl.setAttribute('y', String(sy + 4));
    startLbl.setAttribute('font-family', 'sans-serif');
    startLbl.setAttribute('font-size', '8');
    startLbl.setAttribute('font-weight', '700');
    startLbl.setAttribute('fill', '#22c55e');
    startLbl.textContent = '← start here';
    root.appendChild(startLbl);

    const legendY = oy + size * cell + 6;
    const legendItems = [
      { c: '#fbbf24', t: 'Mode / Length' },
      { c: '#6ee7b7', t: 'Content bytes' },
      { c: '#ef4444', t: 'Error-correction spares' },
    ];
    legendItems.forEach((it, i) => {
      const lx = margin + i * 100;
      const sw = document.createElementNS(svgNS, 'rect');
      sw.setAttribute('x', String(lx));
      sw.setAttribute('y', String(legendY));
      sw.setAttribute('width', '8');
      sw.setAttribute('height', '8');
      sw.setAttribute('fill', it.c);
      sw.setAttribute('fill-opacity', '0.7');
      root.appendChild(sw);
      const txt = document.createElementNS(svgNS, 'text');
      txt.setAttribute('x', String(lx + 12));
      txt.setAttribute('y', String(legendY + 7));
      txt.setAttribute('font-family', 'sans-serif');
      txt.setAttribute('font-size', '7.5');
      txt.setAttribute('fill', '#94a3b8');
      txt.textContent = it.t;
      root.appendChild(txt);
    });
  } catch (e) {
    console.warn('Byte-group illustration failed', e);
  }
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
