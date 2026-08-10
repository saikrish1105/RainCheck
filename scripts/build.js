'use strict';
/**
 * build.js — bundles the ISOLATED-world content script into a single file.
 *
 * Chrome content scripts do not reliably share a global across the separate
 * JS files of one content_scripts entry in every environment. To make the
 * isolated world fully self-contained (and immune to that), this concatenates
 * parser-core + panel + bridge into one file, src/content/isolated.js.
 *
 * The MAIN world hook (network-hook.js) needs no core helpers, so it stays a
 * single standalone file.
 *
 * Run:  npm run build
 */
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src');
const files = [
  path.join(src, 'shared', 'parser-core.js'),
  path.join(src, 'content', 'dom-extractor.js'),
  path.join(src, 'content', 'api-loader.js'),
  path.join(src, 'content', 'panel.js'),
  path.join(src, 'content', 'bridge.js'),
];

const banner =
  '/*\n' +
  ' * isolated.js — GENERATED file. Do not edit directly.\n' +
  ' * Regenerate with `npm run build` after editing parser-core.js / panel.js / bridge.js.\n' +
  ' */\n';

const body = files
  .map((f) => {
    let code = fs.readFileSync(f, 'utf8');
    if (code.charCodeAt(code.length - 1) !== 10) code += '\n';
    return '\n/* ===== SOURCE: ' + path.relative(src, f) + ' ===== */\n' + code;
  })
  .join('');

const outPath = path.join(src, 'content', 'isolated.js');
fs.writeFileSync(outPath, banner + body + '\n');
console.log('Wrote ' + path.relative(process.cwd(), outPath) + ' (' + body.length + ' chars)');
