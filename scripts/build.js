'use strict';
/**
 * build.js — assembles the publishable Chrome extension into dist/.
 *
 * The dist folder contains exactly the files referenced by manifest.json plus
 * proper multi-size icons. Zip it with `npm run package` (or manually) and
 * upload to the Chrome Web Store.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

function copy(src, dest) {
  const destPath = path.join(dist, dest);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(path.join(root, src), destPath);
}

function rmDist() {
  fs.rmSync(dist, { recursive: true, force: true });
}

// Files the manifest references (paths in manifest.json are relative to root).
const MANIFEST_FILES = [
  ['manifest.json', 'manifest.json'],
  ['src/assets/cloud.png', 'src/assets/cloud.png'],
  ['src/content/isolated.js', 'src/content/isolated.js'],
  ['src/injected/bridge.js', 'src/injected/bridge.js'],
  ['src/options/popup.html', 'src/options/popup.html'],
];

rmDist();
fs.mkdirSync(dist, { recursive: true });
for (const [s, d] of MANIFEST_FILES) copy(s, d);

// Add proper multi-size icons at the extension root (Chrome Web Store expects
// a 128px icon; providing 16/32/48/128 is good practice).
const iconsDir = path.join(dist, 'icons');
fs.mkdirSync(iconsDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const srcPng = path.join(root, 'src', 'assets', 'cloud.png');
  const out = path.join(iconsDir, `icon${size}.png`);
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('convert', [srcPng, '-resize', `${size}x${size}`, out]);
  if (r.status !== 0) {
    // Fallback: copy the source (already 128) if ImageMagick isn't available.
    fs.copyFileSync(srcPng, out);
  }
}

console.log('Built dist/ with:');
for (const [, d] of MANIFEST_FILES) console.log('  ' + d);
console.log('  icons/icon{16,32,48,128}.png');
console.log('\nZip dist/ and upload to the Chrome Web Store.');
