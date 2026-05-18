// QR X-Ray — live camera QR scanner with anatomy overlay.

import { buildModuleMap, groupRegions, COLORS, T } from './qr-anatomy.js';
import {
  moduleCorners,
  sampleBitMatrix,
  decodeFormatInfo,
  MASK_FORMULAS,
  interpretContent,
  summarizeChunks,
} from './decoder.js';
import { EXPLANATIONS, MODE_INFO } from './explanations.js';

// jsQR is loaded globally via <script src="js/jsQR.js">
const jsQR = window.jsQR;

// --- DOM refs ---
const video = document.getElementById('video');
const captureCanvas = document.getElementById('capture');         // visible frozen frame
const overlayCanvas = document.getElementById('overlay');         // drawn regions
const hitCanvas = document.createElement('canvas');               // off-screen region IDs
const scanCanvas = document.createElement('canvas');              // off-screen scan buffer
const statusEl = document.getElementById('status');
const sheet = document.getElementById('sheet');
const sheetTitle = document.getElementById('sheet-title');
const sheetShort = document.getElementById('sheet-short');
const sheetBody = document.getElementById('sheet-body');
const sheetClose = document.getElementById('sheet-close');
const resumeBtn = document.getElementById('resume');
const fileInput = document.getElementById('file-input');
const summary = document.getElementById('summary');
const legendBtn = document.getElementById('legend-btn');
const legend = document.getElementById('legend');

// --- State ---
let stream = null;
let scanning = false;
let frozen = false;
let currentRegions = [];     // [{type, role, cells, ...}]
let regionIndexByPixel = null; // Uint32Array of length width*height — region index + 1, or 0
let qrInfo = null;            // { version, size, location, data, formatInfo, mode, chunks, ... }

// --- Camera ---
async function startCamera() {
  try {
    statusEl.textContent = 'Requesting camera…';
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    statusEl.textContent = 'Point camera at a QR code';
    scanning = true;
    requestAnimationFrame(scanLoop);
  } catch (err) {
    console.error(err);
    statusEl.innerHTML = `Camera blocked or unavailable. <button id="retry" class="link">Try again</button> &middot; or use the upload button below.`;
    document.getElementById('retry')?.addEventListener('click', () => location.reload());
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  scanning = false;
}

// --- Scan loop ---
function scanLoop() {
  if (!scanning || frozen) return;
  if (video.readyState >= 2 && video.videoWidth > 0) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    scanCanvas.width = w;
    scanCanvas.height = h;
    const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const result = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
    if (result) {
      freezeOnDetection(img, result);
      return;
    }
  }
  requestAnimationFrame(scanLoop);
}

// --- Freeze + analyze ---
function freezeOnDetection(imageData, result) {
  frozen = true;
  scanning = false;
  const w = imageData.width;
  const h = imageData.height;

  // Render the frozen frame at element-fit size
  captureCanvas.width = w;
  captureCanvas.height = h;
  overlayCanvas.width = w;
  overlayCanvas.height = h;
  hitCanvas.width = w;
  hitCanvas.height = h;
  const capCtx = captureCanvas.getContext('2d');
  capCtx.putImageData(imageData, 0, 0);

  // Hide video, show frozen
  video.style.display = 'none';
  captureCanvas.style.display = 'block';
  overlayCanvas.style.display = 'block';
  resumeBtn.hidden = false;

  // Determine version from jsQR's reported size, fallback to estimating
  // jsQR returns `version` on the result object.
  const version = result.version || 1;
  const grid = buildModuleMap(version);
  const regions = groupRegions(grid);
  currentRegions = regions;

  // Try to re-sample bit matrix and decode format info
  let formatInfo = null;
  try {
    const bm = sampleBitMatrix(imageData, result.location, grid.size);
    formatInfo = decodeFormatInfo(bm, grid.size);
  } catch (e) {
    console.warn('Format info read failed', e);
  }

  qrInfo = {
    version,
    size: grid.size,
    location: result.location,
    data: result.data,
    binaryData: result.binaryData,
    chunks: result.chunks,
    formatInfo,
  };

  drawOverlay();
  buildHitBuffer();
  renderSummary();

  statusEl.textContent = `QR detected — version ${version} (${grid.size}×${grid.size} modules)`;
}

