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
