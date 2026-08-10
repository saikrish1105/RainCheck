'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildOutput,
  msgText,
  entireInteractionText,
  lastMessageText,
  parseUsageFromEndpoint,
  parseUsageFromMessageLimit,
  formatResetCountdown,
} = require('../src/content/isolated.js');

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

test('buildOutput contains Claude summary, entire interaction, last text, and JSON', () => {
  const out = buildOutput(data);
  assert.ok(out.includes('The summary of the text so far:'));
  assert.ok(out.includes('User set up Nextcloud with Docker.'));
  assert.ok(out.includes('The entire text interaction:'));
  assert.ok(out.includes('Build a report'));
  assert.ok(out.includes('The last text before rate limit was hit:'));
  assert.ok(out.includes('Here is a partial document that got cut off'));
  assert.ok(out.includes('Full chat JSON'));
  assert.ok(out.includes('"uuid": "1"'));
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
