# QR X-Ray

A camera-based QR code anatomy visualizer. Point your phone at a QR code and every section lights up — finder patterns, timing patterns, alignment patterns, format info, data + ECC. Tap any region to read what it is and what it does in *this* code.

🔗 **Live demo:** _will be added once GitHub Pages deploys_

## What it does

- Live camera scanning with [jsQR](https://github.com/cozmo/jsQR)
- Freezes the frame on detection and overlays color-coded regions on top
- Click any section → bottom sheet explains what that part of the QR spec is for
- Shows the decoded payload in both raw form and "translated" form (URL, Wi-Fi config, vCard, etc.)
- Re-samples the bit matrix to decode **mask pattern** and **error-correction level** from the format-info bits
- Full educational `Learn` page covering finder patterns, timing, masks, Reed-Solomon, encoding modes, decoding order
- Installable PWA — works offline after first load
- Mobile-first design with safe-area insets, touch targets, sticky controls

## How it works

| Layer | What |
|-------|------|
| Detection | jsQR scans every video frame; returns the four outer corners + decoded text + version + chunks |
| Module map | `js/qr-anatomy.js` builds a per-version 2D type map (finder/separator/timing/alignment/format/version/dark/data) following ISO/IEC 18004 |
| Overlay | Each module's 4 corners are bilinearly projected from `(u, v) ∈ [0,1]²` onto the QR's image-space corners |
| Hit-test | An off-screen canvas paints each region with a unique RGB id; clicks read the pixel and look up the region |
| Format info | The bit matrix is re-sampled from the frozen image; the 15-bit format info is BCH-corrected against the 32 known valid codes → mask + EC level |

## Run locally

```bash
# Anything that serves static files works. The camera API requires HTTPS or localhost.
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Repo layout

```
index.html          Scanner page
learn.html          Educational deep-dive on the QR spec
manifest.webmanifest
sw.js               PWA service worker (offline-first app shell cache)
css/styles.css
js/
  jsQR.js           jsQR (vendored)
  qr-anatomy.js     Per-version module-type map + alignment-pattern table
  decoder.js        Bilinear projection, bit sampling, format-info BCH decode
  explanations.js   Long-form text shown in the info sheet
  app.js            Camera, scan loop, freeze, overlay, click handling
icons/
```

## Known limitations

- Multi-symbol detection: only the first QR in frame is highlighted
- Codeword-level breakdown (which data byte is which) isn't shown yet — we'd need to follow placement order, de-mask, de-interleave RS blocks. Maybe a future enhancement
- Some heavily damaged QRs may decode but produce a bad format-info read; the UI falls back gracefully

## Credits

- [jsQR](https://github.com/cozmo/jsQR) for detection and decoding
- ISO/IEC 18004 for the QR spec
- [Thonky's QR tutorial](https://www.thonky.com/qr-code-tutorial/) for sanity-checking the alignment-pattern table

## License

MIT
