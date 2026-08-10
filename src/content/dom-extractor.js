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
