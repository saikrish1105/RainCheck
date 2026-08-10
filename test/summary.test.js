'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildOutput,
  buildTranscriptMarkdown,
  messageMarkdown,
  msgText,
  entireInteractionText,
  lastMessageText,
  parseUsageFromEndpoint,
  parseUsageFromMessageLimit,
  formatResetCountdown,
} = require('../src/content/isolated.js');

// Realistic conversation matching the actual claude.ai JSON shape.
const realData = {
  name: 'Setting up Nextcloud server with Docker on Kali Linux',
  summary: 'The person is a student setting up a personal homelab.',
  chat_messages: [
    {
      uuid: '019f-x1', text: '', sender: 'human', index: 0, created_at: 't', updated_at: 't',
      content: [{ start_timestamp: 't', stop_timestamp: 't', type: 'text', text: 'Help me set up Nextcloud with Docker.', citations: [] }],
    },
    {
      uuid: '019f-x2', text: '', sender: 'assistant', index: 1, created_at: 't', updated_at: 't',
      content: [
        { type: 'thinking', thinking: '', summaries: [{ summary: 'Planning' }] },
        { type: 'text', text: 'Create the project structure.', citations: [] },
        { type: 'tool_use', id: 't1', name: 'memory_str_replace', input: { path: '/x', new_str: 'b' } },
        { type: 'tool_use', id: 't2', name: 'create_file', input: { path: '/tmp/homelab-notes.md', file_text: '# Homelab\n\nDocs...' } },
      ],
    },
    {
      uuid: '019f-x3', text: '', sender: 'human', index: 2, created_at: 't', updated_at: 't',
      content: [{ type: 'text', text: 'What about Proxmox?' }],
    },
  ],
};

const data = {
  name: 'Setup server',
  summary: 'User set up Nextcloud with Docker.',
  chat_messages: [
    { uuid: '1', sender: 'human', text: 'Build a report' },
    { uuid: '2', sender: 'assistant', text: 'Here is a partial document that got cut off...' },
  ],
};

test('buildOutput contains the continuation header', () => {
  const out = buildOutput(data);
  assert.ok(out.includes('You are continuing a session that was interrupted by a rate limit'));
  assert.ok(out.includes('Do NOT restart from scratch'));
});

test('buildOutput contains Claude summary, entire interaction, last text, and transcript', () => {
  const out = buildOutput(data);
  assert.ok(out.includes('The summary of the text so far:'));
  assert.ok(out.includes('User set up Nextcloud with Docker.'));
  assert.ok(out.includes('The entire text interaction:'));
  assert.ok(out.includes('Build a report'));
  assert.ok(out.includes('The last text before rate limit was hit:'));
  assert.ok(out.includes('Here is a partial document that got cut off'));
  assert.ok(out.includes('Full conversation transcript (markdown):'));
  assert.ok(out.includes('### User 1'));
});

test('msgText handles nested message envelope and string content', () => {
  // Nested envelope shape
  assert.equal(
    msgText({ message: { content: [{ type: 'text', text: 'nested hello' }] } }),
    'nested hello'
  );
  // String content
  assert.equal(msgText({ content: 'plain string' }), 'plain string');
  // tool_result block
  assert.equal(
    msgText({ content: [{ type: 'tool_result', content: 'tool output' }] }),
    'tool output'
  );
});

