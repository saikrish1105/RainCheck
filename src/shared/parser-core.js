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
