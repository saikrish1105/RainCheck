'use strict';
/**
 * store-assets.js — build the Chrome Web Store image assets from a source
 * screenshot.
 *
 * Usage:  node scripts/store-assets.js <path-to-source-screenshot>
 *
 * Produces, into src/assets/store/:
 *   screenshot-1280x800.jpg  (store listing screenshot, required ratio)
 *   screenshot-640x400.jpg   (half-size variant, also accepted)
 *   small-promo-440x280.jpg  (small promo tile — 24-bit JPEG, no alpha)
 *   marquee-1400x560.jpg     (marquee promo tile — 24-bit JPEG, no alpha)
 *
 * Crops are "cover" style: the source is scaled to fill the target ratio and
 * the excess is trimmed from the center, so nothing is distorted and the
 * important UI (usually centered) is preserved.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error('Usage: node scripts/store-assets.js <path-to-source-screenshot>');
  process.exit(1);
}

const outDir = path.join(__dirname, '..', 'src', 'assets', 'store');
fs.mkdirSync(outDir, { recursive: true });

// [filename, width, height]
const TARGETS = [
  ['screenshot-1280x800.jpg', 1280, 800],
  ['screenshot-640x400.jpg', 640, 400],
  ['small-promo-440x280.jpg', 440, 280],
  ['marquee-1400x560.jpg', 1400, 560],
];

function coverResize(inp, out, W, H) {
  // Scale so the whole image covers WxH, then center-crop to exact WxH.
  const args = [
    inp,
    '-auto-orient',
    '-resize',
    `${W}x${H}^`,
    '-gravity',
    'center',
    '-extent',
    `${W}x${H}`,
    '-colorspace',
    'sRGB',
    '-background',
    'white',
    '-alpha',
    'remove',
    '-quality',
    '90',
    out,
  ];
  execFileSync('convert', args);
}

for (const [name, w, h] of TARGETS) {
  const out = path.join(outDir, name);
  coverResize(src, out, w, h);
  console.log('  ' + name);
}

console.log('\nDone. Files are in src/assets/store/');
