'use strict';
/**
 * UI smoke test: loads the real content script into a jsdom window and asserts
 * the draggable cloud button and panel are created inside a shadow root.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'isolated.js'), 'utf8');

function load() {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://claude.ai/chat/315e5d07-3aa1-4f41-86f8-a1a649450102',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.defineProperty(window.document, 'readyState', { value: 'complete', configurable: true });

  window.chrome = {
    runtime: { getURL: (p) => 'chrome-extension://mock/' + p },
  };
  if (!window.navigator.clipboard) {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      configurable: true,
    });
  }

  window.eval(src);
  return window;
}

test('creates the cloud button and panel in a shadow root', () => {
  const window = load();
  const host = window.document.getElementById('__raincheck_summary_host__');
  assert.ok(host, 'host element should exist');
  const shadow = host.shadowRoot;
  assert.ok(shadow, 'shadow root should exist');
  assert.ok(shadow.querySelector('.rc-cloud'), 'cloud button should exist');
  assert.ok(shadow.querySelector('.rc-cloud img'), 'cloud button should contain the image');
  assert.ok(shadow.querySelector('.rc-panel'), 'panel should exist');
  assert.ok(shadow.querySelector('.rc-generate'), 'Generate Summary button should exist');
  assert.ok(shadow.querySelector('.rc-copy-all'), 'Copy All button should exist');
});

test('clicking the cloud toggles the panel open', () => {
  const window = load();
  const host = window.document.getElementById('__raincheck_summary_host__');
  const shadow = host.shadowRoot;
  const panel = shadow.querySelector('.rc-panel');
  const cloud = shadow.querySelector('.rc-cloud');
  assert.equal(panel.classList.contains('open'), false, 'starts closed');
  cloud.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(panel.classList.contains('open'), true, 'opens on click');
});
