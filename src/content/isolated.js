/*
 * isolated.js — GENERATED file. Do not edit directly.
 * Regenerate with `npm run build` after editing parser-core.js / panel.js / bridge.js.
 */

/* ===== SOURCE: shared/parser-core.js ===== */
/**
 * parser-core.js — RainCheck core logic.
 *
 * This file is deliberately environment-agnostic. It is loaded:
 *   - by the extension's content scripts (both MAIN and ISOLATED worlds),
 *   - by Node.js unit tests and the demo runner via `require()`.
 *
 * It exposes everything on `globalThis.RC`. It has no DOM / chrome.* /
 * network dependencies, so it is fully unit-testable offline.
 *
 * Responsibilities:
 *   - Parse Server-Sent-Events (SSE) frames as streamed by claude.ai.
 *   - Normalize both the raw Anthropic API event shapes and the wrapped
 *     `{type:"stream_event", event:{...}}` envelopes claude.ai uses.
 *   - Extract artifacts (and partial/cut-off artifacts) out of the stream.
 *   - Detect rate-limit / interruption conditions.
 *   - Build the no-LLM structured session report + continuation prompt.
 *   - Build a transcript, filename mapping, and a minimal ZIP writer.
 */
(function () {
  'use strict';

  const root =
    typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this;

  const RC = {};

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  function truncate(s, max) {
    s = String(s == null ? '' : s);
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + '…';
  }

  function normalizeNewlines(text) {
    return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  /* ------------------------------------------------------------------ *
   * SSE parsing
   * ------------------------------------------------------------------ */

  /**
   * Split a raw chunk into complete SSE frames. Returns [completeFrames, remainder].
   * A frame is delimited by a blank line. Frames may be split across network
   * reads, so callers must feed chunks incrementally and keep the remainder.
   */
  function splitFrames(chunk) {
    const text = normalizeNewlines(chunk);
    const frames = text.split('\n\n');
    const remainder = frames.pop() || '';
    return { frames: frames.filter((f) => f.trim() !== ''), remainder };
  }

  /**
   * Parse a single SSE frame string into {event, data, dataRaw}.
   * Handles `event:` and `data:` lines; data is JSON-parsed when possible.
   */
  function parseFrame(frame) {
    let event = 'message';
    const dataLines = [];
    for (const line of normalizeNewlines(frame).split('\n')) {
      if (line.charCodeAt(0) === 58 /* ':' */) continue; // comment
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return { event, data: null, dataRaw: '' };
    const dataRaw = dataLines.join('\n');
    let data = null;
    try {
      data = JSON.parse(dataRaw);
    } catch (_) {
      data = null;
    }
    return { event, data, dataRaw };
  }

  /**
   * claude.ai wraps API events in envelopes. This unwraps the inner event so
   * downstream code can treat everything uniformly. Returns the inner event
   * object when it is a recognized event type, otherwise the top-level data.
   */
  function normalizeClaudeEvent(parsed) {
    if (!parsed || !parsed.data) return parsed;
    const d = parsed.data;
    // claude.ai's newer streaming wrapper
    if (d && d.type === 'stream_event' && d.event) return d.event;
    if (d && d.type === 'error') return d;
    // Raw Anthropic API events carry one of these "type" values.
    if (
      d &&
      typeof d.type === 'string' &&
      /^(message_start|content_block_start|content_block_delta|content_block_stop|message_delta|message_stop|ping|completion|error)$/.test(
        d.type
      )
    ) {
      return d;
    }
    return d;
  }

  /* ------------------------------------------------------------------ *
   * Artifact extraction
   * ------------------------------------------------------------------ */

  const OPEN_TAG_RE = /<antArtifact([^>]*)>/gi;
  const CLOSE_TAG_RE = /<\/antArtifact>/gi;

  function parseAttrs(s) {
    const out = {};
    const re = /([a-zA-Z0-9_\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let m;
    while ((m = re.exec(s))) {
      out[m[1]] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    }
    return out;
  }

  /**
   * Streaming artifact accumulator. Feed raw text deltas; it maintains the
   * current list of artifacts, including artifacts whose closing tag has not
   * arrived yet (i.e. those cut off by a rate limit).
   */
  class ArtifactAccumulator {
    constructor() {
      this.buffer = '';
      this.artifacts = [];
    }

    feed(text) {
      this.buffer += String(text == null ? '' : text);
      this._rescan();
    }

    reset() {
      this.buffer = '';
      this.artifacts = [];
    }

    _rescan() {
      const b = this.buffer;
      const artifacts = [];
      OPEN_TAG_RE.lastIndex = 0;
      let m;
      let lastPos = 0;
      while ((m = OPEN_TAG_RE.exec(b))) {
        // Avoid matching an opening tag inside an already-closed artifact's
        // content by skipping the scan window past the previous close tag.
        if (m.index < lastPos) {
          OPEN_TAG_RE.lastIndex = lastPos;
          continue;
        }
        const attrs = parseAttrs(m[1] || '');
        const contentStart = OPEN_TAG_RE.lastIndex;
        CLOSE_TAG_RE.lastIndex = contentStart;
        const cm = CLOSE_TAG_RE.exec(b);
        if (cm) {
          artifacts.push({
            identifier: attrs.identifier || '',
            type: attrs.type || '',
            title: attrs.title || '',
            language: attrs.language || '',
            content: b.slice(contentStart, cm.index),
            closed: true,
            open: false,
          });
          lastPos = CLOSE_TAG_RE.lastIndex;
          OPEN_TAG_RE.lastIndex = lastPos;
        } else {
          // Opening tag seen but no closing tag -> partial artifact.
          artifacts.push({
            identifier: attrs.identifier || '',
            type: attrs.type || '',
            title: attrs.title || '',
            language: attrs.language || '',
            content: b.slice(contentStart),
            closed: false,
            open: true,
          });
          break; // nothing meaningful can follow an unclosed artifact
        }
        if (artifacts.length > 500) break; // safety valve
      }
      this.artifacts = artifacts;
    }

    getArtifacts() {
      return this.artifacts;
    }

    hasOpen() {
      return this.artifacts.some((a) => a.open);
    }
  }

  /* ------------------------------------------------------------------ *
   * Type / filename mapping
   * ------------------------------------------------------------------ */

  const LANGUAGE_TO_EXT = {
    js: 'js', javascript: 'js', jsx: 'jsx', ts: 'ts', typescript: 'ts', tsx: 'tsx',
    python: 'py', py: 'py', html: 'html', htm: 'html', css: 'css', json: 'json',
    java: 'java', cpp: 'cpp', cxx: 'cpp', c: 'c', h: 'h', cs: 'cs', csharp: 'cs',
    go: 'go', golang: 'go', rust: 'rs', swift: 'swift', kotlin: 'kt', kts: 'kt',
    ruby: 'rb', php: 'php', sql: 'sql', bash: 'sh', shell: 'sh', sh: 'sh',
    zsh: 'sh', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', svg: 'svg',
    markdown: 'md', md: 'md', latex: 'tex', tex: 'tex', graphviz: 'dot', dot: 'dot',
    mermaid: 'mmd', svelte: 'svelte', http: 'http', dockerfile: 'Dockerfile',
    txt: 'txt', text: 'txt', csv: 'csv', pdf: 'pdf',
  };

  const TYPE_TO_EXT = {
    'text/markdown': 'md',
    'application/json': 'json',
    'text/csv': 'csv',
    'application/xml': 'xml',
    'application/x-latex': 'tex',
    'application/vnd.ant.react': 'jsx',
    'application/vnd.ant.svelte': 'svelte',
    'application/vnd.ant.mermaid': 'mmd',
    'application/vnd.ant.graphviz': 'dot',
    'application/vnd.ant.html': 'html',
    'application/vnd.ant.tldraw': 'tldr.json',
    'application/vnd.ant.code': 'txt',
    'application/vnd.ant.text': 'txt',
    'application/vnd.ant.figma': 'fig.json',
    'application/vnd.ant.svg': 'svg',
    'application/vnd.ant.pdf': 'pdf',
    'application/pdf': 'pdf',
    'text/html': 'html',
    'text/plain': 'txt',
    'text/x-python': 'py',
  };

  function typeToExtension(artifact) {
    const t = (artifact.type || '').toLowerCase();
    // Code artifacts: derive the extension from the language attribute.
    if (t === 'application/vnd.ant.code') {
      return (artifact.language && LANGUAGE_TO_EXT[String(artifact.language).toLowerCase()]) || 'txt';
    }
    if (TYPE_TO_EXT[t]) return TYPE_TO_EXT[t];
    return 'txt';
  }

  function typeToDisplayName(artifact) {
    const t = (artifact.type || '').toLowerCase();
    const map = {
      'text/markdown': 'Markdown document',
      'application/json': 'JSON',
      'text/csv': 'CSV table',
      'application/xml': 'XML',
      'application/x-latex': 'LaTeX',
      'application/vnd.ant.react': 'React component',
      'application/vnd.ant.svelte': 'Svelte component',
      'application/vnd.ant.mermaid': 'Mermaid diagram',
      'application/vnd.ant.graphviz': 'Graphviz / DOT diagram',
      'application/vnd.ant.html': 'HTML page',
      'application/vnd.ant.tldraw': 'Whiteboard',
      'application/vnd.ant.code': artifact.language
        ? 'Code (' + artifact.language + ')'
        : 'Code snippet',
      'application/vnd.ant.figma': 'Figma file',
      'application/vnd.ant.svg': 'SVG image',
      'application/pdf': 'PDF',
      'application/vnd.ant.pdf': 'PDF',
      'text/html': 'HTML page',
    };
    return map[t] || 'Document';
  }

  function safeFilename(name, ext) {
    const base = String(name || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 80);
    const slug = base || 'artifact';
    if (ext && slug.toLowerCase().endsWith('.' + ext.toLowerCase())) return slug;
    return ext ? slug + '.' + ext : slug;
  }

  /* ------------------------------------------------------------------ *
   * Rate-limit / interruption detection
   * ------------------------------------------------------------------ */

  const RATE_LIMIT_PATTERNS = [
    /rate\s?limit/i,
    /rate_limit/i,
    /too\s?many\s?requests/i,
    /exhausted.*rate/i,
    /reached your.*limit/i,
    /\b429\b/,
  ];

  /**
   * info: { status, headers, eventData, dataRaw }
   * headers is an object of lowercase header -> value.
   */
  function detectRateLimit(info) {
    info = info || {};
    const out = { isLimited: false, retryAfterSeconds: null, message: '', kind: '' };
    const headers = info.headers || {};

    if (info.status === 429) {
      out.isLimited = true;
      out.kind = 'http429';
      out.retryAfterSeconds = toNumber(headers['retry-after']);
      out.message = extractErrorMessage(info.eventData) || 'HTTP 429 — rate limit reached.';
      return out;
    }

    const d = info.eventData;
    if (d && d.type === 'error') {
      const msg = extractErrorMessage(d);
      const hay = (msg + ' ' + (info.dataRaw || '')).toLowerCase();
      if (RATE_LIMIT_PATTERNS.some((re) => re.test(hay))) {
        out.isLimited = true;
        out.kind = 'streamed-error';
        out.retryAfterSeconds = toNumber(headers['retry-after']);
        out.message = msg || 'Rate limit reached (streamed error).';
        return out;
      }
    }

    if (info.dataRaw) {
      const low = info.dataRaw.toLowerCase();
      if (low.indexOf('error') !== -1 && RATE_LIMIT_PATTERNS.some((re) => re.test(low))) {
        out.isLimited = true;
        out.kind = 'streamed-keyword';
        out.retryAfterSeconds = toNumber(headers['retry-after']);
        out.message = 'Rate limit detected in stream.';
        return out;
      }
    }

    return out;
  }

  function extractErrorMessage(d) {
    if (!d) return '';
    if (d.error && typeof d.error.message === 'string') return d.error.message;
    if (d.error && typeof d.error.type === 'string') return d.error.type;
    if (typeof d.message === 'string') return d.message;
    return '';
  }

  function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function formatRetry(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return 'unknown time';
    const s = Math.round(seconds);
    if (s < 60) return s + ' second(s)';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' minute(s)';
    const h = Math.round((s / 3600) * 10) / 10;
    return h + ' hour(s)';
  }

  /* ------------------------------------------------------------------ *
   * Structured (no-LLM) report + continuation prompt
   * ------------------------------------------------------------------ */

  function buildStructuredSummary(input) {
    input = input || {};
    const userMessages = input.userMessages || [];
    const assistantMessages = input.assistantMessages || [];
    const artifacts = input.artifacts || [];
    const rateLimited = !!input.rateLimited;
    const rateLimitMessage = input.rateLimitMessage || '';
    const partial = !!input.partial;

    const task = userMessages.length ? truncate(userMessages[0], 500) : '(no task captured)';
    const done = artifacts.filter((a) => a.closed);
    const open = artifacts.filter((a) => a.open);
    const inProgress = open[open.length - 1] || null;

    const lines = [];
    lines.push('# Session Interruption Report');
    lines.push('');
    lines.push('_Generated locally by RainCheck. No data leaves your browser._');
    lines.push('');
    lines.push('**Generated at:** ' + new Date().toLocaleString());
    lines.push('');
    if (rateLimited) {
      lines.push('> ⚠️ This session was interrupted by a **rate limit**.');
      if (rateLimitMessage) lines.push('> ' + rateLimitMessage);
      lines.push('');
    } else if (partial) {
      lines.push('> ⚠️ This session ended before the last response completed.');
      lines.push('');
    }
    lines.push('## The task');
    lines.push('');
    lines.push(task);
    lines.push('');
    lines.push('## What was completed');
    lines.push('');
    if (done.length) {
      lines.push('- **' + done.length + ' artifact(s)** generated and recovered:');
      done.forEach((a) => {
        lines.push('  - ' + (a.title || a.identifier || 'Untitled') + ' (' + typeToDisplayName(a) + ')');
      });
    } else {
      lines.push('- No fully-completed artifacts yet.');
    }
    lines.push('- **' + assistantMessages.length + '** assistant response segment(s) captured.');
    lines.push('- **' + userMessages.length + '** user message(s) captured.');
    lines.push('');
    lines.push('## What was in progress (cut off)');
    lines.push('');
    if (inProgress) {
      lines.push(
        '- **' + (inProgress.title || 'Untitled') + '** (' + typeToDisplayName(inProgress) + ') was being generated and is **incomplete**:'
      );
      lines.push('');
      lines.push('```');
      lines.push(truncate(inProgress.content, 800));
      lines.push('```');
      lines.push('');
    } else if (partial) {
      lines.push('- The final response was cut off mid-stream; no open artifact tag was detected.');
      lines.push('');
    } else {
      lines.push('- Nothing appears to be incomplete.');
      lines.push('');
    }
    lines.push('## Remaining work');
    lines.push('');
    lines.push('- Review the recovered artifacts below and re-paste any truncated ones into a new session to finish them.');
    lines.push('- Use the "Continuation prompt" to hand off to a fresh account/session.');

    const summaryText = lines.join('\n');

    // ---- Continuation prompt ------------------------------------------
    const lastTask =
      userMessages.length ? userMessages[userMessages.length - 1] : '';
    const cont = [];
    cont.push('You are continuing a session that was interrupted by a rate limit. Do NOT restart from scratch — continue exactly where it stopped.');
    cont.push('');
    cont.push('## Original task');
    cont.push('');
    cont.push(task);
    if (lastTask && lastTask !== task) {
      cont.push('');
      cont.push('## Last message before interruption');
      cont.push('');
      cont.push(lastTask);
    }
    if (inProgress) {
      cont.push('');
      cont.push('## In-progress item to finish');
      cont.push('');
      cont.push('Title: ' + (inProgress.title || 'Untitled'));
      cont.push('Type: ' + typeToDisplayName(inProgress));
      cont.push('');
      cont.push('Here is the partial content captured so far:');
      cont.push('```');
      cont.push(inProgress.content);
      cont.push('```');
    }
    cont.push('');
    cont.push('Continue from the exact point where it stopped. Ask me for the recovered transcript if you need more context.');

    return {
      task,
      summaryText,
      continuationPrompt: cont.join('\n'),
      doneCount: done.length,
      openCount: open.length,
      totalArtifacts: artifacts.length,
      inProgress,
    };
  }

  /* ------------------------------------------------------------------ *
   * Transcript builder
   * ------------------------------------------------------------------ */

  function buildTranscript(session) {
    session = session || {};
    const lines = [];
    lines.push('# Claude Conversation Transcript');
    lines.push('');
    lines.push('Conversation: ' + (session.convId || '—'));
    if (session.title) lines.push('Title: ' + session.title);
    lines.push('Started: ' + (session.startedAt ? new Date(session.startedAt).toLocaleString() : '—'));
    lines.push('_Exported by RainCheck._');
    lines.push('');

    (session.userMessages || []).forEach((u) => {
      lines.push('## 👤 User');
      lines.push('');
      lines.push(u);
      lines.push('');
    });
    (session.assistantMessages || []).forEach((a) => {
      lines.push('## 🤖 Assistant');
      lines.push('');
      lines.push(a);
      lines.push('');
    });
    (session.artifacts || []).forEach((a) => {
      lines.push('');
      lines.push('## 📄 Artifact: ' + (a.title || a.identifier || 'Untitled'));
      lines.push('');
      lines.push('```');
      lines.push(a.content);
      lines.push('```');
      lines.push('');
    });
    if (!session.userMessages || !session.assistantMessages) {
      lines.push('_(No messages captured yet — this transcript may be empty.)_');
    }
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * Minimal ZIP writer (stored / no compression) — no external libs.
   * ------------------------------------------------------------------ */

  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }
  function crc32(bytes) {
    const t = crcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * files: [{ name, data }] (data is a string; encoded as UTF-8).
   * Returns a Uint8Array of a valid (stored) ZIP.
   */
  function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const dataBytes = enc.encode(String(f.data == null ? '' : f.data));
      const crc = crc32(dataBytes);
      const size = dataBytes.length;

      // Local file header (30 bytes) + name + data
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true); // version needed to extract
      lh.setUint16(6, 0, true); // general purpose flags
      lh.setUint16(8, 0, true); // compression method: stored
      lh.setUint16(10, 0, true); // mod time
      lh.setUint16(12, 0x21, true); // mod date
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true); // extra len
      parts.push(new Uint8Array(lh.buffer), nameBytes, dataBytes);

      // Central directory header (46 bytes) + name
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true); // version made by
      ch.setUint16(6, 20, true); // version needed
      ch.setUint16(8, 0, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, 0, true);
      ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint16(30, 0, true);
      ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true);
      ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameBytes);

      offset += 30 + nameBytes.length + dataBytes.length;
    }

    const cdSize = central.reduce((s, a) => s + a.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    eocd.setUint16(20, 0, true);

    const all = parts.concat(central).concat([new Uint8Array(eocd.buffer)]);
    const total = all.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of all) {
      out.set(a, p);
      p += a.length;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Exports
   * ------------------------------------------------------------------ */

  RC.truncate = truncate;
  RC.normalizeNewlines = normalizeNewlines;
  RC.splitFrames = splitFrames;
  RC.parseFrame = parseFrame;
  RC.normalizeClaudeEvent = normalizeClaudeEvent;
  RC.ArtifactAccumulator = ArtifactAccumulator;
  RC.typeToExtension = typeToExtension;
  RC.typeToDisplayName = typeToDisplayName;
  RC.safeFilename = safeFilename;
  RC.detectRateLimit = detectRateLimit;
  RC.formatRetry = formatRetry;
  RC.buildStructuredSummary = buildStructuredSummary;
  RC.buildTranscript = buildTranscript;
  RC.makeZip = makeZip;
  RC.crc32 = crc32;

  root.RC = RC;

  // Node / CommonJS export for tests and the demo runner.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RC;
  }
})();

