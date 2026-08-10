/**
 * bridge.js — runs in the ISOLATED world.
 *
 * Receives raw stream bytes + status events from the MAIN-world network hook
 * (network-hook.js) via postMessage, assembles them into per-conversation
 * sessions, parses SSE, extracts artifacts, detects rate limits, builds the
 * structured report, persists to chrome.storage.local, and drives the panel.
 */
(function () {
  'use strict';
  const RC = globalThis.RC;
  const NS = 'RAINCHECK_MAIN';
  const STORE_PREFIX = 'rc.session.';
  const MAX_SESSIONS = 50;

  /* ---------------------------------------------------------- *
   * Session model
   * ---------------------------------------------------------- */
  class Session {
    constructor(convId) {
      this.convId = convId;
      this.startedAt = Date.now();
      this.updatedAt = Date.now();
      this.userMessages = [];
      this.assistantMessages = [];
      this.artifacts = [];
      this.rateLimit = null;
      this.partial = false;
      this.interrupted = false;
      this.hasActivity = false;
      this.sawMessageStop = false;
      this.title = '';
      // streaming state
      this.buffer = '';
      this.assistantBuffer = '';
      this.accum = new RC.ArtifactAccumulator();
      this.status = null;
      this.headers = {};
    }

    feedRaw(text) {
      this.buffer += text;
      this.hasActivity = true;
      const { frames, remainder } = RC.splitFrames(this.buffer);
      this.buffer = remainder;
      for (const frame of frames) this.handleFrame(frame);
    }

    handleFrame(frame) {
      const parsed = RC.parseFrame(frame);
      const ev = RC.normalizeClaudeEvent(parsed);

      // Rate-limit detection on every frame.
      const rl = RC.detectRateLimit({
        status: this.status,
        headers: this.headers,
        eventData: ev,
        dataRaw: parsed.dataRaw,
      });
      if (rl.isLimited) this.setRateLimit(rl);

      if (!ev) return;
      const type = ev.type;
      if (type === 'content_block_delta') {
        const delta = ev.delta;
        if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
          this.assistantBuffer += delta.text;
          this.accum.feed(delta.text);
          this.touch();
        }
      } else if (type === 'message_start') {
        this.flushAssistant();
        this.assistantBuffer = '';
      } else if (type === 'message_stop' || type === 'completion') {
        this.flushAssistant();
        this.sawMessageStop = true;
        this.touch();
      } else if (type === 'error') {
        this.flushAssistant();
        this.sawMessageStop = true;
      }
    }

    flushAssistant() {
      const t = this.assistantBuffer;
      if (t && t.trim() !== '') this.assistantMessages.push(t);
      this.assistantBuffer = '';
    }

    setRateLimit(rl) {
      this.rateLimit = rl;
      this.interrupted = true;
      this.partial = true;
      this.sawMessageStop = false;
      this.flushAssistant();
      this.touch();
    }

    onStatus(status, headers) {
      this.status = status;
      this.headers = headers || {};
      if (status === 429) {
        this.setRateLimit(
          RC.detectRateLimit({ status, headers: this.headers, eventData: null, dataRaw: '' })
        );
      } else {
        this.touch();
      }
    }

    onStreamError(msg) {
      this.interrupted = true;
      if (!this.rateLimit) {
        const rl = RC.detectRateLimit({
          status: this.status,
          headers: this.headers,
          eventData: null,
          dataRaw: msg || '',
        });
        if (rl.isLimited) this.setRateLimit(rl);
      }
      this.finalize();
    }

    onStreamEnd() {
      this.finalize();
    }

    finalize() {
      this.flushAssistant();
      if (this.hasActivity && !this.sawMessageStop) {
        this.partial = true;
      }
      // Sync extracted artifacts back into the session record.
      this.artifacts = this.accum.getArtifacts();
      this.touch();
    }

    touch() {
      this.updatedAt = Date.now();
      // Keep artifacts in sync even mid-stream.
      this.artifacts = this.accum.getArtifacts();
    }

    toPlain() {
      return {
        convId: this.convId,
        startedAt: this.startedAt,
        updatedAt: this.updatedAt,
        userMessages: this.userMessages,
        assistantMessages: this.assistantMessages,
        artifacts: this.artifacts,
        rateLimit: this.rateLimit,
        partial: this.partial,
        interrupted: this.interrupted,
        hasActivity: this.hasActivity,
        sawMessageStop: this.sawMessageStop,
        title: this.title,
      };
    }

    static fromPlain(o) {
      const s = new Session(o.convId || 'saved');
      s.startedAt = o.startedAt;
      s.updatedAt = o.updatedAt;
      s.userMessages = o.userMessages || [];
      s.assistantMessages = o.assistantMessages || [];
      s.artifacts = o.artifacts || [];
      s.rateLimit = o.rateLimit || null;
      s.partial = !!o.partial;
      s.interrupted = !!o.interrupted;
      s.hasActivity = !!o.hasActivity;
      s.sawMessageStop = !!o.sawMessageStop;
      s.title = o.title || '';
      return s;
    }
  }

  /* ---------------------------------------------------------- *
   * Global state
   * ---------------------------------------------------------- */
  const sessions = {}; // convId -> Session
  let activeConvId = null;
  let panel = null;
  let saveTimer = null;

  function convIdFromUrl() {
    const m = location.pathname.match(/\/(?:chat|c)\/([0-9a-fA-F-]{8,})/);
    return m ? m[1] : null;
  }

  function mostRecentConvId() {
    let best = null;
    for (const id of Object.keys(sessions)) {
      if (!best || sessions[id].updatedAt > sessions[best].updatedAt) best = id;
    }
    return best;
  }

  function getSession(convId) {
    if (!sessions[convId]) sessions[convId] = new Session(convId);
    return sessions[convId];
  }

  /* ---------------------------------------------------------- *
   * Message handling from the MAIN hook
   * ---------------------------------------------------------- */
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.ns !== NS) return;
    switch (data.type) {
      case 'request': {
        const s = getSession(data.convId || 'current');
        if (data.userText && data.userText.trim() !== '') {
          const last = s.userMessages[s.userMessages.length - 1];
          if (last !== data.userText) {
            s.userMessages.push(data.userText);
            s.title = s.title || data.userText.slice(0, 60);
          }
        }
        activeConvId = s.convId;
        s.touch();
        break;
      }
      case 'raw': {
        const s = getSession(data.convId || 'current');
        activeConvId = s.convId;
        s.feedRaw(data.text || '');
        break;
      }
      case 'status': {
        const s = getSession(data.convId || 'current');
        activeConvId = s.convId;
        s.onStatus(data.status, data.headers);
        break;
      }
      case 'stream-error': {
        const s = getSession(data.convId || 'current');
        activeConvId = s.convId;
        s.onStreamError(data.message);
        break;
      }
      case 'stream-end': {
        const s = getSession(data.convId || 'current');
        activeConvId = s.convId;
        s.onStreamEnd();
        break;
      }
      default:
        return;
    }
    refreshUI();
  });

  /* ---------------------------------------------------------- *
   * UI / state aggregation
   * ---------------------------------------------------------- */
  function buildState(s) {
    if (!s) {
      return { hasActivity: false, artifacts: [], userMessages: [], assistantMessages: [] };
    }
    const summary = RC.buildStructuredSummary({
      userMessages: s.userMessages,
      assistantMessages: s.assistantMessages,
      artifacts: s.artifacts,
      rateLimited: !!s.rateLimit,
      rateLimitMessage: s.rateLimit ? s.rateLimit.message : '',
      partial: !!s.partial,
    });
    return {
      convId: s.convId,
      hasActivity: s.hasActivity,
      rateLimited: !!s.rateLimit,
      rateLimitMessage: s.rateLimit ? s.rateLimit.message : '',
      retryAfterSeconds: s.rateLimit ? s.rateLimit.retryAfterSeconds : null,
      interrupted: s.interrupted,
      partial: s.partial,
      artifacts: s.artifacts,
      userMessages: s.userMessages,
      assistantMessages: s.assistantMessages,
      summaryText: summary.summaryText,
      continuationPrompt: summary.continuationPrompt,
    };
  }

  function refreshUI() {
    ensurePanel();
    panel.update(buildState(sessions[activeConvId] || null));
    const s = sessions[activeConvId];
    // Auto-open the panel the moment a rate limit / interruption is detected.
    if (s && (s.rateLimit || s.interrupted)) panel.show();
    scheduleSave();
  }

  function ensurePanel() {
    if (panel) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensurePanel);
      return;
    }
    panel = new RC.Panel();
    panel.onDownloadArtifact = downloadArtifact;
    panel.onDownloadAll = downloadAll;
    panel.onDownloadTranscript = downloadTranscript;
    panel.onCopyContinuation = copyContinuation;
    panel.onScanConversation = scanCurrentConversation;
    panel.onOpenOptions = () => chrome.runtime.sendMessage({ type: 'open-options' });
    panel.update(buildState(sessions[activeConvId] || null));
    if (sessions[activeConvId] && (sessions[activeConvId].rateLimit || sessions[activeConvId].interrupted)) {
      panel.show();
    }
  }

  /* ---------------------------------------------------------- *
   * DOM scanning of an existing conversation
   * ---------------------------------------------------------- */
  function scanCurrentConversation() {
    const button = panel && panel.els && panel.els.scan;
    const setStatus = (t) => panel && panel.setScanStatus && panel.setScanStatus(t);
    if (button) button.disabled = true;
    setStatus('Scanning page…');

    // Let the UI paint the "scanning" state before the synchronous scan.
    setTimeout(() => {
      try {
        if (!RC.DomExtractor) {
          setStatus('⚠ DOM scanner not available. Reload the page and try again.');
          if (button) button.disabled = false;
          return;
        }
        const result = RC.DomExtractor.scan();

        if (!result.found) {
          setStatus('⚠ Could not find any conversation content. Make sure a chat is open and fully loaded, then try again.');
          if (button) button.disabled = false;
          return;
        }

        const s = getSession(activeConvId || 'current');
        // Merge: only replace if we found more than what we already had.
        if (result.userMessages.length) s.userMessages = result.userMessages;
        if (result.assistantMessages.length) s.assistantMessages = result.assistantMessages;
        if (result.artifacts.length) s.artifacts = result.artifacts;
        if (!s.title && result.title) s.title = result.title;
        s.hasActivity = true;
        s.touch();

        refreshUI();
        panel.show();
        setStatus(
          '✓ Recovered ' + result.userMessages.length + ' user msg, ' +
          result.assistantMessages.length + ' assistant msg, ' +
          result.artifacts.length + ' file(s) from the page.'
        );
        console.log('[RainCheck] DOM scan complete:', {
          user: result.userMessages.length,
          assistant: result.assistantMessages.length,
          artifacts: result.artifacts.length,
        });
      } catch (e) {
        console.error('[RainCheck] DOM scan failed:', e);
        setStatus('⚠ Scan failed: ' + ((e && e.message) || e));
      } finally {
        if (button) button.disabled = false;
      }
    }, 30);
  }

  /* ---------------------------------------------------------- *
   * Downloads
   * ---------------------------------------------------------- */
  function activeSession() {
    return sessions[activeConvId] || null;
  }

  function mimeFor(artifact) {
    const t = (artifact.type || '').toLowerCase();
    const map = {
      'text/markdown': 'text/markdown',
      'application/json': 'application/json',
      'text/csv': 'text/csv',
      'application/xml': 'application/xml',
      'application/x-latex': 'application/x-latex',
      'application/vnd.ant.code': 'text/plain',
      'application/vnd.ant.html': 'text/html',
      'application/vnd.ant.svg': 'image/svg+xml',
      'application/vnd.ant.tldraw': 'application/json',
    };
    return map[t] || 'text/plain;charset=utf-8';
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      { url, filename: 'RainCheck/' + filename, conflictAction: 'uniquify', saveAs: false },
      () => URL.revokeObjectURL(url)
    );
  }

  function downloadArtifact(a) {
    const ext = RC.typeToExtension(a);
    const filename = RC.safeFilename(a.title || a.identifier || 'artifact', ext);
    const blob = new Blob([a.content], { type: mimeFor(a) + ';charset=utf-8' });
    triggerDownload(blob, filename);
  }

  function downloadAll() {
    const s = activeSession();
    if (!s || !s.artifacts.length) return;
    const files = s.artifacts.map((a) => ({
      name: RC.safeFilename(a.title || a.identifier || 'artifact', RC.typeToExtension(a)),
      data: a.content,
    }));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([RC.makeZip(files)], { type: 'application/zip' });
    triggerDownload(blob, 'artifacts-' + stamp + '.zip');
  }

  function downloadTranscript() {
    const s = activeSession();
    if (!s) return;
    const text = RC.buildTranscript(s.toPlain());
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    triggerDownload(blob, 'transcript-' + (s.convId || 'session').slice(0, 12) + '.md');
  }

  function copyContinuation() {
    const s = activeSession();
    if (!s) return;
    const summary = RC.buildStructuredSummary({
      userMessages: s.userMessages,
      assistantMessages: s.assistantMessages,
      artifacts: s.artifacts,
      rateLimited: !!s.rateLimit,
      partial: !!s.partial,
    });
    const text = summary.continuationPrompt;
    const done = () => {
      if (panel) {
        panel.els.copyCont.textContent = 'Copied!';
        setTimeout(() => (panel.els.copyCont.textContent = 'Copy continuation prompt'), 1500);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
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

  /* ---------------------------------------------------------- *
   * Persistence
   * ---------------------------------------------------------- */
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(save, 400);
  }

  function save() {
    saveTimer = null;
    const entries = {};
    const list = Object.keys(sessions)
      .map((id) => sessions[id])
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
    for (const s of list) entries[STORE_PREFIX + s.convId] = s.toPlain();
    entries['rc.active'] = activeConvId;
    try {
      chrome.storage.local.set(entries);
    } catch (_) {}
    // Clean up evicted sessions from storage.
    chrome.storage.local.get(null, (all) => {
      const keys = Object.keys(all || {});
      const keep = new Set([...Object.keys(entries), 'rc.active']);
      const toRemove = keys.filter((k) => k.startsWith(STORE_PREFIX) && !keep.has(k));
      if (toRemove.length) chrome.storage.local.remove(toRemove);
    });
  }

  /* ---------------------------------------------------------- *
   * SPA navigation detection
   * ---------------------------------------------------------- */
  function handleUrlChange() {
    const id = convIdFromUrl();
    if (id && id !== activeConvId && sessions[id]) {
      activeConvId = id;
      refreshUI();
    }
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

  /* ---------------------------------------------------------- *
   * Init: restore sessions, then create panel.
   * ---------------------------------------------------------- */
  function init() {
    // Always create the FAB/panel immediately, independent of storage.
    ensurePanel();
    console.log('[RainCheck] bridge loaded on', location.hostname);
    try {
      chrome.storage.local.get(null, (data) => {
        data = data || {};
        for (const k of Object.keys(data)) {
          if (k.startsWith(STORE_PREFIX)) {
            try {
              const s = Session.fromPlain(data[k]);
              sessions[s.convId] = s;
            } catch (_) {}
          }
        }
        activeConvId = data['rc.active'] || convIdFromUrl() || mostRecentConvId();
        if (!sessions[activeConvId]) activeConvId = mostRecentConvId();
        refreshUI();
      });
    } catch (e) {
      console.warn('[RainCheck] storage unavailable:', e);
    }
  }

  init();
})();
