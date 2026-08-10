/**
 * network-hook.js — runs in the PAGE's MAIN world at document_start.
 *
 * It monkey-patches window.fetch and XMLHttpRequest BEFORE claude.ai's app
 * bundles load, so it can tee every chat-completion stream and forward the
 * raw bytes + HTTP status to the ISOLATED-world bridge via postMessage.
 *
 * Claude's app consumes the original stream untouched; we only read a clone.
 *
 * This file has NO access to chrome.* APIs — it only posts raw messages.
 */
(function () {
  'use strict';
  if (window.__RAINCHECK_HOOK__) return;
  window.__RAINCHECK_HOOK__ = true;

  const NS = 'RAINCHECK_MAIN';

  function post(msg) {
    try {
      window.postMessage(Object.assign({ ns: NS }, msg), window.location.origin);
    } catch (_) {}
  }

  post({ type: 'hook-ready', ts: Date.now() });
  try { console.log('[RainCheck] network hook injected in MAIN world'); } catch (_) {}

  /* ---------------------------------------------------------- *
   * URL / body helpers
   * ---------------------------------------------------------- */

  function isRelevant(url) {
    if (!url) return false;
    try {
      url = String(url);
    } catch (_) {
      return false;
    }
    if (url.indexOf('/api/') === -1) return false;
    return /\/completion(\/|$|\?)|\/append-messages|\/append_message|\/chat_conversations\/|\/chat\//.test(url);
  }

  function extractConvId(url) {
    let m;
    m = url.match(/\/(?:chat_conversations|chat|c|sessions)\/([0-9a-fA-F-]{8,})/);
    if (m) return m[1];
    m = url.match(/[?&]conversation_id=([0-9a-fA-F-]{8,})/);
    if (m) return m[1];
    return 'current';
  }

  // Best-effort extraction of the user's message text from the request body.
  function parseBodyForUserText(body) {
    if (!body) return '';
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      return '';
    }
    if (parsed && Array.isArray(parsed.messages)) {
      const last = parsed.messages[parsed.messages.length - 1];
      if (last && last.role === 'user') {
        const c = last.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
          return c
            .filter((x) => x && (x.type === 'text' || typeof x.text === 'string'))
            .map((x) => x.text || '')
            .join('\n');
        }
      }
    }
    if (parsed && typeof parsed.prompt === 'string') return parsed.prompt;
    if (parsed && typeof parsed.content === 'string') return parsed.content;
    if (parsed && parsed.message && typeof parsed.message.content === 'string') {
      return parsed.message.content;
    }
    return '';
  }

  function getBodyString(input, init) {
    if (init && typeof init.body === 'string') return init.body;
    if (init && typeof init.body === 'object' && init.body != null) {
      try {
        return JSON.stringify(init.body);
      } catch (_) {}
    }
    return null;
  }

  /* ---------------------------------------------------------- *
   * fetch patching
   * ---------------------------------------------------------- */

  const origFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    let url = '';
    if (typeof input === 'string') url = input;
    else if (input && input.url) url = input.url;

    const relevant = isRelevant(url);
    let bodyString = null;
    if (relevant) bodyString = getBodyString(input, init);

    const promise = origFetch(input, init);

    if (relevant) {
      const convId = extractConvId(url);
      const userText = parseBodyForUserText(bodyString);
      post({ type: 'request', convId, url, userText, ts: Date.now() });

      promise.then(
        function (resp) {
          const status = resp.status;
          const headers = {};
          try {
            resp.headers.forEach((v, k) => (headers[String(k).toLowerCase()] = v));
          } catch (_) {}

          if (status === 429) {
            post({ type: 'status', convId, status, headers });
            post({ type: 'stream-error', convId, status, headers, message: 'HTTP 429 rate limit' });
            return;
          }

          // Only tee bodies we actually stream (SSE / JSON / plain text).
          const ct = (resp.headers.get('content-type') || '').toLowerCase();
          if (
            ct.indexOf('text/event-stream') === -1 &&
            ct.indexOf('application/json') === -1 &&
            ct.indexOf('text/plain') === -1
          ) {
            post({ type: 'status', convId, status, headers });
            return;
          }

          post({ type: 'status', convId, status, headers });

          let clone;
          try {
            clone = resp.clone();
          } catch (_) {
            post({ type: 'stream-end', convId, status });
            return;
          }
          const reader = clone.body.getReader();
          const decoder = new TextDecoder();
          pump(reader, decoder, convId, status);
        },
        function (err) {
          post({
            type: 'stream-error',
            convId,
            status: 0,
            headers: null,
            message: String((err && err.message) || err || 'fetch failed'),
          });
        }
      );
    }

    return promise;
  };

  async function pump(reader, decoder, convId, status) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const s = decoder.decode(value, { stream: true });
        if (s) post({ type: 'raw', convId, text: s });
      }
      post({ type: 'stream-end', convId, status });
    } catch (err) {
      post({
        type: 'stream-error',
        convId,
        status: status || 0,
        headers: null,
        message: String((err && err.message) || err || 'stream interrupted'),
      });
    }
  }

  /* ---------------------------------------------------------- *
   * XMLHttpRequest patching (fallback path)
   * ---------------------------------------------------------- */

  const ORIG_OPEN = XMLHttpRequest.prototype.open;
  const ORIG_SEND = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__rcUrl = url;
    this.__rcRelevant = isRelevant(url);
    return ORIG_OPEN.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__rcRelevant) {
      const convId = extractConvId(String(this.__rcUrl || ''));
      const userText = parseBodyForUserText(typeof body === 'string' ? body : null);
      if (userText) post({ type: 'request', convId, userText, ts: Date.now() });

      let lastPos = 0;
      const processResponse = function () {
        try {
          const t = this.responseText || '';
          if (t.length > lastPos) {
            post({ type: 'raw', convId, text: t.slice(lastPos) });
            lastPos = t.length;
          }
        } catch (_) {}
      };
      const processStatus = function () {
        const headers = {};
        try {
          this.getAllResponseHeaders()
            .split(/\r?\n/)
            .forEach((line) => {
              const i = line.indexOf(':');
              if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            });
        } catch (_) {}
        post({ type: 'status', convId, status: this.status, headers });
        if (this.status === 429) {
          post({ type: 'stream-error', convId, status: this.status, headers, message: 'HTTP 429 rate limit' });
        }
      };

      this.addEventListener('readystatechange', function () {
        if (this.readyState >= 3) processResponse.call(this);
        if (this.readyState === 4) {
          processResponse.call(this);
          processStatus.call(this);
          post({ type: 'stream-end', convId, status: this.status });
        }
      });
      this.addEventListener('error', function () {
        post({ type: 'stream-error', convId, status: this.status, headers: null, message: 'XHR error' });
      });
    }
    return ORIG_SEND.apply(this, arguments);
  };

  post({ type: 'hook-installed', ts: Date.now() });
})();
