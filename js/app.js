// QR Visualizer — live camera QR scanner with anatomy overlay rendered every frame.

import { buildModuleMap, groupRegions, computeReadPath, COLORS, T } from './qr-anatomy.js';
import {
  moduleCorners,
  sampleBitMatrix,
  decodeFormatInfo,
  MASK_FORMULAS,
  interpretContent,
  summarizeChunks,
} from './decoder.js';
import { EXPLANATIONS, MODE_INFO } from './explanations.js';

const jsQR = window.jsQR;

// --- DOM refs ---
const video = document.getElementById('video');
const captureCanvas = document.getElementById('capture');
const overlayCanvas = document.getElementById('overlay');
const scanCanvas = document.createElement('canvas'); // offscreen
const statusEl = document.getElementById('status');
const sheet = document.getElementById('sheet');
const sheetTitle = document.getElementById('sheet-title');
const sheetShort = document.getElementById('sheet-short');
const sheetBody = document.getElementById('sheet-body');
const sheetClose = document.getElementById('sheet-close');
const resumeBtn = document.getElementById('resume');
const fileInput = document.getElementById('file-input');
const summary = document.getElementById('summary');
const summaryRows = document.getElementById('summary-rows');
const summaryToggle = document.getElementById('summary-toggle');
const summaryPeek = summary?.querySelector('.summary-peek');
const legendBtn = document.getElementById('legend-btn');
const legend = document.getElementById('legend');
const readPathBtn = document.getElementById('readpath-btn');

// --- State ---
let stream = null;
let mode = 'live';            // 'live' (camera) | 'still' (uploaded image)
let scanning = false;

// Latest detection data driving the overlay; null when no QR currently tracked.
let qrInfo = null;            // { version, size, location, data, chunks, formatInfo }
let regions = [];             // grouped regions from the module map (cached per version)
let regionsByVersion = new Map();
let readPathByVersion = new Map();
let openRegionType = null;    // type currently open in the sheet — kept synced as QR changes
let readPathOn = false;
let readPath = [];            // current QR's path

// "Recently saw a QR" hysteresis — keeps overlay & summary visible across brief misses.
const TRACK_TIMEOUT_MS = 600;
let lastSeenAt = 0;

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
    mode = 'live';
    scanning = true;
    syncOverlaySize();
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

// Match overlay canvas dimensions to the video's intrinsic frame so coords line up.
function syncOverlaySize() {
  if (mode !== 'live') return;
  if (video.videoWidth > 0 && (overlayCanvas.width !== video.videoWidth || overlayCanvas.height !== video.videoHeight)) {
    overlayCanvas.width = video.videoWidth;
    overlayCanvas.height = video.videoHeight;
  }
}

// --- Plausibility check (filters jsQR's false positives on noisy frames) ---
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function isPlausibleDetection(result, frameW, frameH) {
  if (!result.data && (!result.chunks || result.chunks.length === 0)) return false;
  const { topLeftCorner: tl, topRightCorner: tr, bottomLeftCorner: bl, bottomRightCorner: br } = result.location;
  const sides = [dist(tl, tr), dist(tr, br), dist(br, bl), dist(bl, tl)];
  const minSide = Math.min(...sides);
  const maxSide = Math.max(...sides);
  if (minSide < 30) return false;
  if (maxSide / minSide > 3.5) return false;
  if (minSide > Math.max(frameW, frameH)) return false;
  const d1 = dist(tl, br);
  const d2 = dist(tr, bl);
  if (Math.max(d1, d2) / Math.min(d1, d2) > 2.5) return false;
  const pts = [tl, tr, br, bl];
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;
  if (area < minSide * minSide * 0.4) return false;
  return true;
}

// Cache module maps per version so we don't rebuild every frame.
function getRegionsForVersion(version) {
  if (regionsByVersion.has(version)) return regionsByVersion.get(version);
  const grid = buildModuleMap(version);
  const grouped = groupRegions(grid);
  const path = computeReadPath(grid);
  regionsByVersion.set(version, { size: grid.size, regions: grouped });
  readPathByVersion.set(version, path);
  return regionsByVersion.get(version);
}

