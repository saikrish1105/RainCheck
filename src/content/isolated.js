/**
 * isolated.js — RainCheck Summary + Claude Counter (usage bars).
 *
 * Single self-contained ISOLATED-world content script. It provides:
 *
 *  1) A draggable cloud button → panel with "Generate Summary" (pull current
 *     conversation from Claude's API: chat JSON + saved summary).
 *
 *  2) Claude Counter usage bars — session (5h) and weekly (7d) utilization
 *     percentages with progress bars and reset countdowns. Data comes from:
 *       - GET /api/organizations/{orgId}/usage  (utilization % + resets_at)
 *       - live `message_limit` SSE events (utilization 0..1 + resets_at sec)
 *     These are injected into the chat UI (usage line near the model selector).
 *     No token counts are shown (the API only exposes percentages).
 *
 * Uses an injected MAIN-world bridge (src/injected/bridge.js) that intercepts
 * fetch to read `message_limit` SSE events and answers usage requests.
 *
 * Pure logic is CommonJS-exported for unit testing.
 */
(function () {
  'use strict';

  /* ==================================================================
   * 1. SUMMARY — pure helpers (no DOM)
   * ================================================================== */
  function msgText(m) {
    if (!m || typeof m !== 'object') return '';
    // Direct text field (observed shape).
    if (typeof m.text === 'string') return m.text;
    // Nested message envelope: { message: { content: [...] } }.
    if (m.message && typeof m.message === 'object') return msgText(m.message);
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b) => blockText(b))
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  // Extract text from a single content block (handles strings and objects).
  function blockText(b) {
    if (typeof b === 'string') return b;
    if (!b || typeof b !== 'object') return '';
    if (typeof b.text === 'string') return b.text;
    if (b.type === 'tool_use' && b.input && typeof b.input.content === 'string') {
      return b.input.content;
    }
    if (typeof b.content === 'string') return b.content;
    if (Array.isArray(b.content)) {
      return b.content.map(blockText).filter(Boolean).join('\n');
    }
    return '';
  }

  function lastMessageText(chatMessages) {
    const arr = Array.isArray(chatMessages) ? chatMessages : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const t = msgText(arr[i]).trim();
      if (t) return t;
    }
    return '';
  }

  function entireInteractionText(chatMessages) {
    const arr = Array.isArray(chatMessages) ? chatMessages : [];
    const parts = [];
    for (const m of arr) {
      const t = msgText(m).trim();
      if (t) parts.push(t);
    }
    return parts.join('\n\n');
  }

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
   * 2. USAGE — pure helpers (formatting)
   * ================================================================== */
  function formatResetCountdown(timestampMs) {
    const diffMs = timestampMs - Date.now();
    if (diffMs <= 0) return '0s';
    const totalSeconds = Math.floor(diffMs / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const totalMinutes = Math.round(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours < 24) return `${hours}h ${minutes}m`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }

  // Parse /usage endpoint response: utilization is 0..100, resets_at is ISO.
  function parseUsageFromEndpoint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const norm = (w, hours) => {
      if (!w || typeof w !== 'object') return null;
      if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
      const utilization = Math.max(0, Math.min(100, w.utilization));
      const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
      return { utilization, resets_at, window_hours: hours };
    };
    const fiveHour = norm(raw.five_hour, 5);
    const sevenDay = norm(raw.seven_day, 24 * 7);
    if (!fiveHour && !sevenDay) return null;
    return { five_hour: fiveHour, seven_day: sevenDay };
  }

  // Parse message_limit SSE event: utilization is 0..1, resets_at is epoch sec.
  function parseUsageFromMessageLimit(raw) {
    if (!raw?.windows || typeof raw.windows !== 'object') return null;
    const norm = (w, hours) => {
      if (!w || typeof w !== 'object') return null;
      if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
      const utilization = Math.max(0, Math.min(100, w.utilization * 100));
      const resets_at =
        typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
          ? new Date(w.resets_at * 1000).toISOString()
          : null;
      return { utilization, resets_at, window_hours: hours };
    };
    const fiveHour = norm(raw.windows['5h'], 5);
    const sevenDay = norm(raw.windows['7d'], 24 * 7);
    if (!fiveHour && !sevenDay) return null;
    return { five_hour: fiveHour, seven_day: sevenDay };
  }

  /* ==================================================================
   * Shared helpers
   * ================================================================== */
  const API_ROOT = 'https://claude.ai/api';
  let currentOrgId = null;

  function getOrgIdFromCookie() {
    try {
      return (
        document.cookie
          .split('; ')
          .find((row) => row.startsWith('lastActiveOrg='))
          ?.split('=')[1] || null
      );
    } catch {
      return null;
    }
  }

  function convIdFromUrl() {
    const m = location.pathname.match(/\/(?:chat|c)\/([0-9a-fA-F-]{8,})/);
    return m ? m[1] : null;
  }

  function waitForElement(selector, timeoutMs) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }
      let timeoutId;
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          if (timeoutId) clearTimeout(timeoutId);
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      if (timeoutMs) {
        timeoutId = setTimeout(() => {
          observer.disconnect();
          resolve(null);
        }, timeoutMs);
      }
    });
  }

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

  /* ==================================================================
   * Bridge client — talk to the injected MAIN-world bridge via postMessage.
   * ================================================================== */
  function makeBridgeClient() {
    const pending = new Map();
    let readyPromise = null;

    function getRuntime() {
      return globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
    }

    function makeRequestId() {
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function injectBridgeOnce() {
      if (readyPromise) return readyPromise;
      const runtime = getRuntime();
      if (!runtime) return Promise.resolve(false);
      if (document.getElementById('cc-bridge-script')) return Promise.resolve(true);

      readyPromise = new Promise((resolve) => {
        const script = document.createElement('script');
        script.id = 'cc-bridge-script';
        script.src = runtime.getURL('src/injected/bridge.js');
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        (document.head || document.documentElement).appendChild(script);
      });
      return readyPromise;
    }

    function request(kind, payload, { timeoutMs = 10000 } = {}) {
      const requestId = makeRequestId();
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Bridge request timed out (${kind})`));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timeoutId });
        window.postMessage(
          { cc: 'ClaudeCounter', type: 'cc:request', requestId, kind, payload },
          '*'
        );
      });
    }

    function requestUsage(orgId) {
      return request('usage', { orgId }, { timeoutMs: 15000 });
    }

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.cc !== 'ClaudeCounter') return;
      if (data.type === 'cc:response') {
        const { requestId, ok, payload, error } = data;
        const p = pending.get(requestId);
        if (!p) return;
        pending.delete(requestId);
        clearTimeout(p.timeoutId);
        if (ok) p.resolve(payload);
        else p.reject(new Error(error || 'Bridge request failed'));
      } else {
        // pass through event types to handlers
        const listeners = eventHandlers.get(data.type);
        if (listeners) for (const fn of listeners) fn(data.payload);
      }
    });

    const eventHandlers = new Map();
    function on(type, fn) {
      if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
      eventHandlers.get(type).add(fn);
      return () => eventHandlers.get(type)?.delete(fn);
    }

    return { injectBridgeOnce, requestUsage, on };
  }

  /* ==================================================================
   * Main init: inject bridge, set up usage + summary UI.
   * ================================================================== */
  function initAll() {
    const bridge = makeBridgeClient();

    // ---------- USAGE COUNTER STATE ----------
    let usageState = null;
    let usageResetMs = { five_hour: null, seven_day: null };
    let usageFetchInFlight = false;
    let lastUsageSseMs = 0;
    let lastUsageUpdateMs = 0;
    const rolloverHandledForResetMs = { five_hour: null, seven_day: null };

    function applyUsageUpdate(normalized, source) {
      if (!normalized) return;
      const now = Date.now();
      usageState = normalized;
      lastUsageUpdateMs = now;
      if (source === 'sse') lastUsageSseMs = now;
      usageResetMs.five_hour = normalized.five_hour?.resets_at
        ? Date.parse(normalized.five_hour.resets_at)
        : null;
      usageResetMs.seven_day = normalized.seven_day?.resets_at
        ? Date.parse(normalized.seven_day.resets_at)
        : null;
      usageUI.setUsage(normalized);
    }

    function updateOrgIdIfNeeded(newOrgId) {
      if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
        currentOrgId = newOrgId;
      }
    }

    async function refreshUsage() {
      await bridge.injectBridgeOnce();
      const orgId = currentOrgId || getOrgIdFromCookie();
      if (!orgId) return;
      updateOrgIdIfNeeded(orgId);
      if (usageFetchInFlight) return;
      usageFetchInFlight = true;
      let raw;
      try {
        raw = await bridge.requestUsage(orgId);
      } catch {
        return;
      } finally {
        usageFetchInFlight = false;
      }
      const parsed = parseUsageFromEndpoint(raw);
      applyUsageUpdate(parsed, 'usage');
    }

    // ---------- USAGE BAR UI ----------
    const usageUI = createUsageUI({ onRefresh: refreshUsage });
    usageUI.init();

    bridge.on('cc:message_limit', (payload) => {
      const parsed = parseUsageFromMessageLimit(payload);
      applyUsageUpdate(parsed, 'sse');
    });

    // ---------- URL CHANGE ----------
    function handleUrlChange() {
      updateOrgIdIfNeeded(getOrgIdFromCookie());
      waitForElement(MODEL_SELECTOR_DROPDOWN, 60000).then((el) => {
        if (el) usageUI.attach();
      });
      if (!usageState) refreshUsage();
    }

    function observeUrlChanges(callback) {
      let lastPath = location.pathname;
      const fireIfChanged = () => {
        const current = location.pathname;
        if (current !== lastPath) {
          lastPath = current;
          callback();
        }
      };
      window.addEventListener('cc:urlchange', fireIfChanged);
      window.addEventListener('popstate', fireIfChanged);
    }
    observeUrlChanges(handleUrlChange);

    // Tick countdowns + rollover refresh
    function tick() {
      usageUI.tick();
      const now = Date.now();
      if (usageResetMs.five_hour && now >= usageResetMs.five_hour && rolloverHandledForResetMs.five_hour !== usageResetMs.five_hour) {
        rolloverHandledForResetMs.five_hour = usageResetMs.five_hour;
        refreshUsage();
      }
      if (usageResetMs.seven_day && now >= usageResetMs.seven_day && rolloverHandledForResetMs.seven_day !== usageResetMs.seven_day) {
        rolloverHandledForResetMs.seven_day = usageResetMs.seven_day;
        refreshUsage();
      }
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const sseAge = now - lastUsageSseMs;
      const anyAge = now - lastUsageUpdateMs;
      if (!document.hidden && sseAge > ONE_HOUR_MS && anyAge > ONE_HOUR_MS) {
        refreshUsage();
      }
    }
    setInterval(tick, 1000);

    // ---------- SUMMARY PANEL UI ----------
    initSummaryPanel();

    // Initial run
    handleUrlChange();
  }

  /* ==================================================================
   * Usage bar UI (claude-counter style, session/weekly only)
   * ================================================================== */
  const MODEL_SELECTOR_DROPDOWN = '[data-testid="model-selector-dropdown"]';
  const CHAT_MENU_TRIGGER = '[data-testid="chat-menu-trigger"]';
  const CHAT_PROJECT_WRAPPER = '.chat-project-wrapper';

  function createUsageUI({ onRefresh }) {
    const root = document.createElement('div');
    root.className =
      'cc-usageRow cc-hidden flex flex-row items-center gap-3 w-full';
    root.style.cssText =
      'display:none;position:relative;z-index:50;cursor:pointer;user-select:none;' +
      'font-size:11px;color:#9aa0ab;';

    function makeBar() {
      const bar = document.createElement('div');
      bar.className = 'cc-bar cc-bar--usage';
      bar.style.cssText =
        'position:relative;box-sizing:border-box;width:100%;height:10px;flex:1;' +
        'border-radius:3px;border:1px solid #bfbfbf;background:transparent;';
      const fill = document.createElement('div');
      fill.className = 'cc-bar__fill';
      fill.style.cssText =
        'width:0%;height:100%;background:#5aa6ff;transition:width 300ms ease,background-color 300ms ease;' +
        'border-top-left-radius:2px;border-bottom-left-radius:2px;';
      bar.appendChild(fill);
      return { bar, fill };
    }

    const sessionSpan = document.createElement('span');
    sessionSpan.className = 'cc-usageText';
    sessionSpan.style.cssText = 'white-space:nowrap;';
    const session = makeBar();

    const weeklySpan = document.createElement('span');
    weeklySpan.className = 'cc-usageText';
    weeklySpan.style.cssText = 'white-space:nowrap;';
    const weekly = makeBar();

    const sessionGroup = document.createElement('div');
    sessionGroup.style.cssText =
      'display:flex;align-items:center;gap:8px;flex:1;min-width:0;';
    sessionGroup.appendChild(sessionSpan);
    sessionGroup.appendChild(session.bar);

    const weeklyGroup = document.createElement('div');
    weeklyGroup.style.cssText =
      'display:flex;align-items:center;gap:8px;flex:1;min-width:0;justify-content:flex-end;';
    weeklyGroup.appendChild(weekly.bar);
    weeklyGroup.appendChild(weeklySpan);

    root.appendChild(sessionGroup);
    root.appendChild(weeklyGroup);

    let sessionResetMs = null;
    let weeklyResetMs = null;

    function setUsage(usage) {
      const s = usage?.five_hour || null;
      const w = usage?.seven_day || null;
      const hasAny = !!(s && typeof s.utilization === 'number') || !!(w && typeof w.utilization === 'number');
      root.style.display = hasAny ? 'flex' : 'none';

      if (s && typeof s.utilization === 'number') {
        const pct = Math.round(s.utilization * 10) / 10;
        sessionResetMs = s.resets_at ? Date.parse(s.resets_at) : null;
        const resetText = sessionResetMs ? ` · resets in ${formatResetCountdown(sessionResetMs)}` : '';
        sessionSpan.textContent = `Session: ${pct}%${resetText}`;
        const width = Math.max(0, Math.min(100, s.utilization));
        session.fill.style.width = `${width}%`;
        session.fill.style.background = width >= 90 ? '#ce2029' : '#5aa6ff';
      } else {
        sessionSpan.textContent = '';
        session.fill.style.width = '0%';
        sessionResetMs = null;
      }

      const hasWeekly = w && typeof w.utilization === 'number';
      weeklyGroup.style.display = hasWeekly ? 'flex' : 'none';
      if (hasWeekly) {
        const pct = Math.round(w.utilization * 10) / 10;
        weeklyResetMs = w.resets_at ? Date.parse(w.resets_at) : null;
        const resetText = weeklyResetMs ? ` · resets in ${formatResetCountdown(weeklyResetMs)}` : '';
        weeklySpan.textContent = `Weekly: ${pct}%${resetText}`;
        const width = Math.max(0, Math.min(100, w.utilization));
        weekly.fill.style.width = `${width}%`;
        weekly.fill.style.background = width >= 90 ? '#ce2029' : '#5aa6ff';
      } else {
        weeklySpan.textContent = '';
        weekly.fill.style.width = '0%';
        weeklyResetMs = null;
      }
    }

    function updateCountdowns() {
      if (sessionResetMs && sessionSpan.textContent) {
        const idx = sessionSpan.textContent.indexOf('· resets in');
        if (idx !== -1) {
          sessionSpan.textContent =
            sessionSpan.textContent.slice(0, idx + '· resets in '.length) +
            formatResetCountdown(sessionResetMs);
        }
      }
      if (weeklyResetMs && weeklySpan.textContent) {
        const idx = weeklySpan.textContent.indexOf('· resets in');
        if (idx !== -1) {
          weeklySpan.textContent =
            weeklySpan.textContent.slice(0, idx + '· resets in '.length) +
            formatResetCountdown(weeklyResetMs);
        }
      }
    }

    function attach() {
      const modelSelector = document.querySelector(MODEL_SELECTOR_DROPDOWN);
      if (!modelSelector) return;
      const gridContainer = modelSelector.closest('[data-testid="chat-input-grid-container"]');
      const gridArea = modelSelector.closest('[data-testid="chat-input-grid-area"]');
      const findToolbarRow = (el, stopAt) => {
        let cur = el;
        while (cur && cur !== document.body) {
          if (stopAt && cur === stopAt) break;
          if (cur !== el && cur.nodeType === 1) {
            const style = window.getComputedStyle(cur);
            if (style.display === 'flex' && style.flexDirection === 'row') {
              if (cur.querySelectorAll('button').length > 1) return cur;
            }
          }
          cur = cur.parentElement;
        }
        return null;
      };
      const toolbarRow =
        (gridContainer ? findToolbarRow(modelSelector, gridArea || gridContainer) : null) ||
        findToolbarRow(modelSelector) ||
        modelSelector.parentElement?.parentElement?.parentElement;
      if (!toolbarRow) return;
      if (toolbarRow.nextElementSibling !== root) toolbarRow.after(root);
    }

    root.addEventListener('click', () => {
      if (onRefresh) onRefresh();
    });

    return {
      init() {
        // attach when the input area appears
        waitForElement(MODEL_SELECTOR_DROPDOWN, 60000).then((el) => {
          if (el) attach();
        });
      },
      setUsage,
      tick: updateCountdowns,
      attach,
    };
  }

  /* ==================================================================
   * Summary panel (cloud button + Generate Summary)
   * ================================================================== */
  function initSummaryPanel() {
    const host = document.createElement('div');
    host.id = '__raincheck_summary_host__';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
:host{all:initial;}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
.rc-cloud{position:fixed;right:40px;bottom:40px;width:72px;height:72px;z-index:2147483647;cursor:grab;user-select:none;filter:drop-shadow(0 5px 12px rgba(0,0,0,.35));-webkit-tap-highlight-color:transparent;}
.rc-cloud img{width:150%;height:150%;pointer-events:none;display:block;}
.rc-cloud.dragging{cursor:grabbing;opacity:.85;}
.rc-panel{position:fixed;width:540px;max-width:calc(100vw - 32px);max-height:72vh;display:none;flex-direction:column;background:#1e1f24;border:1px solid #383a42;border-radius:14px;box-shadow:0 16px 44px rgba(0,0,0,.5);z-index:2147483646;overflow:hidden;color:#e7e7e7;font-size:13px;}
.rc-panel.open{display:flex;}
.rc-head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#26282e;border-bottom:1px solid #383a42;flex:0 0 auto;}
.rc-head img{width:24px;height:24px;border-radius:6px;}
.rc-title{font-weight:700;font-size:14px;flex:1;}
.rc-close{background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;}
.rc-body{padding:14px;overflow-y:auto;flex:1 1 auto;}
.rc-generate{width:100%;background:linear-gradient(135deg,#ff9a3c,#ff6b2c);color:#fff;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(255,107,44,.35);}
.rc-generate:disabled{opacity:.6;cursor:not-allowed;}
.rc-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;}
.rc-btn{background:#3a3d46;color:#e7e7e7;border:none;border-radius:8px;padding:6px 11px;font-size:12px;font-weight:600;cursor:pointer;}
.rc-btn:disabled{opacity:.5;cursor:not-allowed;}
.rc-btn.primary{background:#ff7a2e;color:#fff;}
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
          <div class="rc-title">RainCheck</div>
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
          <div class="rc-muted">Everything stays on your device. Per-tab tool.</div>
        </div>
      </div>
      <div class="rc-cloud" title="RainCheck">
        <img src="${chrome.runtime.getURL('src/assets/cloud.png')}" alt="RainCheck" />
      </div>
    `;
    shadow.appendChild(wrap);

    const cloud = wrap.querySelector('.rc-cloud');
    const panel = wrap.querySelector('.rc-panel');
    const generateBtn = wrap.querySelector('.rc-generate');
    const statusEl = wrap.querySelector('.rc-status');
    const outEl = wrap.querySelector('.rc-out');
    const copyAll = wrap.querySelector('.rc-copy-all');
    const copyJson = wrap.querySelector('.rc-copy-json');
    const copySummary = wrap.querySelector('.rc-copy-summary');
    const closeBtn = wrap.querySelector('.rc-close');

    let last = { output: '', json: '', summary: '' };

    // Position the panel anchored to the cloud's current location.
    function positionPanel() {
      const cr = cloud.getBoundingClientRect();
      const ph = panel.offsetHeight;
      const pw = panel.offsetWidth;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 10;

      // Vertical: prefer opening above if there's room, else below.
      let top;
      if (cr.top >= ph + gap) {
        top = cr.top - ph - gap;
      } else if (vh - cr.bottom >= ph + gap) {
        top = cr.bottom + gap;
      } else {
        top = 8;
      }

      // Horizontal: center on the cloud, clamped to the viewport.
      let left = cr.left + cr.width / 2 - pw / 2;
      left = Math.max(8, Math.min(left, vw - pw - 8));

      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    // Draggable cloud
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
        // Re-anchor an open panel to the cloud's new location.
        if (panel.classList.contains('open')) positionPanel();
      }
    });
    cloud.addEventListener('click', () => {
      if (moved) return;
      const open = panel.classList.toggle('open');
      if (open) positionPanel();
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

    generateBtn.addEventListener('click', () => {
      const convId = convIdFromUrl();
      if (!convId) {
        setStatus('Open a Claude conversation first (this page has no chat open).', 'error');
        return;
      }
      const orgId = currentOrgId || getOrgIdFromCookie();
      if (!orgId) {
        setStatus('Could not find your Claude organization id.', 'error');
        return;
      }
      generateBtn.disabled = true;
      setStatus('Loading conversation from Claude…');
      fetch(
        API_ROOT +
          '/organizations/' +
          encodeURIComponent(orgId) +
          '/chat_conversations/' +
          encodeURIComponent(convId) +
          '?tree=true&rendering_mode=messages&render_all_tools=true',
        { credentials: 'include', headers: { 'content-type': 'application/json' } }
      )
        .then((res) => {
          if (!res.ok) throw new Error('conversation API error ' + res.status);
          return res.json();
        })
        .then((data) => {
          const output = buildOutput(data);
          const chatMessages = (data && data.chat_messages) || [];
          const summary = (data && data.summary) || '';
          last = { output, json: JSON.stringify(chatMessages, null, 2), summary };
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

  /* ==================================================================
   * Bootstrap
   * ================================================================== */
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initAll);
    } else {
      initAll();
    }
  }

  /* Node exports for testing the pure logic. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildOutput,
      msgText,
      entireInteractionText,
      lastMessageText,
      parseUsageFromEndpoint,
      parseUsageFromMessageLimit,
      formatResetCountdown,
    };
  }
})();
