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
    runtime: {
      // data: URI avoids jsdom trying to fetch a chrome:// script.
      getURL: (p) => 'data:application/javascript,' + encodeURIComponent(''),
    },
  };
  if (!window.navigator.clipboard) {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      configurable: true,
    });
  }

  window.eval(src);
  return { window, dom };
}

function closeDom(dom) {
  try {
    dom.window.close();
  } catch (_) {}
}

test('creates the cloud button and panel in a shadow root', (t) => {
  const { window, dom } = load();
  t.after(() => closeDom(dom));
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

test('clicking the cloud toggles the panel open', (t) => {
  const { window, dom } = load();
  t.after(() => closeDom(dom));
  const host = window.document.getElementById('__raincheck_summary_host__');
  const shadow = host.shadowRoot;
  const panel = shadow.querySelector('.rc-panel');
  const cloud = shadow.querySelector('.rc-cloud');
  assert.equal(panel.classList.contains('open'), false, 'starts closed');
  cloud.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(panel.classList.contains('open'), true, 'opens on click');
});

test('usage bar attaches after the model selector appears', (t) => {
  const { window, dom } = load();
  t.after(() => closeDom(dom));
  // Build a realistic claude.ai-like flex toolbar row with a model selector + buttons.
  const row = window.document.createElement('div');
  row.style.display = 'flex';
  row.style.flexDirection = 'row';
  const sel = window.document.createElement('div');
  sel.setAttribute('data-testid', 'model-selector-dropdown');
  const b1 = window.document.createElement('button');
  const b2 = window.document.createElement('button');
  row.appendChild(sel);
  row.appendChild(b1);
  row.appendChild(b2);
  window.document.body.appendChild(row);
  window.dispatchEvent(new window.Event('popstate'));
  // Let async waitForElement + attach settle.
  return new Promise((resolve) => setTimeout(() => {
    const usageRow = window.document.querySelector('.cc-usageRow');
    assert.ok(usageRow, 'usage row should be created');
    assert.ok(usageRow.querySelector('.cc-bar--usage'), 'usage bar should be created');
    resolve();
  }, 100));
});
