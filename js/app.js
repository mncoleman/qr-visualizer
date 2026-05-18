// QR Visualizer — live camera QR scanner with anatomy overlay rendered every frame.

import { buildModuleMap, groupRegions, computeReadPath, COLORS, T } from './qr-anatomy.js';
import { extractPathBits, parseBitstream } from './bitstream.js';
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

// --- HTML escape helper for all innerHTML insertions of QR-derived content ---
function escapeHtml(s) {
  return String(s).replace(/[&<>"'`]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}

// Allowlist URL schemes for href attributes — defense-in-depth on top of interpretContent.
function isSafeHref(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

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
const freezeBtn = document.getElementById('freeze-btn');
const infoBtn = document.getElementById('info-btn');
const zoomControls = document.getElementById('zoom-controls');
const zoomSlider = document.getElementById('zoom-slider');
const zoomReadout = document.getElementById('zoom-readout');
const scrubber = document.getElementById('scrubber');
const scrubSlider = document.getElementById('scrub-slider');
const scrubPlay = document.getElementById('scrub-play');
const scrubReadout = document.getElementById('scrub-readout');
const scrubInfo = document.getElementById('scrub-info');

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
let isFrozen = false;
let frozenSnapshot = null;    // ImageData of the paused frame
let zoomCaps = null;          // { min, max, step } from track capabilities, or null
let zoomValue = 1;
let infoVisible = false;
let animTimer = null;         // rAF id for read-path animation
let scrubPos = 0;             // current bit position in the read-path (0..pathBits.length-1)
let scrubPlaying = true;
let scrubLastTs = 0;
const SCRUB_BITS_PER_SEC = 60; // how fast the cursor advances when playing

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
    setupZoom();
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
  const s1 = dist(tl, tr), s2 = dist(tr, br), s3 = dist(br, bl), s4 = dist(bl, tl);
  const minSide = s1 < s2 ? (s1 < s3 ? (s1 < s4 ? s1 : s4) : (s3 < s4 ? s3 : s4))
                          : (s2 < s3 ? (s2 < s4 ? s2 : s4) : (s3 < s4 ? s3 : s4));
  const maxSide = s1 > s2 ? (s1 > s3 ? (s1 > s4 ? s1 : s4) : (s3 > s4 ? s3 : s4))
                          : (s2 > s3 ? (s2 > s4 ? s2 : s4) : (s3 > s4 ? s3 : s4));
  if (minSide < 30) return false;
  if (maxSide / minSide > 3.5) return false;
  if (minSide > (frameW > frameH ? frameW : frameH)) return false;
  const d1 = dist(tl, br);
  const d2 = dist(tr, bl);
  if ((d1 > d2 ? d1 / d2 : d2 / d1) > 2.5) return false;
  // Shoelace area
  let area = (tl.x * tr.y - tr.x * tl.y)
           + (tr.x * br.y - br.x * tr.y)
           + (br.x * bl.y - bl.x * br.y)
           + (bl.x * tl.y - tl.x * bl.y);
  area = area < 0 ? -area / 2 : area / 2;
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

// --- Camera zoom (CSS-based digital zoom) ---
// We deliberately avoid track.applyConstraints({ zoom }) — it's flaky on iOS
// and bad values can kill the stream. CSS transform is consistent everywhere.
const ZOOM_MIN = 1.0;
const ZOOM_MAX = 5.0;
const zoomStage = document.getElementById('zoom-stage');

function setupZoom() {
  zoomValue = 1;
  if (zoomSlider) {
    zoomSlider.min = String(ZOOM_MIN);
    zoomSlider.max = String(ZOOM_MAX);
    zoomSlider.step = '0.1';
    zoomSlider.value = '1';
  }
  applyZoom(1);
}

function updateZoomReadout() {
  zoomReadout.textContent = `${zoomValue.toFixed(1)}×`;
}

function applyZoom(target) {
  const v = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(target) || 1));
  zoomValue = v;
  if (zoomStage) zoomStage.style.setProperty('--zoom', String(v));
  updateZoomReadout();
}

// --- Freeze / resume ---
function freezeFrame() {
  if (mode !== 'live' || isFrozen) return;
  isFrozen = true;
  scanning = false;
  // Snapshot the current video frame to captureCanvas
  const w = video.videoWidth || overlayCanvas.width;
  const h = video.videoHeight || overlayCanvas.height;
  captureCanvas.width = w;
  captureCanvas.height = h;
  const ctx = captureCanvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  frozenSnapshot = ctx.getImageData(0, 0, w, h);
  video.style.display = 'none';
  captureCanvas.style.display = 'block';
  // Run one decode on the snapshot so qrInfo reflects this exact frame
  const r = jsQR(frozenSnapshot.data, w, h, { inversionAttempts: 'attemptBoth' });
  if (r && isPlausibleDetection(r, w, h)) {
    const version = r.version || 1;
    const { size, regions: grouped } = getRegionsForVersion(version);
    let formatInfo = null;
    try { formatInfo = decodeFormatInfo(sampleBitMatrix(frozenSnapshot, r.location, size), size); } catch {}
    qrInfo = { version, size, location: r.location, data: r.data, chunks: r.chunks, formatInfo };
    regions = grouped;
    readPath = getReadPath(version);
    ensureBitstream(qrInfo, frozenSnapshot);
    document.body.classList.add('tracking');
    renderSummary();
    showScrubberIfReady();
    updateScrubUI();
  }
  drawOverlay();
  freezeBtn.setAttribute('aria-pressed', 'true');
  freezeBtn.setAttribute('aria-label', 'Resume');
  freezeBtn.title = 'Resume';
  document.getElementById('freeze-icon').innerHTML = '<polygon points="6 4 20 12 6 20 6 4"/>';
  statusEl.textContent = qrInfo ? `Frozen — version ${qrInfo.version}  ·  tap a section` : 'Frozen';
}

function resumeFrame() {
  if (!isFrozen) return;
  isFrozen = false;
  frozenSnapshot = null;
  captureCanvas.style.display = 'none';
  video.style.display = 'block';
  freezeBtn.setAttribute('aria-pressed', 'false');
  freezeBtn.setAttribute('aria-label', 'Freeze frame');
  freezeBtn.title = 'Freeze';
  document.getElementById('freeze-icon').innerHTML = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
  // Resume scanning; let detection refresh qrInfo before we draw the scrubber again
  if (qrInfo) {
    scrubPos = 0;
    scrubPlaying = true;
  }
  scanning = true;
  requestAnimationFrame(scanLoop);
}

// --- Info drawer visibility ---
function setInfoVisible(v) {
  infoVisible = v;
  document.body.classList.toggle('show-info', v);
  infoBtn.setAttribute('aria-pressed', String(v));
}

// --- Read path animation loop ---
function startAnimLoop() {
  if (animTimer) return;
  scrubLastTs = performance.now();
  const tick = (ts) => {
    if (!readPathOn || !qrInfo) { animTimer = null; return; }
    if (scrubPlaying && qrInfo.pathBits && qrInfo.pathBits.length > 0) {
      const dt = (ts - scrubLastTs) / 1000;
      scrubPos += dt * SCRUB_BITS_PER_SEC;
      if (scrubPos >= qrInfo.pathBits.length - 1) scrubPos = 0; // loop
      updateScrubUI();
    }
    scrubLastTs = ts;
    drawOverlay();
    animTimer = requestAnimationFrame(tick);
  };
  animTimer = requestAnimationFrame(tick);
}
function stopAnimLoop() {
  if (animTimer) cancelAnimationFrame(animTimer);
  animTimer = null;
}

// Compute the un-masked bit stream + parsed semantic chunks for the current QR.
// Called whenever qrInfo gets a fresh detection. Cached in qrInfo.
function ensureBitstream(qi, imageData) {
  if (qi.pathBits) return;
  if (!qi.formatInfo) return;
  try {
    const bitMatrix = sampleBitMatrix(imageData, qi.location, qi.size);
    const pathArr = getReadPath(qi.version);
    const bits = extractPathBits(bitMatrix, pathArr, qi.formatInfo.mask);
    const parsed = parseBitstream(bits, qi.version);
    qi.pathBits = bits;
    qi.parsed = parsed;
  } catch (e) {
    console.warn('Bitstream parse failed', e);
  }
}

function updateScrubUI() {
  if (!qrInfo || !qrInfo.pathBits) {
    scrubber.hidden = true;
    scrubInfo.innerHTML = '';
    return;
  }
  const total = qrInfo.pathBits.length;
  const idx = Math.max(0, Math.min(total - 1, Math.floor(scrubPos)));
  scrubSlider.max = String(total - 1);
  if (document.activeElement !== scrubSlider) scrubSlider.value = String(idx);

  const byte = Math.floor(idx / 8);
  const bit = idx % 8;
  const totalBytes = Math.floor(total / 8);
  scrubReadout.textContent = `bit ${idx} · byte ${byte}/${totalBytes - 1}`;
  scrubPlay.textContent = scrubPlaying ? '❚❚' : '▶';

  renderScrubInfo(idx);
}

function renderScrubInfo(idx) {
  if (!qrInfo?.parsed) { scrubInfo.innerHTML = ''; return; }
  const { perBit, chunks } = qrInfo.parsed;
  const info = perBit[idx];
  if (!info) { scrubInfo.innerHTML = ''; return; }

  const byteIdx = info.byteIndex;
  // Build the 8 bits of this byte for display
  const byteStartBit = byteIdx * 8;
  const bitCells = [];
  for (let i = 0; i < 8; i++) {
    const bi = byteStartBit + i;
    if (bi >= qrInfo.pathBits.length) break;
    const on = qrInfo.pathBits[bi];
    const isNow = bi === idx;
    bitCells.push(`<span class="bit ${on ? 'on' : ''} ${isNow ? 'now' : ''}">${on}</span>`);
  }
  // Decode this byte to a hex + char (where applicable).
  // Anything derived from QR content goes through HTML-escape before innerHTML.
  let byteHex = '—', byteInterp = '—';
  if (byteStartBit + 8 <= qrInfo.pathBits.length) {
    let v = 0;
    for (let i = 0; i < 8; i++) v = (v << 1) | qrInfo.pathBits[byteStartBit + i];
    byteHex = '0x' + v.toString(16).padStart(2, '0').toUpperCase();
    if (info.role === 'content' && info.chunkIndex != null) {
      const chunk = chunks[info.chunkIndex];
      if (chunk?.mode === 0b0100) {
        if (v >= 32 && v < 127) byteInterp = `'${escapeHtml(String.fromCharCode(v))}'`;
        else byteInterp = `(byte ${v})`;
      }
    }
  }

  // Role badge + section name
  let sectionName, sectionClass;
  switch (info.role) {
    case 'mode':        sectionName = 'Encoding mode'; sectionClass = 'mode'; break;
    case 'length':      sectionName = 'Length field'; sectionClass = 'length'; break;
    case 'content':     sectionName = 'Content'; sectionClass = 'content'; break;
    case 'terminator':  sectionName = 'Terminator'; sectionClass = 'terminator'; break;
    case 'ecc':         sectionName = 'Error correction'; sectionClass = 'ecc'; break;
    default:            sectionName = info.role || 'data'; sectionClass = 'content';
  }

  // Mode-specific explanation when in 'mode' section
  let modeExtra = '';
  if (info.role === 'mode' && info.chunkIndex != null) {
    const chunk = chunks[info.chunkIndex];
    modeExtra = `<div class="hint" style="color:var(--muted); font-size:12px; margin-top:2px;">Mode = <code>${(chunk?.mode ?? 0).toString(2).padStart(4, '0')}</code> → ${escapeHtml(chunk?.modeName || '?')}</div>`;
  }
  // Length explanation
  let lengthExtra = '';
  if (info.role === 'length' && info.chunkIndex != null) {
    const chunk = chunks[info.chunkIndex];
    lengthExtra = `<div class="hint" style="color:var(--muted); font-size:12px; margin-top:2px;">This chunk encodes ${chunk?.length ?? '?'} characters.</div>`;
  }
  // Content excerpt
  let contentExtra = '';
  if (info.role === 'content' && info.chunkIndex != null) {
    const chunk = chunks[info.chunkIndex];
    if (chunk?.text) {
      const safe = chunk.text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      contentExtra = `<div class="hint" style="color:var(--muted); font-size:12px; margin-top:2px;">Decoded chunk: <span class="mono">${safe}</span></div>`;
    }
  }
  let eccExtra = '';
  if (info.role === 'ecc') {
    eccExtra = `<div class="hint" style="color:var(--muted); font-size:12px; margin-top:2px;">Reed-Solomon parity — not your content, but lets the scanner repair damage.</div>`;
  }

  scrubInfo.innerHTML = `
    <div class="si-row">
      <div class="si-label">Section</div>
      <div class="si-val"><span class="section-pill ${sectionClass}">${sectionName}</span>${modeExtra}${lengthExtra}${contentExtra}${eccExtra}</div>
    </div>
    <div class="si-row">
      <div class="si-label">Byte ${byteIdx}</div>
      <div class="si-val scrub-bits">${bitCells.join('')}</div>
    </div>
    <div class="si-row">
      <div class="si-label">Value</div>
      <div class="si-val mono">${byteHex} ${byteInterp !== '—' ? '· ' + byteInterp : ''}</div>
    </div>
  `;
}

function showScrubberIfReady() {
  scrubber.hidden = !(readPathOn && qrInfo && qrInfo.pathBits);
}

function scanLoop(ts) {
  if (!scanning) return;
  if (isFrozen) { requestAnimationFrame(scanLoop); return; }
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

      // Always re-decode format info — two QRs with identical payload can use
      // different masks, and caching by data string would lock in a wrong mask.
      let formatInfo = null;
      try {
        const bm = sampleBitMatrix(img, result.location, size);
        formatInfo = decodeFormatInfo(bm, size);
      } catch {}

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
      ensureBitstream(qrInfo, img);
      lastSeenAt = ts || performance.now();
      statusEl.textContent = `Tracking — version ${version} (${size}×${size})  ·  tap a section`;
      document.body.classList.add('tracking');
      renderSummary();
      showScrubberIfReady();
      updateScrubUI();
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
        scrubber.hidden = true;
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

// Per-detection projected corners + centers — recomputed only when the
// detected location changes. Cuts the dominant per-frame allocation cost.
let cornersBuf = null;       // Float32Array length size*size*8 (4 corners × x,y)
let centersBuf = null;       // Float32Array length size*size*2
let cornersForLocation = null;
let cornersSize = 0;

function ensureCornersBuf() {
  if (!qrInfo) return;
  const size = qrInfo.size;
  const loc = qrInfo.location;
  // Detect location change cheaply
  const key = loc.topLeftCorner.x + ',' + loc.topLeftCorner.y + ',' +
              loc.topRightCorner.x + ',' + loc.topRightCorner.y + ',' +
              loc.bottomLeftCorner.x + ',' + loc.bottomLeftCorner.y + ',' +
              loc.bottomRightCorner.x + ',' + loc.bottomRightCorner.y;
  if (cornersForLocation === key && cornersSize === size) return;
  cornersForLocation = key;
  cornersSize = size;
  const n = size * size;
  if (!cornersBuf || cornersBuf.length !== n * 8) {
    cornersBuf = new Float32Array(n * 8);
    centersBuf = new Float32Array(n * 2);
  }
  const tl = loc.topLeftCorner, tr = loc.topRightCorner;
  const bl = loc.bottomLeftCorner, br = loc.bottomRightCorner;
  const inv = 1 / size;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const base = (r * size + c) * 8;
      // Four corners: TL(0,0), TR(1,0), BR(1,1), BL(0,1) — order matters for fill
      for (let k = 0; k < 4; k++) {
        let du, dv;
        if (k === 0) { du = 0; dv = 0; }
        else if (k === 1) { du = 1; dv = 0; }
        else if (k === 2) { du = 1; dv = 1; }
        else { du = 0; dv = 1; }
        const uF = (c + du) * inv;
        const vF = (r + dv) * inv;
        const omu = 1 - uF, omv = 1 - vF;
        cornersBuf[base + k * 2]     = omu * omv * tl.x + uF * omv * tr.x + omu * vF * bl.x + uF * vF * br.x;
        cornersBuf[base + k * 2 + 1] = omu * omv * tl.y + uF * omv * tr.y + omu * vF * bl.y + uF * vF * br.y;
      }
      const cb = (r * size + c) * 2;
      centersBuf[cb]     = (cornersBuf[base]     + cornersBuf[base + 4]) / 2;
      centersBuf[cb + 1] = (cornersBuf[base + 1] + cornersBuf[base + 5]) / 2;
    }
  }
}

function moduleCenter(r, c) {
  const base = (r * qrInfo.size + c) * 2;
  return { x: centersBuf[base], y: centersBuf[base + 1] };
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
  ensureCornersBuf();
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (readPathOn) drawReadPath(ctx);
  else drawRegions(ctx);
}

function drawRegions(ctx) {
  const size = qrInfo.size;
  const buf = cornersBuf;
  // Pass 1: fill each region's cells (from cached corners — zero allocs)
  for (const region of regions) {
    const color = COLORS[region.type];
    if (!color) continue;
    ctx.fillStyle = color.fill;
    ctx.beginPath();
    for (const [r, c] of region.cells) {
      const base = (r * size + c) * 8;
      ctx.moveTo(buf[base],     buf[base + 1]);
      ctx.lineTo(buf[base + 2], buf[base + 3]);
      ctx.lineTo(buf[base + 4], buf[base + 5]);
      ctx.lineTo(buf[base + 6], buf[base + 7]);
      ctx.closePath();
    }
    ctx.fill();
  }
  // Pass 2: outline non-data regions, using precomputed bounds
  for (const region of regions) {
    if (region.type === T.DATA) continue;
    const color = COLORS[region.type];
    if (!color) continue;
    const { r0, r1, c0, c1 } = region.bounds;
    const tlIdx = (r0 * size + c0) * 8;
    const trIdx = (r0 * size + (c1 - 1)) * 8;
    const brIdx = ((r1 - 1) * size + (c1 - 1)) * 8;
    const blIdx = ((r1 - 1) * size + c0) * 8;
    ctx.strokeStyle = color.stroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(buf[tlIdx],     buf[tlIdx + 1]);
    ctx.lineTo(buf[trIdx + 2], buf[trIdx + 3]);
    ctx.lineTo(buf[brIdx + 4], buf[brIdx + 5]);
    ctx.lineTo(buf[blIdx + 6], buf[blIdx + 7]);
    ctx.closePath();
    ctx.stroke();
  }
}

// Read-path overlay — a visual story of how a scanner reads the QR.
//   1. Dim function patterns so data area pops.
//   2. Faint colored fill (codeword hue) on every data module.
//   3. A persistent white polyline through ALL bit centers in placement order.
//   4. An animated glowing cursor walks the path so order is obvious.
//   5. Big green "START" pulse on bit 0, big red marker on the last bit.
//   6. The codeword the cursor is currently inside gets a bright outline.
function drawReadPath(ctx) {
  const screenPx = moduleScreenSize();
  const size = qrInfo.size;
  const buf = cornersBuf;
  const cBuf = centersBuf;

  // Pass 1: dim function patterns
  for (const region of regions) {
    if (region.type === T.DATA) continue;
    ctx.fillStyle = 'rgba(15, 21, 48, 0.72)';
    ctx.beginPath();
    for (const [r, c] of region.cells) {
      const base = (r * size + c) * 8;
      ctx.moveTo(buf[base],     buf[base + 1]);
      ctx.lineTo(buf[base + 2], buf[base + 3]);
      ctx.lineTo(buf[base + 4], buf[base + 5]);
      ctx.lineTo(buf[base + 6], buf[base + 7]);
      ctx.closePath();
    }
    ctx.fill();
  }

  // Pass 2: codeword color fill (faint)
  for (let i = 0; i < readPath.length; i++) {
    const [r, c] = readPath[i];
    const codeword = (i / 8) | 0;
    const hue = (codeword * 47) % 360;
    const base = (r * size + c) * 8;
    ctx.fillStyle = `hsla(${hue}, 80%, 60%, 0.35)`;
    ctx.beginPath();
    ctx.moveTo(buf[base],     buf[base + 1]);
    ctx.lineTo(buf[base + 2], buf[base + 3]);
    ctx.lineTo(buf[base + 4], buf[base + 5]);
    ctx.lineTo(buf[base + 6], buf[base + 7]);
    ctx.closePath();
    ctx.fill();
  }

  if (readPath.length === 0) return;

  // Use cached centers — no allocation per frame
  const centers = readPath.map(([r, c]) => {
    const ci = (r * size + c) * 2;
    return { x: cBuf[ci], y: cBuf[ci + 1] };
  });

  // Estimate one "module" in canvas pixels for sizing lines/dots consistently
  const modCanvasPx = Math.hypot(
    centers[1] ? centers[1].x - centers[0].x : 4,
    centers[1] ? centers[1].y - centers[0].y : 4,
  ) || 4;

  // Pass 3: full polyline through all centers — the visible "path"
  ctx.lineWidth = Math.max(1.2, modCanvasPx * 0.18);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(centers[0].x, centers[0].y);
  for (let i = 1; i < centers.length; i++) ctx.lineTo(centers[i].x, centers[i].y);
  ctx.stroke();

  // Pass 4: arrowheads at every codeword boundary (every 8 bits)
  const headSize = Math.max(3, modCanvasPx * 0.5);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  for (let i = 8; i < centers.length; i += 8) {
    const a = centers[i - 1];
    const b = centers[i];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - headSize * Math.cos(ang - 0.45), b.y - headSize * Math.sin(ang - 0.45));
    ctx.lineTo(b.x - headSize * Math.cos(ang + 0.45), b.y - headSize * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
  }

  // Pass 5: cursor position — driven by the scrubber (paused or animating)
  const fpos = Math.max(0, Math.min(centers.length - 1, scrubPos));
  const idx = Math.floor(fpos);
  const frac = fpos - idx;
  const a = centers[idx];
  const b = centers[Math.min(idx + 1, centers.length - 1)];
  const cx = a.x + (b.x - a.x) * frac;
  const cy = a.y + (b.y - a.y) * frac;

  // Trail behind cursor (last ~16 bits) — brighter than baseline path
  const trailStart = Math.max(0, idx - 16);
  ctx.lineWidth = Math.max(1.8, modCanvasPx * 0.32);
  ctx.strokeStyle = 'rgba(110, 231, 183, 0.95)';
  ctx.beginPath();
  ctx.moveTo(centers[trailStart].x, centers[trailStart].y);
  for (let i = trailStart + 1; i <= idx; i++) ctx.lineTo(centers[i].x, centers[i].y);
  ctx.lineTo(cx, cy);
  ctx.stroke();

  // Glow ring around cursor
  const r1 = Math.max(4, modCanvasPx * 0.7);
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r1 * 2.2);
  grad.addColorStop(0, 'rgba(110, 231, 183, 0.95)');
  grad.addColorStop(0.4, 'rgba(110, 231, 183, 0.55)');
  grad.addColorStop(1, 'rgba(110, 231, 183, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r1 * 2.2, 0, Math.PI * 2);
  ctx.fill();
  // Solid dot
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx, cy, r1 * 0.55, 0, Math.PI * 2);
  ctx.fill();

  // Pass 6: START marker (green pulsing dot + label) on bit 0
  const start = centers[0];
  const pulse = 0.7 + 0.3 * Math.sin(performance.now() / 250);
  ctx.fillStyle = `rgba(34, 197, 94, ${pulse})`;
  ctx.beginPath();
  ctx.arc(start.x, start.y, modCanvasPx * 0.85, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(start.x, start.y, modCanvasPx * 0.3, 0, Math.PI * 2);
  ctx.fill();

  // END marker
  const end = centers[centers.length - 1];
  ctx.fillStyle = 'rgba(239, 68, 68, 0.85)';
  ctx.beginPath();
  ctx.arc(end.x, end.y, modCanvasPx * 0.75, 0, Math.PI * 2);
  ctx.fill();

  // Pass 7: labels — "START" and "END" near the markers + cursor codeword index
  const fontPx = Math.max(10, Math.round(modCanvasPx * 1.3));
  ctx.font = `700 ${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // START label
  drawLabel(ctx, 'START', start.x, start.y - modCanvasPx * 2, '#22c55e');
  drawLabel(ctx, 'END',   end.x,   end.y   + modCanvasPx * 2, '#ef4444');
  // Cursor codeword label
  const cwIdx = Math.floor(idx / 8);
  const bitIdx = idx % 8;
  drawLabel(ctx, `byte ${cwIdx} · bit ${bitIdx}`, cx, cy - modCanvasPx * 2, '#6ee7b7');
}

function drawLabel(ctx, text, x, y, color) {
  const padX = 6, padY = 3;
  const m = ctx.measureText(text);
  const w = m.width + padX * 2;
  const h = parseInt(ctx.font, 10) + padY * 2;
  ctx.fillStyle = 'rgba(11, 16, 32, 0.92)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x - w / 2, y - h / 2, w, h, 6) : ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x - w / 2, y - h / 2, w, h, 6) : ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
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

// Reused scratch quad for hit-test — avoids 4-object allocation per cell test.
const _hitQuad = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
function findRegionAt(point) {
  if (!qrInfo || !cornersBuf) return null;
  const size = qrInfo.size;
  const buf = cornersBuf;
  for (const region of regions) {
    // Fast-skip via precomputed bounds first, then per-cell
    for (const [r, c] of region.cells) {
      const base = (r * size + c) * 8;
      _hitQuad[0].x = buf[base];     _hitQuad[0].y = buf[base + 1];
      _hitQuad[1].x = buf[base + 2]; _hitQuad[1].y = buf[base + 3];
      _hitQuad[2].x = buf[base + 4]; _hitQuad[2].y = buf[base + 5];
      _hitQuad[3].x = buf[base + 6]; _hitQuad[3].y = buf[base + 7];
      if (pointInQuad(point, _hitQuad)) return region;
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

  const escape = escapeHtml;
  const modeBadges = chunks.map((c) => `<span class="badge">${escape(c.mode)}</span>`).join('');

  let interpHtml = '';
  if (interp.kind === 'url' && isSafeHref(interp.url)) {
    interpHtml = `<a href="${escape(interp.url)}" target="_blank" rel="noopener noreferrer">${escape(interp.url)}</a><div class="hint">${escape(interp.detail || '')}</div>`;
  } else {
    interpHtml = `<div>${escape(interp.detail || interp.url || qrInfo.data || '')}</div>`;
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
  // Wire tooltip toggles (use pointerup for reliable mobile tap detection)
  summaryRows.querySelectorAll('[data-tip-toggle]').forEach((btn) => {
    const toggle = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const wrap = btn.parentElement;
      const wasOpen = wrap.classList.contains('open');
      summary.querySelectorAll('.tip.open').forEach((t) => t.classList.remove('open'));
      if (!wasOpen) wrap.classList.add('open');
    };
    btn.addEventListener('pointerup', toggle);
    btn.addEventListener('click', (e) => e.preventDefault());
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
  ensureBitstream(qrInfo, usedImg);
  statusEl.textContent = `Loaded image — version ${version} (${size}×${size})  ·  tap a section`;
  renderSummary();
  showScrubberIfReady();
  updateScrubUI();
  drawOverlay();
  resumeBtn.hidden = false;
}

function backToLive() {
  mode = 'live';
  qrInfo = null;
  regions = [];
  summary.hidden = true;
  resumeBtn.hidden = true;
  scrubber.hidden = true;
  scrubPos = 0;
  scrubPlaying = true;
  stopAnimLoop();
  closeSheet();
  captureCanvas.style.display = 'none';
  video.style.display = 'block';
  clearOverlay();
  document.body.classList.remove('tracking');
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
  if (readPathOn) {
    scrubPos = 0;
    scrubPlaying = true;
    startAnimLoop();
    showScrubberIfReady();
    updateScrubUI();
  } else {
    stopAnimLoop();
    scrubber.hidden = true;
  }
  if (qrInfo) drawOverlay();
});
freezeBtn.addEventListener('click', () => {
  if (mode !== 'live') return;
  if (isFrozen) resumeFrame(); else freezeFrame();
});
infoBtn.addEventListener('click', () => setInfoVisible(!infoVisible));
if (zoomSlider) {
  zoomSlider.addEventListener('input', () => applyZoom(Number(zoomSlider.value)));
}

scrubSlider.addEventListener('input', () => {
  if (!qrInfo || !qrInfo.pathBits) return; // guard: no QR locked
  scrubPlaying = false;
  scrubPos = Number(scrubSlider.value);
  updateScrubUI();
  drawOverlay();
});
scrubPlay.addEventListener('click', () => {
  scrubPlaying = !scrubPlaying;
  scrubLastTs = performance.now();
  updateScrubUI();
  if (scrubPlaying && readPathOn) startAnimLoop();
});
window.addEventListener('resize', syncOverlaySize);

// Release the camera when the tab is hidden; restart on return (live mode only).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (mode === 'live') stopCamera();
  } else if (document.visibilityState === 'visible') {
    if (mode === 'live' && !stream) startCamera();
  }
});
window.addEventListener('pagehide', () => { if (mode === 'live') stopCamera(); });

// Init
if (!jsQR) {
  statusEl.textContent = 'Failed to load QR library.';
} else {
  startCamera();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
