/**
 * isolated.js — RainCheck Summary (minimal).
 *
 * A single self-contained content script. It adds a small draggable cloud
 * button to claude.ai. Clicking it opens a panel with ONE action: "Generate
 * Summary". Pressing it pulls the current conversation from Claude's own API
 * (using your existing session) and produces a rate-limit handoff text
 * containing:
 *   - the continuation header,
 *   - Claude's saved summary of the text so far,
 *   - the entire text interaction,
 *   - the last text before the rate limit was hit,
 *   - the full chat JSON, and
 *   - Claude's summary again (from the API).
 *
 * Nothing happens automatically. State is per-tab: a fresh/new page shows an
 * empty panel, and navigating to another conversation reloads that page's
 * details on demand.
 *
 * The pure text-building logic is exported via CommonJS so it can be unit
 * tested in Node; the DOM/UI code only runs when `document` is present.
 */
(function () {
  'use strict';

  const API_ROOT = 'https://claude.ai/api';

  /* ==================================================================
   * Pure helpers (no DOM) — unit-testable in Node.
   * ================================================================== */

  /** Extract the text of a single chat message (handles both shapes). */
  function msgText(m) {
    if (!m || typeof m !== 'object') return '';
    if (typeof m.text === 'string') return m.text;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b) => b && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
    }
    return '';
  }

  /** Extract the last meaningful text before the rate limit / cut-off. */
  function lastMessageText(chatMessages) {
    const arr = Array.isArray(chatMessages) ? chatMessages : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const t = msgText(arr[i]).trim();
      if (t) return t;
    }
    return '';
  }

  /** Join every message's text in order into one block. */
  function entireInteractionText(chatMessages) {
    const arr = Array.isArray(chatMessages) ? chatMessages : [];
    const parts = [];
    for (const m of arr) {
      const t = msgText(m).trim();
      if (t) parts.push(t);
    }
    return parts.join('\n\n');
  }

  /**
   * Build the full handoff output string.
   * data: the raw conversation JSON from the API (has .chat_messages and .summary).
   */
  function buildOutput(data) {
    const chatMessages =
      (data && (Array.isArray(data.chat_messages) ? data.chat_messages : [])) || [];
    const summary = (data && typeof data.summary === 'string' ? data.summary : '').trim();
    const name = (data && data.name) || '';

    const header =
      'You are continuing a session that was interrupted by a rate limit. ' +
      'Do NOT restart from scratch — continue exactly where it stopped.';

    const lines = [];
    lines.push(header);
    lines.push('');
    lines.push('The summary of the text so far:');
    lines.push(summary || '(No saved summary available)');
    lines.push('');
    lines.push('The entire text interaction:');
    lines.push(entireInteractionText(chatMessages) || '(No messages)');
    lines.push('');
    lines.push('The last text before rate limit was hit:');
    lines.push(lastMessageText(chatMessages) || '(No messages)');
    lines.push('');
    lines.push('Full chat JSON (all user + assistant messages):');
    lines.push(JSON.stringify(chatMessages, null, 2));
    lines.push('');
    lines.push('Claude summary (pulled from API):');
    lines.push(summary || '(No saved summary available)');

    if (name) {
      lines.push('');
      lines.push('Conversation: ' + name);
    }

    return lines.join('\n');
  }

  /* ==================================================================
   * API access.
   * ================================================================== */

  function getOrgId() {
    return fetch(API_ROOT + '/organizations', {
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    })
      .then((r) => {
        if (!r.ok) throw new Error('organizations API error ' + r.status);
        return r.json();
      })
      .then((orgs) => {
        if (Array.isArray(orgs) && orgs.length && orgs[0].uuid) return orgs[0].uuid;
        if (orgs && typeof orgs === 'object' && orgs.uuid) return orgs.uuid;
        throw new Error('Could not determine your Claude organization id');
      });
  }

  function loadConversation(conversationId) {
    return getOrgId().then((orgId) => {
      const params = '?tree=true&rendering_mode=messages&render_all_tools=true';
      const url =
        API_ROOT +
        '/organizations/' +
        encodeURIComponent(orgId) +
        '/chat_conversations/' +
        encodeURIComponent(conversationId) +
        params;
      return fetch(url, {
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
      }).then((res) => {
        if (!res.ok) throw new Error('conversation API error ' + res.status);
        return res.json();
      });
    });
  }

  function convIdFromUrl() {
    const m = location.pathname.match(/\/(?:chat|c)\/([0-9a-fA-F-]{8,})/);
    return m ? m[1] : null;
  }

  /* ==================================================================
   * DOM / UI — only runs in the browser.
   * ================================================================== */

  function copyText(text, done) {
    const cb = () => done && done();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(cb, () => fallbackCopy(text, cb));
    } else {
      fallbackCopy(text, cb);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (_) {}
    document.body.removeChild(ta);
    done();
  }

  function initUI() {
    const host = document.createElement('div');
    host.id = '__raincheck_summary_host__';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
:host{all:initial;}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
.rc-cloud{position:fixed;right:16px;bottom:16px;width:64px;height:64px;z-index:2147483647;cursor:grab;user-select:none;filter:drop-shadow(0 4px 8px rgba(0,0,0,.25));}
.rc-cloud img{width:100%;height:100%;pointer-events:none;}
.rc-cloud.dragging{cursor:grabbing;opacity:.9;}
.rc-panel{position:fixed;right:16px;bottom:92px;width:540px;max-width:calc(100vw - 32px);max-height:72vh;display:none;flex-direction:column;background:#1e1f24;border:1px solid #383a42;border-radius:14px;box-shadow:0 16px 44px rgba(0,0,0,.5);z-index:2147483646;overflow:hidden;color:#e7e7e7;font-size:13px;}
.rc-panel.open{display:flex;}
.rc-head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#26282e;border-bottom:1px solid #383a42;flex:0 0 auto;}
.rc-head img{width:24px;height:24px;border-radius:6px;}
.rc-title{font-weight:700;font-size:14px;flex:1;}
.rc-close{background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;}
.rc-body{padding:14px;overflow-y:auto;flex:1 1 auto;}
.rc-generate{width:100%;background:linear-gradient(135deg,#2f6feb,#b146c2);color:#fff;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:700;cursor:pointer;}
.rc-generate:disabled{opacity:.6;cursor:not-allowed;}
.rc-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;}
.rc-btn{background:#3a3d46;color:#e7e7e7;border:none;border-radius:8px;padding:6px 11px;font-size:12px;font-weight:600;cursor:pointer;}
.rc-btn:disabled{opacity:.5;cursor:not-allowed;}
.rc-btn.primary{background:#2f6feb;color:#fff;}
.rc-status{margin-top:10px;font-size:12px;color:#9aa0ab;min-height:15px;}
.rc-status.error{color:#ff8f8f;}
.rc-status.ok{color:#5eead4;}
.rc-out{display:none;margin-top:12px;background:#141519;border:1px solid #383a42;border-radius:10px;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:#cfd3dc;white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;}
.rc-out.visible{display:block;}
.rc-muted{color:#9aa0ab;font-size:11px;margin-top:10px;}
`;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="rc-panel">
        <div class="rc-head">
          <img src="${chrome.runtime.getURL('src/assets/cloud.png')}" alt="" />
          <div class="rc-title">RainCheck · Summary</div>
          <button class="rc-close" title="Close">✕</button>
        </div>
        <div class="rc-body">
          <button class="rc-generate">☁ Generate Summary</button>
          <div class="rc-actions">
            <button class="rc-btn primary rc-copy-all" disabled>Copy All</button>
            <button class="rc-btn rc-copy-json" disabled>Copy JSON</button>
            <button class="rc-btn rc-copy-summary" disabled>Copy Summary</button>
          </div>
          <div class="rc-status"></div>
          <pre class="rc-out"></pre>
          <div class="rc-muted">Everything stays on your device. This is a per-tab tool.</div>
        </div>
      </div>
      <div class="rc-cloud" title="RainCheck">
        <img src="${chrome.runtime.getURL('src/assets/cloud.png')}" alt="RainCheck" />
      </div>
    `;
    shadow.appendChild(wrap);

    const rootEl = wrap;
    const cloud = rootEl.querySelector('.rc-cloud');
    const panel = rootEl.querySelector('.rc-panel');
    const generateBtn = rootEl.querySelector('.rc-generate');
    const statusEl = rootEl.querySelector('.rc-status');
    const outEl = rootEl.querySelector('.rc-out');
    const copyAll = rootEl.querySelector('.rc-copy-all');
    const copyJson = rootEl.querySelector('.rc-copy-json');
    const copySummary = rootEl.querySelector('.rc-copy-summary');
    const closeBtn = rootEl.querySelector('.rc-close');

    let last = { output: '', json: '', summary: '' };

    /* ----- draggable cloud ----- */
    let dragging = false;
    let moved = false;
    let offsetX = 0;
    let offsetY = 0;

    cloud.addEventListener('mousedown', (e) => {
      dragging = true;
      moved = false;
      offsetX = e.clientX - cloud.getBoundingClientRect().left;
      offsetY = e.clientY - cloud.getBoundingClientRect().top;
      cloud.classList.add('dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - offsetX;
      const dy = e.clientY - offsetY;
      if (Math.abs(e.movementX) > 2 || Math.abs(e.movementY) > 2) moved = true;
      cloud.style.right = 'auto';
      cloud.style.bottom = 'auto';
      cloud.style.left = Math.max(0, dx) + 'px';
      cloud.style.top = Math.max(0, dy) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        cloud.classList.remove('dragging');
      }
    });
    cloud.addEventListener('click', () => {
      if (!moved) panel.classList.toggle('open');
    });
    closeBtn.addEventListener('click', () => panel.classList.remove('open'));

    function setStatus(text, kind) {
      statusEl.textContent = text || '';
      statusEl.className = 'rc-status' + (kind ? ' ' + kind : '');
    }

    function resetPanel() {
      last = { output: '', json: '', summary: '' };
      outEl.classList.remove('visible');
      outEl.textContent = '';
      copyAll.disabled = true;
      copyJson.disabled = true;
      copySummary.disabled = true;
      setStatus('');
    }

    /* ----- generate ----- */
    generateBtn.addEventListener('click', () => {
      const convId = convIdFromUrl();
      if (!convId) {
        setStatus('Open a Claude conversation first (this page has no chat open).', 'error');
        return;
      }
      generateBtn.disabled = true;
      setStatus('Loading conversation from Claude…');
      loadConversation(convId)
        .then((data) => {
          const output = buildOutput(data);
          const chatMessages = (data && data.chat_messages) || [];
          const summary = (data && data.summary) || '';
          last = {
            output,
            json: JSON.stringify(chatMessages, null, 2),
            summary: summary,
          };
          outEl.textContent = output;
          outEl.classList.add('visible');
          copyAll.disabled = false;
          copyJson.disabled = false;
          copySummary.disabled = false;
          setStatus(
            '✓ Done. ' + chatMessages.length + ' message(s), ' +
            (summary ? 'summary found' : 'no saved summary') + '.',
            'ok'
          );
        })
        .catch((e) => {
          setStatus('✗ ' + ((e && e.message) || e), 'error');
          outEl.classList.remove('visible');
        })
        .finally(() => {
          generateBtn.disabled = false;
        });
    });

    copyAll.addEventListener('click', () => copyText(last.output, () => flash(copyAll)));
    copyJson.addEventListener('click', () => copyText(last.json, () => flash(copyJson)));
    copySummary.addEventListener('click', () => copyText(last.summary, () => flash(copySummary)));

    function flash(btn) {
      const old = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = old), 1200);
    }

    // Per-tab behavior: clear when navigating to another conversation / new page.
    function handleUrlChange() {
      resetPanel();
    }
    const pushState = history.pushState;
    const replaceState = history.replaceState;
    history.pushState = function () {
      const r = pushState.apply(this, arguments);
      handleUrlChange();
      return r;
    };
    history.replaceState = function () {
      const r = replaceState.apply(this, arguments);
      handleUrlChange();
      return r;
    };
    window.addEventListener('popstate', handleUrlChange);

    document.documentElement.appendChild(host);
    resetPanel();
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUI);
    } else {
      initUI();
    }
  }

  /* Node exports for testing the pure logic. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildOutput, msgText, entireInteractionText, lastMessageText };
  }
})();