// --- Draw overlay polygons per region ---
function drawOverlay() {
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  // Group cells into one Path2D per region for filling, then thin outline per region.
  for (const region of currentRegions) {
    const color = COLORS[region.type];
    if (!color) continue;

    // Fill each cell as a filled quad
    ctx.fillStyle = color.fill;
    ctx.beginPath();
    for (const [r, c] of region.cells) {
      const corners = moduleCorners(qrInfo.location, qrInfo.size, r, c);
      ctx.moveTo(corners[0].x, corners[0].y);
      ctx.lineTo(corners[1].x, corners[1].y);
      ctx.lineTo(corners[2].x, corners[2].y);
      ctx.lineTo(corners[3].x, corners[3].y);
      ctx.closePath();
    }
    ctx.fill();
  }

  // Thicker outlines on top for the high-interest functional regions
  for (const region of currentRegions) {
    if (region.type === T.DATA) continue;
    const color = COLORS[region.type];
    if (!color) continue;
    ctx.strokeStyle = color.stroke;
    ctx.lineWidth = 1.5;
    // Bounding rectangle of region cells, as a polygon in image space
    const rows = region.cells.map((c) => c[0]);
    const cols = region.cells.map((c) => c[1]);
    const r0 = Math.min(...rows);
    const r1 = Math.max(...rows) + 1;
    const c0 = Math.min(...cols);
    const c1 = Math.max(...cols) + 1;
    const tl = moduleCorners(qrInfo.location, qrInfo.size, r0, c0)[0];
    const tr = moduleCorners(qrInfo.location, qrInfo.size, r0, c1 - 1)[1];
    const br = moduleCorners(qrInfo.location, qrInfo.size, r1 - 1, c1 - 1)[2];
    const bl = moduleCorners(qrInfo.location, qrInfo.size, r1 - 1, c0)[3];
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.stroke();
  }
}

// --- Build off-screen hit-test buffer (color = region index + 1) ---
function buildHitBuffer() {
  const ctx = hitCanvas.getContext('2d');
  ctx.clearRect(0, 0, hitCanvas.width, hitCanvas.height);
  // Use a simple integer-to-color encoding
  for (let i = 0; i < currentRegions.length; i++) {
    const region = currentRegions[i];
    const id = i + 1;
    const r = (id >> 16) & 0xff;
    const g = (id >> 8) & 0xff;
    const b = id & 0xff;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.beginPath();
    for (const [rr, cc] of region.cells) {
      const corners = moduleCorners(qrInfo.location, qrInfo.size, rr, cc);
      ctx.moveTo(corners[0].x, corners[0].y);
      ctx.lineTo(corners[1].x, corners[1].y);
      ctx.lineTo(corners[2].x, corners[2].y);
      ctx.lineTo(corners[3].x, corners[3].y);
      ctx.closePath();
    }
    ctx.fill();
  }
}

// --- Click → identify region ---
function handleOverlayClick(e) {
  if (!frozen || !qrInfo) return;
  const rect = overlayCanvas.getBoundingClientRect();
  // Map client coords → canvas pixel coords (account for object-fit: contain)
  const point = clientToCanvas(e.clientX, e.clientY, rect);
  if (!point) return;

  const ctx = hitCanvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data;
  const id = (data[0] << 16) | (data[1] << 8) | data[2];
  if (id === 0) return;
  const region = currentRegions[id - 1];
  if (region) showRegionInfo(region);
}

function clientToCanvas(clientX, clientY, rect) {
  // Canvas displayed via CSS object-fit: contain. Recompute scale.
  const cw = overlayCanvas.width;
  const ch = overlayCanvas.height;
  const containerW = rect.width;
  const containerH = rect.height;
  const scale = Math.min(containerW / cw, containerH / ch);
  const displayW = cw * scale;
  const displayH = ch * scale;
  const offsetX = (containerW - displayW) / 2;
  const offsetY = (containerH - displayH) / 2;
  const px = (clientX - rect.left - offsetX) / scale;
  const py = (clientY - rect.top - offsetY) / scale;
  if (px < 0 || py < 0 || px >= cw || py >= ch) return null;
  return { x: px, y: py };
}