test('msgText handles direct text and content-array shapes', () => {
  assert.equal(msgText({ text: 'hi' }), 'hi');
  assert.equal(msgText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(msgText({}), '');
});

test('lastMessageText returns the last non-empty message', () => {
  const arr = [
    { sender: 'human', text: 'one' },
    { sender: 'human', text: '' },
    { sender: 'assistant', text: 'two' },
  ];
  assert.equal(lastMessageText(arr), 'two');
  assert.equal(lastMessageText([]), '');
});

test('empty conversation still produces a sensible output', () => {
  const out = buildOutput({ name: 'Empty', summary: '', chat_messages: [] });
  assert.ok(out.includes('(No saved summary available)'));
  assert.ok(out.includes('(No messages)'));
});

/* ---- Markdown transcript converter ---- */

test('buildTranscriptMarkdown keeps title, summary and clean turns, drops noise', () => {
  const md = buildTranscriptMarkdown(realData);
  assert.ok(md.includes('# Setting up Nextcloud server'));
  assert.ok(md.includes('## Session summary'));
  assert.ok(md.includes('### User 1'));
  assert.ok(md.includes('Help me set up Nextcloud with Docker.'));
  assert.ok(md.includes('### Assistant 1'));
  assert.ok(md.includes('Create the project structure.'));
  assert.ok(md.includes('### User 2'));
  assert.ok(md.includes('What about Proxmox?'));
  // Noise that must be dropped:
  assert.ok(!md.includes('019f-'), 'should drop uuid');
  assert.ok(!md.includes('start_timestamp'), 'should drop timestamps');
  assert.ok(!md.includes('memory_str_replace'), 'should drop internal tool plumbing');
  assert.ok(!md.includes('summaries'), 'should drop thinking summaries');
  assert.ok(!md.includes('citations'), 'should drop citations');
});

test('buildTranscriptMarkdown captures generated files as code blocks', () => {
  const md = buildTranscriptMarkdown(realData);
  assert.ok(md.includes('📄 **Generated file: /tmp/homelab-notes.md**'));
  assert.ok(md.includes('```\n# Homelab\n\nDocs...\n```'));
});

test('messageMarkdown skips thinking/tool plumbing but keeps text and files', () => {
  const assistant = realData.chat_messages[1];
  const md = messageMarkdown(assistant);
  assert.ok(md.includes('Create the project structure.'));
  assert.ok(md.includes('Generated file'));
  assert.ok(!md.includes('memory_str_replace'));
  assert.ok(!md.includes('Planning'));
});

test('buildOutput includes the markdown transcript instead of raw JSON', () => {
  const out = buildOutput(realData);
  assert.ok(out.includes('Full conversation transcript (markdown):'));
  assert.ok(!out.includes('"uuid"'), 'should not embed raw JSON uuid keys');
  assert.ok(out.includes('### User 1'));
});

test('buildTranscriptMarkdown handles empty conversation', () => {
  assert.equal(buildTranscriptMarkdown({ chat_messages: [] }), '(No messages)');
  assert.equal(buildTranscriptMarkdown(null), '(No messages)');
});

/* ---- Usage parsing (claude-counter) ---- */

test('parseUsageFromEndpoint reads utilization % and resets_at', () => {
  const u = parseUsageFromEndpoint({
    five_hour: { utilization: 62.4, resets_at: '2026-01-01T00:00:00Z' },
    seven_day: { utilization: 15, resets_at: '2026-01-05T00:00:00Z' },
  });
  assert.ok(u);
  assert.equal(u.five_hour.utilization, 62.4);
  assert.equal(u.five_hour.window_hours, 5);
  assert.equal(u.seven_day.utilization, 15);
  assert.equal(u.seven_day.window_hours, 168);
});

test('parseUsageFromEndpoint clamps and rejects invalid', () => {
  const u = parseUsageFromEndpoint({ five_hour: { utilization: 150 }, seven_day: { utilization: -5 } });
  assert.equal(u.five_hour.utilization, 100);
  assert.equal(u.seven_day.utilization, 0);
  assert.equal(parseUsageFromEndpoint({}), null);
  assert.equal(parseUsageFromEndpoint(null), null);
});

test('parseUsageFromMessageLimit converts 0..1 utilization to % and epoch to ISO', () => {
  const u = parseUsageFromMessageLimit({
    windows: {
      '5h': { utilization: 0.5, resets_at: 1700000000 },
      '7d': { utilization: 0.2, resets_at: 1700000000 },
    },
  });
  assert.ok(u);
  assert.equal(u.five_hour.utilization, 50);
  assert.equal(u.seven_day.utilization, 20);
  assert.ok(u.five_hour.resets_at.includes('T'));
});

test('formatResetCountdown renders hours/days', () => {
  const future = Date.now() + 3 * 60 * 60 * 1000;
  assert.match(formatResetCountdown(future), /3h \d+m/);
  const past = Date.now() - 1000;
  assert.equal(formatResetCountdown(past), '0s');
});