/* ===== SOURCE: content/dom-extractor.js ===== */
/**
 * dom-extractor.js — recover an ALREADY-RENDERED Claude conversation from the
 * DOM. When you open an existing chat, all messages and artifact content are
 * already in the page; this reads them without needing any network interception.
 *
 * The selectors are heuristic and centralized here so they're easy to tune
 * against a live snapshot (see README "Tuning DOM selectors").
 */
(function () {
  'use strict';
  const root = globalThis;
  if (root.RC && root.RC.DomExtractor) return;

  // Centralized selector table — tweak here if a Claude update breaks scanning.
  const SELECTORS = {
    userMessage: [
      '[data-testid="user-message"]',
      '[data-message-author-role="user"]',
      '.user-message',
    ],
    assistantMessage: [
      '[data-testid="assistant-message"]',
      '[data-message-author-role="assistant"]',
      '.assistant-message',
    ],
    // A rendered artifact usually carries a download/copy affordance and a title.
    artifactCard: [
      '[data-testid="artifact-card"]',
      '[data-testid="artifact"]',
      '[data-artifact-id]',
      '.artifact-card',
      '.artifact',
    ],
    artifactTitle: [
      '[data-testid="artifact-card-title"]',
      '[data-testid="artifact-title"]',
      'header h3',
      'header h2',
      '[class*="artifact"] [class*="title"]',
    ],
    // Generic download affordances (links or buttons with a download icon/label).
    downloadAffordance: [
      'a[download]',
      '[aria-label*="download" i]',
      '[title*="download" i]',
      '[class*="download" i]',
    ],
  };

  function qsa(sel, scope) {
    scope = scope || document;
    for (const s of sel) {
      try {
        const found = scope.querySelectorAll(s);
        if (found && found.length) return Array.from(found);
      } catch (_) {}
    }
    return [];
  }

  function qsaUnion(selectors, scope) {
    scope = scope || document;
    const seen = new Set();
    const out = [];
    for (const s of selectors) {
      try {
        scope.querySelectorAll(s).forEach((el) => {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        });
      } catch (_) {}
    }
    return out;
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Element text that preserves <pre>/<code> line structure.
  function textOf(el) {
    if (!el) return '';
    const clones = el.cloneNode(true);
    // Replace <br> with newlines for a cleaner transcript.
    clones.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    // Keep <pre> content on its own lines.
    clones.querySelectorAll('pre').forEach((p) => {
      p.replaceWith('\n```\n' + cleanText(p.textContent) + '\n```\n');
    });
    const t = cleanText(clones.textContent || '');
    return t;
  }

  function inferArtifactTypeFromTitle(title) {
    const t = String(title || '').toLowerCase();
    if (t.endsWith('.md') || t.endsWith('.markdown')) return 'text/markdown';
    if (t.endsWith('.json')) return 'application/json';
    if (t.endsWith('.csv')) return 'text/csv';
    if (t.endsWith('.xml')) return 'application/xml';
    if (t.endsWith('.tex') || t.endsWith('.latex')) return 'application/x-latex';
    if (t.endsWith('.py')) return 'application/vnd.ant.code';
    if (t.endsWith('.js')) return 'application/vnd.ant.code';
    if (t.endsWith('.ts')) return 'application/vnd.ant.code';
    if (t.endsWith('.tsx')) return 'application/vnd.ant.code';
    if (t.endsWith('.jsx')) return 'application/vnd.ant.react';
    if (t.endsWith('.html')) return 'application/vnd.ant.html';
    if (t.endsWith('.svg')) return 'application/vnd.ant.svg';
    return 'text/markdown';
  }

  function languageFromTitle(title) {
    const t = String(title || '').toLowerCase();
    const map = {
      '.py': 'python', '.js': 'javascript', '.ts': 'typescript', '.tsx': 'tsx',
      '.jsx': 'jsx', '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c',
      '.cpp': 'cpp', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php',
      '.sh': 'bash', '.bash': 'bash', '.sql': 'sql', '.css': 'css',
      '.html': 'html', '.json': 'json', '.xml': 'xml', '.yaml': 'yaml',
      '.yml': 'yaml', '.md': 'markdown', '.txt': 'text',
    };
    for (const k of Object.keys(map)) {
      if (t.endsWith(k)) return map[k];
    }
    return '';
  }

  /**
   * Extract artifacts from rendered artifact cards.
   * Returns [{ identifier, type, title, language, content, closed, open, source:'dom' }]
   */
  function extractArtifacts() {
    const out = [];
    const seen = new Set();

    // Strategy 1: artifact cards with an explicit container.
    const cards = qsaUnion(SELECTORS.artifactCard);
    cards.forEach((card) => {
      if (seen.has(card)) return;
      seen.add(card);
      let title = '';
      for (const t of SELECTORS.artifactTitle) {
        const el = card.querySelector(t);
        if (el && el.textContent.trim()) {
          title = cleanText(el.textContent);
          break;
        }
      }
      const content = textOf(card);
      if (!content && !title) return;
      // Skip the page's outer containers (the whole conversation is too big).
      if (content.length > 200000) return;
      const type = inferArtifactTypeFromTitle(title);
      out.push({
        identifier: 'dom-' + (title || out.length),
        type,
        title: title || 'Artifact ' + (out.length + 1),
        language: languageFromTitle(title),
        content,
        closed: true,
        open: false,
        source: 'dom',
      });
    });

    // Strategy 2: standalone code blocks not already inside a captured card.
    const seenParents = new Set(cards);
    document.querySelectorAll('pre > code, pre').forEach((code) => {
      // Find a parent card-like ancestor already captured.
      let p = code;
      let captured = false;
      for (let i = 0; i < 6 && p; i++) {
        p = p.parentElement;
        if (p && seenParents.has(p)) {
          captured = true;
          break;
        }
      }
      if (captured) return;
      const content = cleanText(code.textContent || '');
      if (content.length < 5) return;
      // Title from a nearby heading if present, else first line.
      let title = '';
      let n = code;
      for (let i = 0; i < 4 && n; i++) {
        n = n.parentElement;
        if (n) {
          const h = n.querySelector('h1,h2,h3,[class*="title"]');
          if (h && h.textContent.trim()) {
            title = cleanText(h.textContent);
            break;
          }
        }
      }
      title = title || 'code-snippet-' + (out.length + 1);
      const type = /\.md$/i.test(title) ? 'text/markdown' : 'application/vnd.ant.code';
      out.push({
        identifier: 'dom-code-' + (out.length + 1),
        type,
        title,
        language: languageFromTitle(title),
        content,
        closed: true,
        open: false,
        source: 'dom',
      });
    });

    return out;
  }

  /**
   * Scan the rendered conversation.
   * Returns { userMessages, assistantMessages, artifacts, title, found:boolean }
   */
  function scan() {
    const userEls = qsaUnion(SELECTORS.userMessage);
    const assistantEls = qsaUnion(SELECTORS.assistantMessage);

    // Order by DOM position.
    const all = [];
    userEls.forEach((el) => all.push({ el, role: 'user' }));
    assistantEls.forEach((el) => all.push({ el, role: 'assistant' }));
    // Compare by document order using a WeakMap of compareDocumentPosition results.
    all.sort((a, b) => {
      if (a.el === b.el) return 0;
      const pos = a.el.compareDocumentPosition(b.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const userMessages = [];
    const assistantMessages = [];
    for (const item of all) {
      const text = textOf(item.el);
      if (!text) continue;
      // Skip tiny/empty message shells.
      if (text.length < 1) continue;
      if (item.role === 'user') userMessages.push(text);
      else assistantMessages.push(text);
    }

    // Dedupe consecutive identical assistant messages (artifacts get duplicated
    // into both the message text and the artifact card).
    const dedupedAssistant = [];
    for (const m of assistantMessages) {
      if (dedupedAssistant[dedupedAssistant.length - 1] !== m) dedupedAssistant.push(m);
    }

    const artifacts = extractArtifacts();
    const found = userMessages.length > 0 || assistantMessages.length > 0 || artifacts.length > 0;

    return {
      userMessages,
      assistantMessages: dedupedAssistant,
      artifacts,
      title: document.title || '',
      found,
    };
  }

  root.RC.DomExtractor = { scan, SELECTORS, cleanText };
})();

/* ===== SOURCE: content/api-loader.js ===== */
/**
 * api-loader.js — load a full conversation from Claude.ai's own internal API.
 *
 * This is the reliable way to recover an existing chat: it asks Claude's
 * backend for the same JSON the app itself renders, using the user's existing
 * logged-in session (same-origin fetch with credentials, so cookies are sent
 * automatically). It works for the WHOLE conversation — not just the window
 * currently mounted in the DOM — and isn't broken by CSS/markup changes.
 *
 * Endpoints (documented by the community claude.ai exporters):
 *   GET /api/organizations                    -> [{ uuid, ... }]
 *   GET /api/organizations/{orgId}/chat_conversations/{conversationId}
 *                                          -> { name, chat_messages:[...] }
 *
 * The response shape is parsed defensively so small changes don't break it.
 */
(function () {
  'use strict';
  const root = globalThis;
  if (root.RC && root.RC.ApiLoader) return;

  const API_ROOT = 'https://claude.ai/api';

  function getOrgId() {
    return fetch(API_ROOT + '/organizations', {
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    }).then((r) => {
      if (!r.ok) throw new Error('organizations API error ' + r.status);
      return r.json();
    }).then((orgs) => {
      if (Array.isArray(orgs) && orgs.length && orgs[0].uuid) return orgs[0].uuid;
      if (orgs && typeof orgs === 'object' && orgs.uuid) return orgs.uuid;
      throw new Error('Could not determine your Claude organization id');
    });
  }

  function loadConversation(conversationId) {
    return getOrgId().then((orgId) => {
      const url =
        API_ROOT +
        '/organizations/' +
        encodeURIComponent(orgId) +
        '/chat_conversations/' +
        encodeURIComponent(conversationId);
      return fetch(url, {
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
      }).then((res) => {
        if (!res.ok) throw new Error('conversation API error ' + res.status);
        return res.json();
      });
    });
  }

  function inferTypeFromInput(inp) {
    const t = String(inp.type || '').toLowerCase();
    if (t === 'text/markdown' || t === 'markdown') return 'text/markdown';
    if (t === 'application/json' || t === 'json') return 'application/json';
    if (t === 'text/csv' || t === 'csv') return 'text/csv';
    if (t === 'application/xml' || t === 'xml') return 'application/xml';
    if (t === 'application/x-latex' || t === 'latex') return 'application/x-latex';
    if (t === 'application/vnd.ant.react' || t === 'react') return 'application/vnd.ant.react';
    if (t === 'application/vnd.ant.html' || t === 'html') return 'application/vnd.ant.html';
    if (t === 'application/vnd.ant.svg' || t === 'svg') return 'application/vnd.ant.svg';
    if (t === 'application/vnd.ant.code' || t === 'code') return 'application/vnd.ant.code';
    if (t === 'application/vnd.ant.tldraw') return 'application/vnd.ant.tldraw';
    // Fall back on the title extension.
    const title = String(inp.title || '').toLowerCase();
    if (title.endsWith('.md') || title.endsWith('.markdown')) return 'text/markdown';
    if (title.endsWith('.json')) return 'application/json';
    if (title.endsWith('.csv')) return 'text/csv';
    if (title.endsWith('.xml')) return 'application/xml';
    if (title.endsWith('.tex') || title.endsWith('.latex')) return 'application/x-latex';
    if (title.endsWith('.jsx')) return 'application/vnd.ant.react';
    if (title.endsWith('.html')) return 'application/vnd.ant.html';
    if (title.endsWith('.svg')) return 'application/vnd.ant.svg';
    if (title.endsWith('.py') || title.endsWith('.js') || title.endsWith('.ts') ||
        title.endsWith('.tsx') || title.endsWith('.go') || title.endsWith('.rs') ||
        title.endsWith('.java') || title.endsWith('.c') || title.endsWith('.cpp') ||
        title.endsWith('.sh') || title.endsWith('.sql')) {
      return 'application/vnd.ant.code';
    }
    return 'text/markdown';
  }

  /**
   * Convert the raw API conversation JSON into the RainCheck session shape.
   * Returns { title, userMessages, assistantMessages, artifacts, rawKeys }.
   */
  function normalize(data) {
    const title = data.name || data.title || '';
    // chat_messages is the shape used by the community exporters; also handle
    // messages / items / turns as common alternates.
    const messages =
      data.chat_messages ||
      data.messages ||
      data.items ||
      data.turns ||
      (Array.isArray(data) ? data : []) ||
      [];

    const userMessages = [];
    const assistantMessages = [];
    const artifacts = [];

    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const sender = m.sender || m.role || '';
      const content = Array.isArray(m.content)
        ? m.content
        : typeof m.content === 'string'
          ? [{ type: 'text', text: m.content }]
          : [];

      const textParts = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          const inp = block.input || {};
          if (typeof inp.content === 'string' && inp.content.trim().length > 0) {
            artifacts.push({
              identifier: 'api-' + (block.id || inp.title || 'a' + (artifacts.length + 1)),
              type: inferTypeFromInput(inp),
              title: inp.title || 'artifact-' + (artifacts.length + 1),
              language: inp.language || '',
              content: inp.content,
              closed: true,
              open: false,
              source: 'api',
            });
          }
        } else if (typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
      const text = textParts.join('\n').trim();
      if (sender === 'human' || sender === 'user') {
        if (text) userMessages.push(text);
      } else if (sender === 'assistant') {
        if (text) assistantMessages.push(text);
      }
    }

    return { title, userMessages, assistantMessages, artifacts, rawKeys: Object.keys(data || {}) };
  }

  root.RC.ApiLoader = { loadConversation, normalize, getOrgId };
})();

/* ===== SOURCE: content/panel.js ===== */
/**
 * panel.js — floating RainCheck UI. Injected into the page (ISOLATED world)
 * using a shadow root so Claude's styles can't break it and it can't leak
 * into the page. Pure DOM; all data is passed in via update().
 */
(function () {
  'use strict';
  const root = globalThis;
  if (root.RC && root.RC.Panel) return;

  const CSS = `
:host{all:initial;}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
.rc-root{position:fixed;z-index:2147483647;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font-size:13px;line-height:1.45;color:#e7e7e7;}
.rc-fab{position:relative;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#2f6feb,#b146c2);color:#fff;font-size:11px;font-weight:700;letter-spacing:.3px;box-shadow:0 6px 20px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.1;}
.rc-fab .dot{position:absolute;top:-2px;right:-2px;width:14px;height:14px;border-radius:50%;background:#ff5c5c;border:2px solid #1a1a1a;display:none;}
.rc-fab.alert .dot{display:block;}
.rc-panel{width:400px;max-width:calc(100vw - 32px);max-height:min(82vh,680px);display:none;flex-direction:column;background:#1e1f24;border:1px solid #383a42;border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.5);overflow:hidden;}
.rc-panel.open{display:flex;}
.rc-head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#26282e;border-bottom:1px solid #383a42;flex:0 0 auto;}
.rc-logo{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#2f6feb,#b146c2);display:flex;align-items:center;justify-content:center;font-size:14px;}
.rc-title{font-weight:700;font-size:14px;flex:1;}
.rc-close{background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;}
.rc-scroll{overflow-y:auto;flex:1 1 auto;padding:12px 14px;}
.rc-section{margin-bottom:16px;}
.rc-section h3{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#9aa0ab;}
.rc-banner{border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12.5px;}
.rc-banner.error{background:rgba(255,92,92,.14);border:1px solid rgba(255,92,92,.4);}
.rc-banner.warn{background:rgba(255,193,7,.12);border:1px solid rgba(255,193,7,.4);}
.rc-banner.ok{background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.4);}
.rc-banner b{color:#fff;}
.rc-btn{background:#2f6feb;color:#fff;border:none;border-radius:8px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;}
.rc-btn.secondary{background:#3a3d46;color:#e7e7e7;}
.rc-btn.small{padding:4px 9px;font-size:12px;}
.rc-btn:disabled{opacity:.5;cursor:not-allowed;}
.rc-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}
.rc-list{margin:0;padding:0;list-style:none;}
.rc-list li{background:#26282e;border:1px solid #383a42;border-radius:9px;padding:9px 10px;margin-bottom:8px;}
.rc-art{display:flex;align-items:center;gap:8px;}
.rc-art-info{flex:1;min-width:0;}
.rc-art-name{font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.rc-art-meta{font-size:11px;color:#9aa0ab;}
.rc-badge{font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;}
.rc-badge.partial{background:rgba(255,193,7,.2);color:#ffd166;}
.rc-badge.ok{background:rgba(52,211,153,.2);color:#5eead4;}
.rc-empty{color:#9aa0ab;font-size:12px;font-style:italic;}
.rc-textblock{background:#26282e;border:1px solid #383a42;border-radius:9px;padding:10px;font-size:12px;color:#cfd3dc;max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-word;}
.rc-muted{color:#9aa0ab;font-size:11px;}
.rc-foot{padding:10px 14px;border-top:1px solid #383a42;background:#26282e;flex:0 0 auto;display:flex;gap:8px;flex-wrap:wrap;}
`;

  class Panel {
    constructor() {
      this.host = document.createElement('div');
      this.host.id = '__raincheck_panel_host__';
      const shadow = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
      this.el = document.createElement('div');
      this.el.className = 'rc-root';
      shadow.appendChild(this.el);
      document.documentElement.appendChild(this.host);
      this.build(shadow);
      this.state = null;
      try { console.log('[RainCheck] panel created'); } catch (_) {}
    }

    build(shadow) {
      const rootEl = this.el;
      rootEl.innerHTML = `
        <div class="rc-panel">
          <div class="rc-head">
            <div class="rc-logo">🌧</div>
            <div class="rc-title">RainCheck</div>
            <button class="rc-close" title="Close">✕</button>
          </div>
          <div class="rc-scroll">
            <div class="rc-status"></div>
            <div class="rc-summary-section rc-section">
              <h3>Session report</h3>
              <div class="rc-summary"></div>
            </div>
            <div class="rc-artifacts-section rc-section">
              <h3>Recovered files &amp; artifacts</h3>
              <ul class="rc-list"></ul>
              <div class="rc-row rc-zip-row">
                <button class="rc-btn secondary small rc-dl-all">Download all (.zip)</button>
              </div>
            </div>
            <div class="rc-transcript-section rc-section">
              <h3>Transcript</h3>
              <div class="rc-row">
                <button class="rc-btn secondary small rc-dl-transcript">Download transcript (.md)</button>
              </div>
            </div>
            <div class="rc-scan-section rc-section">
              <h3>Existing conversation</h3>
              <p class="rc-muted" style="margin:0 0 8px;">Open a chat (old or new) and recover everything already there — via Claude's API (reliable, full history) or by scanning the rendered page.</p>
              <div class="rc-row">
                <button class="rc-btn small rc-scan-api">Load full via API</button>
                <button class="rc-btn secondary small rc-scan">Scan this page</button>
              </div>
              <div class="rc-scan-status rc-muted" style="margin-top:8px;"></div>
            </div>
            <div class="rc-cont-section rc-section">
              <h3>Resume on a fresh session</h3>
              <div class="rc-textblock rc-cont-text"></div>
              <div class="rc-row">
                <button class="rc-btn small rc-copy-cont">Copy continuation prompt</button>
              </div>
            </div>
          </div>
          <div class="rc-foot">
            <button class="rc-btn secondary small rc-options">Settings</button>
            <span class="rc-muted" style="flex:1;align-self:center;text-align:right;">All data stays on your device.</span>
          </div>
        </div>
        <button class="rc-fab" title="RainCheck"><span class="dot"></span><span>RC</span></button>
      `;

      this.els = {
        panel: rootEl.querySelector('.rc-panel'),
        fab: rootEl.querySelector('.rc-fab'),
        close: rootEl.querySelector('.rc-close'),
        status: rootEl.querySelector('.rc-status'),
        summary: rootEl.querySelector('.rc-summary'),
        list: rootEl.querySelector('.rc-list'),
        dlAll: rootEl.querySelector('.rc-dl-all'),
        dlTranscript: rootEl.querySelector('.rc-dl-transcript'),
        contText: rootEl.querySelector('.rc-cont-text'),
        copyCont: rootEl.querySelector('.rc-copy-cont'),
        scan: rootEl.querySelector('.rc-scan'),
        scanApi: rootEl.querySelector('.rc-scan-api'),
        scanStatus: rootEl.querySelector('.rc-scan-status'),
        options: rootEl.querySelector('.rc-options'),
      };

      this.els.fab.addEventListener('click', () => this.toggle());
      this.els.close.addEventListener('click', () => this.hide());
      this.els.dlAll.addEventListener('click', () => this.onDownloadAll && this.onDownloadAll(this.state));
      this.els.dlTranscript.addEventListener('click', () => this.onDownloadTranscript && this.onDownloadTranscript(this.state));
      this.els.copyCont.addEventListener('click', () => this.onCopyContinuation && this.onCopyContinuation(this.state));
      this.els.scan.addEventListener('click', () => this.onScanConversation && this.onScanConversation());
      this.els.scanApi.addEventListener('click', () => this.onLoadConversationApi && this.onLoadConversationApi());
      this.els.options.addEventListener('click', () => this.onOpenOptions && this.onOpenOptions());
    }

    show() {
      this.els.panel.classList.add('open');
    }
    hide() {
      this.els.panel.classList.remove('open');
    }
    toggle() {
      this.els.panel.classList.toggle('open');
    }

    setAlert(on) {
      this.els.fab.classList.toggle('alert', !!on);
    }

    update(state) {
      this.state = state || {};
      const s = this.state;

      // Status banner
      const status = this.els.status;
      status.innerHTML = '';
      if (s.rateLimited) {
        const b = document.createElement('div');
        b.className = 'rc-banner error';
        b.appendChild(document.createElement('b')).textContent = '⚠ Session interrupted — rate limit reached.';
        b.appendChild(document.createTextNode(' Your last response may be cut off. Everything captured below is safe to download.'));
        if (s.rateLimitMessage) {
          b.appendChild(document.createElement('br'));
          b.appendChild(document.createTextNode(s.rateLimitMessage));
        }
        if (s.retryAfterSeconds != null) {
          b.appendChild(document.createElement('br'));
          b.appendChild(document.createTextNode('Retry in ~' + (globalThis.RC.formatRetry ? globalThis.RC.formatRetry(s.retryAfterSeconds) : s.retryAfterSeconds + 's') + '.'));
        }
        status.appendChild(b);
        this.setAlert(true);
      } else if (s.interrupted || s.partial) {
        const b = document.createElement('div');
        b.className = 'rc-banner warn';
        b.appendChild(document.createElement('b')).textContent = '⚠ The last response was interrupted before finishing.';
        b.appendChild(document.createTextNode(' The open artifact below is partial.'));
        status.appendChild(b);
        this.setAlert(true);
      } else if (s.hasActivity) {
        const b = document.createElement('div');
        b.className = 'rc-banner ok';
        b.textContent = '✓ Monitoring this session. Captured content will appear here.';
        status.appendChild(b);
        this.setAlert(false);
      } else {
        const b = document.createElement('div');
        b.className = 'rc-banner ok';
        b.textContent = 'RainCheck is active on claude.ai.';
        status.appendChild(b);
        this.setAlert(false);
      }

      // Summary
      const sum = this.els.summary;
      sum.innerHTML = '';
      if (s.summaryText) {
        const pre = document.createElement('div');
        pre.className = 'rc-textblock';
        pre.textContent = s.summaryText;
        sum.appendChild(pre);
      } else {
        sum.appendChild(this.emptyEl('No session activity captured yet.'));
      }

      // Artifacts
      const list = this.els.list;
      list.innerHTML = '';
      const arts = s.artifacts || [];
      if (arts.length === 0) {
        list.appendChild(this.emptyEl('No artifacts recovered yet. They appear here the moment they stream in.'));
        this.els.dlAll.disabled = true;
      } else {
        this.els.dlAll.disabled = false;
        arts.slice()
          .reverse()
          .forEach((a) => {
            const li = document.createElement('li');
            const row = document.createElement('div');
            row.className = 'rc-art';
            const info = document.createElement('div');
            info.className = 'rc-art-info';
            const name = document.createElement('div');
            name.className = 'rc-art-name';
            name.textContent = a.title || a.identifier || 'Untitled';
            const meta = document.createElement('div');
            meta.className = 'rc-art-meta';
            meta.textContent =
              (globalThis.RC.typeToDisplayName ? globalThis.RC.typeToDisplayName(a) : a.type || 'Document') +
              ' · ' +
              (a.content ? a.content.length + ' chars' : '0 chars');
            info.appendChild(name);
            info.appendChild(meta);
            const badge = document.createElement('span');
            badge.className = 'rc-badge ' + (a.open ? 'partial' : 'ok');
            badge.textContent = a.open ? 'PARTIAL' : 'OK';
            const dl = document.createElement('button');
            dl.className = 'rc-btn small';
            dl.textContent = 'Download';
            dl.addEventListener('click', () => this.onDownloadArtifact && this.onDownloadArtifact(a));
            row.appendChild(info);
            row.appendChild(badge);
            row.appendChild(dl);
            li.appendChild(row);
            list.appendChild(li);
          });
      }

      // Continuation prompt
      if (s.continuationPrompt) {
        this.els.contText.textContent = s.continuationPrompt;
        this.els.copyCont.disabled = false;
      } else {
        this.els.contText.textContent = 'A ready-to-paste continuation prompt appears here after session activity is captured.';
        this.els.copyCont.disabled = true;
      }
    }

    setScanStatus(text) {
      if (this.els.scanStatus) this.els.scanStatus.textContent = text || '';
    }

    emptyEl(text) {
      const d = document.createElement('div');
      d.className = 'rc-empty';
      d.textContent = text;
      return d;
    }
  }

  root.RC.Panel = Panel;
})();

/* ===== SOURCE: content/bridge.js ===== */
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
    if (!panel) return; // panel creation is deferred until DOMContentLoaded
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
    panel.onLoadConversationApi = loadConversationFromApi;
    panel.onOpenOptions = () => chrome.runtime.sendMessage({ type: 'open-options' });
    panel.update(buildState(sessions[activeConvId] || null));
    if (sessions[activeConvId] && (sessions[activeConvId].rateLimit || sessions[activeConvId].interrupted)) {
      panel.show();
    }
  }

  /* ---------------------------------------------------------- *
   * Load a full conversation from Claude's internal API.
   * ---------------------------------------------------------- */
  function loadConversationFromApi() {
    const button = panel && panel.els && panel.els.scanApi;
    const setStatus = (t) => panel && panel.setScanStatus && panel.setScanStatus(t);
    if (button) button.disabled = true;
    setStatus('Loading full conversation from Claude API…');

    const convId = activeConvId || convIdFromUrl();
    if (!convId) {
      setStatus('⚠ Open a conversation first (its URL contains the chat id).');
      if (button) button.disabled = false;
      return;
    }
    if (!RC.ApiLoader) {
      setStatus('⚠ API loader not available. Reload the page and try again.');
      if (button) button.disabled = false;
      return;
    }

    RC.ApiLoader.loadConversation(convId)
      .then((data) => {
        const n = RC.ApiLoader.normalize(data || {});
        if (!n.userMessages.length && !n.assistantMessages.length && !n.artifacts.length) {
          setStatus('⚠ The API returned no recoverable content for this conversation.');
          console.log('[RainCheck] API response had no content. top-level keys:', JSON.stringify(n.rawKeys), 'sample:', String(JSON.stringify(data)).slice(0, 2000));
          return;
        }
        const s = getSession(convId);
        if (n.userMessages.length) s.userMessages = n.userMessages;
        if (n.assistantMessages.length) s.assistantMessages = n.assistantMessages;
        if (n.artifacts.length) s.artifacts = n.artifacts;
        if (n.title && !s.title) s.title = n.title;
        s.hasActivity = true;
        s.touch();
        refreshUI();
        panel.show();
        setStatus(
          '✓ Loaded full conversation: ' + n.userMessages.length + ' user msg, ' +
          n.assistantMessages.length + ' assistant msg, ' + n.artifacts.length + ' file(s).'
        );
        console.log('[RainCheck] API load complete:', {
          user: n.userMessages.length, assistant: n.assistantMessages.length, artifacts: n.artifacts.length,
        });
      })
      .catch((e) => {
        console.error('[RainCheck] API load failed:', e);
        setStatus('⚠ API load failed: ' + ((e && e.message) || e) + ' — try "Scan this page" instead.');
      })
      .finally(() => {
        if (button) button.disabled = false;
      });
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