// --- Info sheet ---
function showRegionInfo(region) {
  const exp = EXPLANATIONS[region.type] || EXPLANATIONS[T.DATA];
  sheetTitle.textContent = exp.title;
  sheetShort.textContent = exp.short;
  let body = exp.body;

  // Region-specific addendum
  if (region.type === T.FORMAT && qrInfo.formatInfo) {
    const f = qrInfo.formatInfo;
    body += `\n\n— In this QR code —\nError correction level: ${f.ecLevel} (${f.recovery} of codewords recoverable)\nMask pattern: ${f.mask}  —  ${MASK_FORMULAS[f.mask]}`;
  }
  if (region.type === T.DARK) {
    body += `\n\n— In this QR code —\nThis module is at row ${4 * qrInfo.version + 9}, column 8.`;
  }
  if (region.type === T.ALIGNMENT && region.sub) {
    body += `\n\n— In this QR code —\nCentered at row,col = ${region.sub}.`;
  }
  if (region.type === T.VERSION) {
    body += `\n\n— In this QR code —\nVersion ${qrInfo.version} (${qrInfo.size}×${qrInfo.size} modules).`;
  }
  if (region.type === T.DATA) {
    body += `\n\n— In this QR code —\nDecoded payload: ${qrInfo.data || '(empty)'}`;
  }
  sheetBody.textContent = body;
  sheet.classList.add('open');
}

function closeSheet() {
  sheet.classList.remove('open');
}

// --- Summary card (always visible when frozen) ---
function renderSummary() {
  const interp = interpretContent(qrInfo.data);
  const chunks = summarizeChunks(qrInfo.chunks);
  const f = qrInfo.formatInfo;

  const escape = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const modeBadges = chunks
    .map((c) => `<span class="badge">${escape(c.mode)}</span>`)
    .join('');

  let interpHtml = '';
  if (interp.kind === 'url') {
    interpHtml = `<a href="${escape(interp.url)}" target="_blank" rel="noopener noreferrer">${escape(interp.url)}</a><div class="hint">${escape(interp.detail)}</div>`;
  } else if (interp.kind === 'wifi') {
    interpHtml = `<div>${escape(interp.detail)}</div>`;
  } else {
    interpHtml = `<div>${escape(interp.detail)}</div>`;
  }

  summary.innerHTML = `
    <div class="summary-row">
      <div class="summary-label">Translated</div>
      <div class="summary-val">
        <span class="kind">${escape(interp.label)}</span>
        ${interpHtml}
      </div>
    </div>
    <div class="summary-row">
      <div class="summary-label">Raw content</div>
      <div class="summary-val mono">${escape(qrInfo.data || '(empty)')}</div>
    </div>
    <div class="summary-row">
      <div class="summary-label">Encoding</div>
      <div class="summary-val">${modeBadges || '<span class="badge">unknown</span>'}
        ${chunks.length === 1 ? `<div class="hint">${escape(MODE_INFO[chunks[0].mode] || '')}</div>` : ''}
      </div>
    </div>
    <div class="summary-row">
      <div class="summary-label">Version</div>
      <div class="summary-val">${qrInfo.version} — ${qrInfo.size}×${qrInfo.size} modules</div>
    </div>
    ${f ? `
    <div class="summary-row">
      <div class="summary-label">Error correction</div>
      <div class="summary-val">Level ${f.ecLevel} (${f.recovery} recoverable)</div>
    </div>
    <div class="summary-row">
      <div class="summary-label">Mask pattern</div>
      <div class="summary-val">${f.mask} — <span class="mono">${escape(MASK_FORMULAS[f.mask])}</span></div>
    </div>` : ''}
  `;
  summary.hidden = false;
}

// --- Resume scanning ---
function resumeScan() {
  frozen = false;
  qrInfo = null;
  currentRegions = [];
  summary.hidden = true;
  resumeBtn.hidden = true;
  closeSheet();
  video.style.display = 'block';
  captureCanvas.style.display = 'none';
  overlayCanvas.style.display = 'none';
  statusEl.textContent = 'Point camera at a QR code';
  if (!stream) {
    startCamera();
  } else {
    scanning = true;
    requestAnimationFrame(scanLoop);
  }
}

// --- File upload fallback ---
async function handleFile(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = url;
  });
  const tmp = document.createElement('canvas');
  tmp.width = img.naturalWidth;
  tmp.height = img.naturalHeight;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, tmp.width, tmp.height);
  const result = jsQR(imgData.data, tmp.width, tmp.height, { inversionAttempts: 'attemptBoth' });
  URL.revokeObjectURL(url);
  if (!result) {
    statusEl.textContent = 'No QR code found in that image.';
    return;
  }
  stopCamera();
  video.style.display = 'none';
  freezeOnDetection(imgData, result);
}

// --- Wire up ---
overlayCanvas.addEventListener('click', handleOverlayClick);
sheetClose.addEventListener('click', closeSheet);
resumeBtn.addEventListener('click', resumeScan);
fileInput.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) handleFile(f);
});
legendBtn.addEventListener('click', () => legend.classList.toggle('open'));

// Init
if (!jsQR) {
  statusEl.textContent = 'Failed to load QR library.';
} else {
  startCamera();
}

// Service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
