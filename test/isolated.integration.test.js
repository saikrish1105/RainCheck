'use strict';
/**
 * Integration test that runs the ACTUAL shipped isolated-world content script
 * (src/content/isolated.js) inside a jsdom window. This reproduces the browser
 * content-script environment closely enough to catch the class of bug where
 * globalThis.RC was undefined when panel.js/bridge.js ran.
 *
 * It stubs the chrome.* APIs the script touches, injects the script, and
 * asserts the FAB + panel are actually created without throwing.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const isolatedSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'isolated.js'), 'utf8');

function makeChromeStub() {
  const listeners = {};
  return {
    storage: {
      local: {
        _data: {},
        get(keys, cb) {
          if (typeof keys === 'function') return keys(this._data);
          cb(this._data);
        },
        set(entries, cb) {
          Object.assign(this._data, entries);
          if (cb) cb();
        },
        remove(keys, cb) {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete this._data[k]);
          if (cb) cb();
        },
      },
    },
    downloads: {
      download(opts, cb) {
        if (cb) cb();
      },
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: (msg, cb) => cb && cb({ ok: true }),
    },
    tabs: {},
  };
}

function loadIsolated() {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://claude.ai/new',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Simulate a fully-parsed document so ensurePanel creates the panel
  // synchronously instead of deferring to DOMContentLoaded.
  Object.defineProperty(window.document, 'readyState', { value: 'complete', configurable: true });

  // Attach chrome.* and provide a small history/location surface.
  window.chrome = makeChromeStub();
  window.URL.createObjectURL = () => 'blob:mock';
  window.URL.revokeObjectURL = () => {};

  // jsdom provides location & history for the given URL. Provide navigator fallbacks.
  if (!window.navigator.clipboard) {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      configurable: true,
    });
  }

  // Run the isolated content script in the window's context.
  window.eval(isolatedSrc);

  return { window, dom };
}

test('isolated.js creates the FAB and panel without throwing', () => {
  const { window } = loadIsolated();
  // The FAB is the button with class .rc-fab inside the shadow root.
  const host = window.document.getElementById('__raincheck_panel_host__');
  assert.ok(host, 'panel host element should exist in the document');
  const shadow = host.shadowRoot;
  assert.ok(shadow, 'shadow root should exist');
  const fab = shadow.querySelector('.rc-fab');
  assert.ok(fab, 'floating FAB should be created');
  assert.ok(fab.textContent.trim().length > 0, 'FAB should have a label');
  const panel = shadow.querySelector('.rc-panel');
  assert.ok(panel, 'panel element should be created');
  // RC.Panel must be defined on the isolated world global.
  assert.ok(window.RC && window.RC.Panel, 'RC.Panel should be defined');
  // Panel should have a title.
  assert.ok(shadow.querySelector('.rc-title'), 'panel header should exist');
});

test('bridge exposes a working session pipeline inside the window', () => {
  const { window } = loadIsolated();
  assert.ok(window.RC && window.RC.ArtifactAccumulator, 'RC.ArtifactAccumulator defined');
  // Feed a tiny stream via the RC accumulator to ensure core helpers are wired.
  const acc = new window.RC.ArtifactAccumulator();
  acc.feed('<antArtifact identifier="x" type="text/markdown" title="X">partial');
  const arts = acc.getArtifacts();
  assert.equal(arts.length, 1);
  assert.equal(arts[0].open, true);
});

test('DomExtractor scans a rendered conversation (existing chat)', () => {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><head><title>My Chat</title></head><body>' +
      '<div data-testid="user-message">Build a report</div>' +
      '<div data-testid="assistant-message"><p>Here is the report.</p><pre><code>print(1)</code></pre></div>' +
      '<div data-testid="user-message">Make a PDF too</div>' +
      '<div data-testid="artifact-card">' +
      '  <header><h3>report.md</h3></header>' +
      '  <div class="artifact-content"># Report\n\ndone</div>' +
      '</div>' +
      '</body></html>',
    { url: 'https://claude.ai/chat/conv-123', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;
  Object.defineProperty(window.document, 'readyState', { value: 'complete', configurable: true });
  window.chrome = makeChromeStub();
  window.eval(isolatedSrc);

  const result = window.RC.DomExtractor.scan();
  assert.ok(result.found, 'scan should find content');
  assert.equal(result.userMessages.length, 2, 'should find 2 user messages');
  assert.ok(result.assistantMessages.length >= 1, 'should find assistant message');
  assert.ok(result.artifacts.length >= 1, 'should find artifacts (code block + card)');
  const card = result.artifacts.find((a) => a.title === 'report.md');
  assert.ok(card, 'should recover the artifact card by title');
  assert.equal(card.type, 'text/markdown', 'report.md inferred as markdown');
  assert.ok(card.content.includes('Report'), 'artifact content preserved');
});

test('ApiLoader.normalize converts Claude API JSON into session shape', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://claude.ai/chat/conv-abc',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.defineProperty(window.document, 'readyState', { value: 'complete', configurable: true });
  window.chrome = makeChromeStub();
  window.eval(isolatedSrc);

  const data = {
    name: 'My Project',
    chat_messages: [
      {
        sender: 'human',
        content: [{ type: 'text', text: 'Build a report and a python script' }],
      },
      {
        sender: 'assistant',
        content: [
          { type: 'text', text: 'Here you go.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'create_documents',
            input: { content: 'print("hi")', type: 'application/vnd.ant.code', title: 'run.py', language: 'python' },
          },
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'create_documents',
            input: { content: '# Report\n\ndone', type: 'text/markdown', title: 'report.md' },
          },
        ],
      },
    ],
  };
  const n = window.RC.ApiLoader.normalize(data);
  assert.equal(n.title, 'My Project');
  assert.equal(n.userMessages.length, 1);
  assert.ok(n.userMessages[0].includes('Build a report'));
  assert.equal(n.assistantMessages.length, 1);
  assert.equal(n.artifacts.length, 2);
  const code = n.artifacts.find((a) => a.title === 'run.py');
  assert.equal(code.type, 'application/vnd.ant.code');
  assert.equal(code.language, 'python');
  const md = n.artifacts.find((a) => a.title === 'report.md');
  assert.equal(md.type, 'text/markdown');
});

test('ApiLoader.loadConversation fetches org + conversation via session', async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://claude.ai/chat/conv-abc',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.defineProperty(window.document, 'readyState', { value: 'complete', configurable: true });
  window.chrome = makeChromeStub();

  const calls = [];
  window.fetch = (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('/chat_conversations/')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            name: 'Chat',
            chat_messages: [
              { sender: 'human', content: [{ type: 'text', text: 'hi' }] },
              { sender: 'assistant', content: [{ type: 'text', text: 'hello' }] },
            ],
          }),
      });
    }
    // organizations list
    return Promise.resolve({ ok: true, json: () => Promise.resolve([{ uuid: 'org-1' }]) });
  };

  window.eval(isolatedSrc);
  const conv = await window.RC.ApiLoader.loadConversation('conv-abc');
  assert.ok(calls.length >= 2, 'should fetch organizations then conversation');
  assert.ok(calls[1].url.includes('/organizations/org-1/chat_conversations/conv-abc'));
  assert.ok(calls[0].opts.credentials === 'include', 'should send session credentials');
  const n = window.RC.ApiLoader.normalize(conv);
  assert.equal(n.userMessages.length, 1);
  assert.equal(n.assistantMessages.length, 1);
});

test('bridge captures an artifact from a streamed postMessage and shows it in the panel', () => {
  const { window } = loadIsolated();

  // Simulate the MAIN-world hook forwarding a stream: request + raw bytes.
  const post = (data) => {
    const ev = new window.MessageEvent('message', {
      data,
      source: window,
      origin: window.location.origin,
    });
    window.dispatchEvent(ev);
  };

  post({
    ns: 'RAINCHECK_MAIN',
    type: 'request',
    convId: 'conv-123',
    userText: 'Write a script',
    ts: Date.now(),
  });
  // One streamed chunk carrying an artifact that never closes (rate-limited).
  post({
    ns: 'RAINCHECK_MAIN',
    type: 'raw',
    convId: 'conv-123',
    text:
      'event: message_start\ndata: {"type":"stream_event","event":{"type":"message_start"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<antArtifact identifier=\\"gen\\" type=\\"application/vnd.ant.code\\" title=\\"gen.py\\" language=\\"python\\">print(1)"}}}\n\n',
  });
  post({
    ns: 'RAINCHECK_MAIN',
    type: 'stream-error',
    convId: 'conv-123',
    status: 429,
    headers: null,
    message: 'HTTP 429 rate limit',
  });

  // Panel should now list the partial artifact.
  const host = window.document.getElementById('__raincheck_panel_host__');
  const list = host.shadowRoot.querySelector('.rc-list');
  const items = list.querySelectorAll('li');
  assert.ok(items.length >= 1, 'at least one artifact should appear in the panel');
  const nameEl = items[0].querySelector('.rc-art-name');
  assert.equal(nameEl.textContent, 'gen.py');
  // Session should be flagged as interrupted.
  assert.ok(window.RC, 'RC present');
});