function getReadPath(version) {
  if (!readPathByVersion.has(version)) getRegionsForVersion(version);
  return readPathByVersion.get(version);
}

// --- Per-frame scan + draw loop ---
let lastFormatInfoVersion = -1;

function scanLoop(ts) {
  if (!scanning) return;
  if (video.readyState >= 2 && video.videoWidth > 0) {
    syncOverlaySize();
    const w = video.videoWidth, h = video.videoHeight;
    scanCanvas.width = w;
    scanCanvas.height = h;
    const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    // dontInvert is significantly faster — we can afford running every frame.
    const result = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });

    if (result && isPlausibleDetection(result, w, h)) {
      const version = result.version || 1;
      const { size, regions: grouped } = getRegionsForVersion(version);

      // Decode format info only on first lock / version change (it's the costly part).
      let formatInfo = qrInfo?.formatInfo || null;
      if (!qrInfo || qrInfo.version !== version || qrInfo.data !== result.data) {
        try {
          const bm = sampleBitMatrix(img, result.location, size);
          formatInfo = decodeFormatInfo(bm, size);
        } catch {}
      }

      qrInfo = {
        version,
        size,
        location: result.location,
        data: result.data,
        chunks: result.chunks,
        formatInfo,
      };
      regions = grouped;
      readPath = getReadPath(version);
      lastSeenAt = ts || performance.now();
      statusEl.textContent = `Tracking — version ${version} (${size}×${size})  ·  tap a section`;
      document.body.classList.add('tracking');
      renderSummary();
      drawOverlay();
      // Keep the open sheet content synced to the latest detection.
      if (openRegionType) refreshOpenSheet();
    } else {
      // No detection this frame — clear overlay only after timeout (anti-flicker)
      const now = ts || performance.now();
      if (qrInfo && now - lastSeenAt > TRACK_TIMEOUT_MS) {
        qrInfo = null;
        regions = [];
        clearOverlay();
        summary.hidden = true;
        statusEl.textContent = 'Point camera at a QR code';
        document.body.classList.remove('tracking');
      }
    }
  }
  requestAnimationFrame(scanLoop);
}

