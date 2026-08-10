'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildOutput, msgText, entireInteractionText, lastMessageText } = require('../src/content/isolated.js');

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