function clearOverlay() {
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

function moduleCenter(r, c) {
  const cn = moduleCorners(qrInfo.location, qrInfo.size, r, c);
  return { x: (cn[0].x + cn[2].x) / 2, y: (cn[0].y + cn[2].y) / 2 };
}

// How many on-screen pixels does one QR module span right now?
// Used to decide whether to draw arrows / numbers (only when zoomed in).
function moduleScreenSize() {
  if (!qrInfo) return 0;
  const c0 = moduleCenter(0, 0);
  const c1 = moduleCenter(0, 1);
  const canvasPx = Math.hypot(c1.x - c0.x, c1.y - c0.y);
  // Convert canvas pixels → CSS pixels using the same scaling as clientToCanvas.
  const rect = overlayCanvas.getBoundingClientRect();
  const cw = overlayCanvas.width, ch = overlayCanvas.height;
  if (!cw || !ch) return canvasPx;
  const scale = Math.min(rect.width / cw, rect.height / ch);
  return canvasPx * scale;
}

function drawOverlay() {
  if (!qrInfo) return;
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (readPathOn) drawReadPath(ctx);
  else drawRegions(ctx);
}

function drawRegions(ctx) {
  // Pass 1: fill each region's cells
  for (const region of regions) {
    const color = COLORS[region.type];
    if (!color) continue;
    ctx.fillStyle = color.fill;
    ctx.beginPath();
    for (const [r, c] of region.cells) {
      const cn = moduleCorners(qrInfo.location, qrInfo.size, r, c);
      ctx.moveTo(cn[0].x, cn[0].y);
      ctx.lineTo(cn[1].x, cn[1].y);
      ctx.lineTo(cn[2].x, cn[2].y);
      ctx.lineTo(cn[3].x, cn[3].y);
      ctx.closePath();
    }
    ctx.fill();
  }

  // Pass 2: outline non-data regions for clarity
  for (const region of regions) {
    if (region.type === T.DATA) continue;
    const color = COLORS[region.type];
    if (!color) continue;
    ctx.strokeStyle = color.stroke;
    ctx.lineWidth = 1.5;
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

// Read-path overlay: color each data module by its codeword (8 bits = 1 byte),
// and draw an arrowed polyline showing the placement order. When the on-screen
// module size is large enough, draw numbered bits too.
function drawReadPath(ctx) {
  const screenPx = moduleScreenSize();
  const showArrows = screenPx >= 14;
  const showNumbers = screenPx >= 28;

  // Step 1: dim the function patterns so read-path stands out.
  for (const region of regions) {
    if (region.type === T.DATA) continue;
    ctx.fillStyle = 'rgba(40, 50, 80, 0.55)';
    ctx.beginPath();
    for (const [r, c] of region.cells) {
      const cn = moduleCorners(qrInfo.location, qrInfo.size, r, c);
      ctx.moveTo(cn[0].x, cn[0].y);
      ctx.lineTo(cn[1].x, cn[1].y);
      ctx.lineTo(cn[2].x, cn[2].y);
      ctx.lineTo(cn[3].x, cn[3].y);
      ctx.closePath();
    }
    ctx.fill();
  }

  // Step 2: color each data module by codeword index using an HSL cycle.
  for (let i = 0; i < readPath.length; i++) {
    const [r, c] = readPath[i];
    const codeword = Math.floor(i / 8);
    const hue = (codeword * 41) % 360;
    const cn = moduleCorners(qrInfo.location, qrInfo.size, r, c);
    ctx.fillStyle = `hsla(${hue}, 80%, 55%, 0.65)`;
    ctx.beginPath();
    ctx.moveTo(cn[0].x, cn[0].y);
    ctx.lineTo(cn[1].x, cn[1].y);
    ctx.lineTo(cn[2].x, cn[2].y);
    ctx.lineTo(cn[3].x, cn[3].y);
    ctx.closePath();
    ctx.fill();
  }

  // Step 3: arrowed polyline through bit centers (only when zoomed in).
  if (showArrows) {
    ctx.lineWidth = Math.max(1, screenPx / 14);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const first = moduleCenter(readPath[0][0], readPath[0][1]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < readPath.length; i++) {
      const p = moduleCenter(readPath[i][0], readPath[i][1]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // Arrowheads on codeword boundaries
    const headSize = Math.max(4, screenPx * 0.45);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    for (let i = 8; i < readPath.length; i += 8) {
      const a = moduleCenter(readPath[i - 1][0], readPath[i - 1][1]);
      const b = moduleCenter(readPath[i][0], readPath[i][1]);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - headSize * Math.cos(ang - 0.4), b.y - headSize * Math.sin(ang - 0.4));
      ctx.lineTo(b.x - headSize * Math.cos(ang + 0.4), b.y - headSize * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
    }
  }

  // Step 4: per-bit numbers (only when extremely zoomed in).
  if (showNumbers) {
    const fontSize = Math.max(8, Math.round(screenPx * 0.45));
    ctx.font = `bold ${fontSize}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    for (let i = 0; i < readPath.length; i++) {
      const p = moduleCenter(readPath[i][0], readPath[i][1]);
      const bit = i % 8;
      const cw = Math.floor(i / 8);
      ctx.fillText(`${cw}.${bit}`, p.x, p.y);
    }
  }
}

// --- Click → identify region via point-in-polygon over module quads ---
function pointInQuad(p, q) {
  // q = [TL, TR, BR, BL]. Cross-product sign test for convex quad.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) continue;
    if (sign === 0) sign = cross > 0 ? 1 : -1;
    else if ((cross > 0 ? 1 : -1) !== sign) return false;
  }
  return true;
}

function clientToCanvas(clientX, clientY, rect) {
  const cw = overlayCanvas.width;
  const ch = overlayCanvas.height;
  if (!cw || !ch) return null;
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

function findRegionAt(point) {
  if (!qrInfo) return null;
  // Iterate regions, then cells. Stop at first hit.
  for (const region of regions) {
    for (const [r, c] of region.cells) {
      const quad = moduleCorners(qrInfo.location, qrInfo.size, r, c);
      if (pointInQuad(point, quad)) return region;
    }
  }
  return null;
}

function handleOverlayTap(e) {
  if (!qrInfo) return;
  // pointerup/click both fire on mobile; guard against double-firing.
  if (e.type === 'click' && e._handledByPointer) return;
  const rect = overlayCanvas.getBoundingClientRect();
  const cx = e.clientX ?? e.changedTouches?.[0]?.clientX;
  const cy = e.clientY ?? e.changedTouches?.[0]?.clientY;
  if (cx == null) return;
  const point = clientToCanvas(cx, cy, rect);
  if (!point) return;
  const region = findRegionAt(point);
  if (region) showRegionInfo(region);
}

let pointerSawTap = false;

// --- Bottom sheet ---
function showRegionInfo(region) {
  openRegionType = region.type;
  const exp = EXPLANATIONS[region.type] || EXPLANATIONS[T.DATA];
  sheetTitle.textContent = exp.title;
  sheetShort.textContent = exp.short;
  let body = exp.body;
  if (region.type === T.FORMAT && qrInfo?.formatInfo) {
    const f = qrInfo.formatInfo;
    body += `\n\n— In this QR code —\nError correction level: ${f.ecLevel} (${f.recovery} of codewords recoverable)\nMask pattern: ${f.mask}  —  ${MASK_FORMULAS[f.mask]}`;
  }
  if (region.type === T.DARK && qrInfo) {
    body += `\n\n— In this QR code —\nThis module is at row ${4 * qrInfo.version + 9}, column 8.`;
  }
  if (region.type === T.ALIGNMENT && region.sub) {
    body += `\n\n— In this QR code —\nCentered at row,col = ${region.sub}.`;
  }
  if (region.type === T.VERSION && qrInfo) {
    body += `\n\n— In this QR code —\nVersion ${qrInfo.version} (${qrInfo.size}×${qrInfo.size} modules).`;
  }
  if (region.type === T.DATA && qrInfo) {
    body += `\n\n— In this QR code —\nDecoded payload: ${qrInfo.data || '(empty)'}`;
  }
  sheetBody.textContent = body;
  sheet.classList.add('open');
}

function refreshOpenSheet() {
  // Find any region of the currently-open type and re-render its info
  // (keeps live-updating values like format info accurate as we re-detect).
  if (!openRegionType) return;
  const region = regions.find((r) => r.type === openRegionType);
  if (region) {
    const exp = EXPLANATIONS[openRegionType] || EXPLANATIONS[T.DATA];
    sheetTitle.textContent = exp.title;
    sheetShort.textContent = exp.short;
  }
}

function closeSheet() {
  sheet.classList.remove('open');
  openRegionType = null;
}

// --- Summary card ---
function renderSummary() {
  if (!qrInfo) { summary.hidden = true; return; }
  const interp = interpretContent(qrInfo.data);
  const chunks = summarizeChunks(qrInfo.chunks);
  const f = qrInfo.formatInfo;

  const escape = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const modeBadges = chunks.map((c) => `<span class="badge">${escape(c.mode)}</span>`).join('');

  let interpHtml = '';
  if (interp.kind === 'url') {
    interpHtml = `<a href="${escape(interp.url)}" target="_blank" rel="noopener noreferrer">${escape(interp.url)}</a><div class="hint">${escape(interp.detail)}</div>`;
  } else {
    interpHtml = `<div>${escape(interp.detail)}</div>`;
  }

  const tip = (label, body) =>
    `<div class="summary-label">${label}<span class="tip"><button type="button" class="tip-btn" aria-label="What is this?" data-tip-toggle>i</button><span class="tip-content">${body}</span></span></div>`;

  // Collapsed-state peek line (just the translated value)
  let peekDetail = '';
  if (interp.kind === 'url') peekDetail = interp.url;
  else if (interp.detail) peekDetail = interp.detail;
  else peekDetail = qrInfo.data || '(empty)';
  summaryPeek.innerHTML = `<span class="peek-kind">${escape(interp.label)}</span>${escape(peekDetail)}`;

  summaryRows.innerHTML = `
    <div class="summary-row">
      ${tip('Translated', 'A friendlier interpretation of the raw payload. We auto-detect URLs, Wi-Fi configs, email links, phone numbers, vCards, and calendar events.')}
      <div class="summary-val">
        <span class="kind">${escape(interp.label)}</span>
        ${interpHtml}
      </div>
    </div>
    <div class="summary-row">
      ${tip('Raw content', 'The exact bytes encoded in the QR code, before any interpretation. This is what your phone scanner would hand to whatever app opens the result.')}
      <div class="summary-val mono">${escape(qrInfo.data || '(empty)')}</div>
    </div>
    <div class="summary-row">
      ${tip('Encoding', 'Which QR encoding mode was used to compress the payload into bits. Numeric is most efficient (3 digits per 10 bits); byte mode is the most general (1 byte per 8 bits).')}
      <div class="summary-val">${modeBadges || '<span class="badge">unknown</span>'}
        ${chunks.length === 1 ? `<div class="hint">${escape(MODE_INFO[chunks[0].mode] || '')}</div>` : ''}
      </div>
    </div>
    <div class="summary-row">
      ${tip('Version', 'QR codes come in versions 1–40. Each version up adds 4 modules per side. The grid size is 17 + 4·version.')}
      <div class="summary-val">${qrInfo.version} — ${qrInfo.size}×${qrInfo.size} modules</div>
    </div>
    ${f ? `
    <div class="summary-row">
      ${tip('Error correction', 'Reed-Solomon redundancy level. L recovers ~7%, M ~15%, Q ~25%, H ~30% of damaged codewords. Higher levels make the QR larger but more robust.')}
      <div class="summary-val">Level ${f.ecLevel} (${f.recovery} recoverable)</div>
    </div>
    <div class="summary-row">
      ${tip('Mask pattern', 'After data is placed, one of 8 mask patterns is XORed onto the data modules to avoid large dark/light runs that confuse scanners. The pattern used is recorded in the format info.')}
      <div class="summary-val">${f.mask} — <span class="mono">${escape(MASK_FORMULAS[f.mask])}</span></div>
    </div>` : ''}
  `;
  // Wire tooltip toggles
  summaryRows.querySelectorAll('[data-tip-toggle]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wrap = btn.parentElement;
      const wasOpen = wrap.classList.contains('open');
      summary.querySelectorAll('.tip.open').forEach((t) => t.classList.remove('open'));
      if (!wasOpen) wrap.classList.add('open');
    });
  });
  summary.hidden = false;
}

// --- File upload (still-image mode) ---

// Resample imageData onto a new canvas at the given max dimension.
function rescaleImageData(imgData, maxDim) {
  const w = imgData.width, h = imgData.height;
  const maxSide = Math.max(w, h);
  if (maxSide <= maxDim) return imgData;
  const scale = maxDim / maxSide;
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  src.getContext('2d').putImageData(imgData, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = nw; dst.height = nh;
  const ctx = dst.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, nw, nh);
  return ctx.getImageData(0, 0, nw, nh);
}

// Try multiple strategies — jsQR is sensitive to resolution and inversion order.
// Returns { result, imageData } at whatever resolution succeeded, or null.
function decodeImageDataWithRetries(imgData) {
  const sizes = [];
  const maxSide = Math.max(imgData.width, imgData.height);
  sizes.push(imgData);
  if (maxSide > 1600) sizes.push(rescaleImageData(imgData, 1600));
  if (maxSide > 1024) sizes.push(rescaleImageData(imgData, 1024));
  if (maxSide > 640)  sizes.push(rescaleImageData(imgData, 640));
  const inversions = ['attemptBoth', 'onlyInvert', 'invertFirst', 'dontInvert'];
  for (const data of sizes) {
    for (const inv of inversions) {
      const r = jsQR(data.data, data.width, data.height, { inversionAttempts: inv });
      if (r && isPlausibleDetection(r, data.width, data.height)) {
        return { result: r, imageData: data };
      }
    }
  }
  return null;
}

async function handleFile(file) {
  statusEl.textContent = 'Reading image…';
  const img = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
  } catch {
    URL.revokeObjectURL(url);
    statusEl.textContent = "Couldn't read that file.";
    return;
  }
  const tmp = document.createElement('canvas');
  tmp.width = img.naturalWidth;
  tmp.height = img.naturalHeight;
  tmp.getContext('2d').drawImage(img, 0, 0);
  URL.revokeObjectURL(url);
  const fullImgData = tmp.getContext('2d').getImageData(0, 0, tmp.width, tmp.height);

  statusEl.textContent = 'Scanning image…';
  const decoded = decodeImageDataWithRetries(fullImgData);
  if (!decoded) {
    statusEl.textContent = "No QR code found in that image. Try a closer / sharper photo.";
    return;
  }
  const { result, imageData: usedImg } = decoded;

  // Switch to still mode using whichever resolution actually decoded
  stopCamera();
  mode = 'still';
  captureCanvas.width = usedImg.width;
  captureCanvas.height = usedImg.height;
  overlayCanvas.width = usedImg.width;
  overlayCanvas.height = usedImg.height;
  captureCanvas.getContext('2d').putImageData(usedImg, 0, 0);
  video.style.display = 'none';
  captureCanvas.style.display = 'block';
  document.body.classList.add('tracking');

  const version = result.version || 1;
  const { size, regions: grouped } = getRegionsForVersion(version);
  let formatInfo = null;
  try { formatInfo = decodeFormatInfo(sampleBitMatrix(usedImg, result.location, size), size); } catch {}

  qrInfo = { version, size, location: result.location, data: result.data, chunks: result.chunks, formatInfo };
  regions = grouped;
  readPath = getReadPath(version);
  statusEl.textContent = `Loaded image — version ${version} (${size}×${size})  ·  tap a section`;
  renderSummary();
  drawOverlay();
  resumeBtn.hidden = false;
}

function backToLive() {
  mode = 'live';
  qrInfo = null;
  regions = [];
  summary.hidden = true;
  resumeBtn.hidden = true;
  closeSheet();
  captureCanvas.style.display = 'none';
  video.style.display = 'block';
  clearOverlay();
  if (!stream) startCamera();
  else { scanning = true; requestAnimationFrame(scanLoop); }
}

// --- Wire up ---
// Use pointerup for reliable tap detection on touch + mouse. Fall back to click.
let lastTapAt = 0;
overlayCanvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch' || e.pointerType === 'pen' || e.pointerType === 'mouse') {
    lastTapAt = performance.now();
    handleOverlayTap(e);
  }
});
overlayCanvas.addEventListener('click', (e) => {
  // Skip if pointerup already handled it within the last frame
  if (performance.now() - lastTapAt < 600) return;
  handleOverlayTap(e);
});
sheetClose.addEventListener('click', closeSheet);
resumeBtn.addEventListener('click', backToLive);
fileInput.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) handleFile(f);
});
function setLegendOpen(open) {
  legend.classList.toggle('open', open);
  legendBtn.setAttribute('aria-expanded', String(open));
  legendBtn.textContent = open ? 'Close legend' : 'Legend';
}
legendBtn.addEventListener('click', () => {
  setLegendOpen(!legend.classList.contains('open'));
});
document.getElementById('legend-close')?.addEventListener('click', () => setLegendOpen(false));
document.addEventListener('click', (e) => {
  // close tooltips when clicking outside
  if (!e.target.closest('.tip')) {
    document.querySelectorAll('.tip.open').forEach((t) => t.classList.remove('open'));
  }
});
summaryToggle.addEventListener('click', () => {
  const expanded = summary.getAttribute('aria-expanded') === 'true';
  summary.setAttribute('aria-expanded', String(!expanded));
});
readPathBtn.addEventListener('click', () => {
  readPathOn = !readPathOn;
  readPathBtn.setAttribute('aria-pressed', String(readPathOn));
  document.body.classList.toggle('readpath-on', readPathOn);
  if (qrInfo) drawOverlay();
});
window.addEventListener('resize', syncOverlaySize);

// Init
if (!jsQR) {
  statusEl.textContent = 'Failed to load QR library.';
} else {
  startCamera();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
