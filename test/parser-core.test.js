'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const RC = require('../src/shared/parser-core.js');

/* ------------------------------------------------------------------ *
 * SSE parsing / normalization
 * ------------------------------------------------------------------ */
test('parseFrame handles event + data lines', () => {
  const p = RC.parseFrame('event: message_start\ndata: {"type":"message_start","x":1}');
  assert.equal(p.event, 'message_start');
  assert.equal(p.data.type, 'message_start');
  assert.equal(p.data.x, 1);
});

test('normalizeClaudeEvent unwraps stream_event envelopes', () => {
  const inner = RC.normalizeClaudeEvent({
    event: 'stream_event',
    data: { type: 'stream_event', event: { type: 'content_block_delta', index: 0 } },
  });
  assert.equal(inner.type, 'content_block_delta');
});

test('splitFrames keeps remainder across chunks', () => {
  // Feed a frame split across two network reads.
  const r1 = RC.splitFrames('event: a\ndata: {"a":1}\n\nevent: b\ndata: {"b":2');
  assert.equal(r1.frames.length, 1);
  assert.equal(r1.frames[0].includes('{"a":1}'), true);
  const r2 = RC.splitFrames(r1.remainder + '}\n\n');
  assert.equal(r2.frames.length, 1);
  assert.equal(r2.frames[0].includes('{"b":2}'), true);
});

/* ------------------------------------------------------------------ *
 * Artifact extraction (partial + completed)
 * ------------------------------------------------------------------ */
test('ArtifactAccumulator recovers partial artifacts cut off mid-stream', () => {
  const acc = new RC.ArtifactAccumulator();
  acc.feed('Doc:\n<antArtifact identifier="x" type="text/markdown" title="X.md"># Half\n\nonly part');
  const a = acc.getArtifacts();
  assert.equal(a.length, 1);
  assert.equal(a[0].title, 'X.md');
  assert.equal(a[0].open, true);
  assert.equal(a[0].closed, false);
  assert.ok(a[0].content.includes('only part'));
});

test('ArtifactAccumulator finalizes when closing tag arrives', () => {
  const acc = new RC.ArtifactAccumulator();
  acc.feed('<antArtifact identifier="y" type="text/markdown" title="Y.md">content</antArtifact>');
  const a = acc.getArtifacts()[0];
  assert.equal(a.closed, true);
  assert.equal(a.open, false);
  assert.equal(a.content, 'content');
});

test('multiple artifacts are extracted', () => {
  const acc = new RC.ArtifactAccumulator();
  acc.feed(
    '<antArtifact identifier="a" type="text/markdown" title="A">one</antArtifact>' +
      '<antArtifact identifier="b" type="application/vnd.ant.code" title="B" language="python">two</antArtifact>'
  );
  const arts = acc.getArtifacts();
  assert.equal(arts.length, 2);
  assert.equal(arts[1].language, 'python');
});

test('full realistic stream produces one complete + one partial artifact', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-stream.txt'), 'utf8');
  const acc = new RC.ArtifactAccumulator();
  let buffer = '';
  const { frames, remainder } = RC.splitFrames(raw);
  assert.equal(remainder, '');
  let sawStop = false;
  let sawError = false;
  for (const frame of frames) {
    const parsed = RC.parseFrame(frame);
    const ev = RC.normalizeClaudeEvent(parsed);
    if (ev && ev.type === 'content_block_delta') acc.feed(ev.delta.text);
    if (ev && ev.type === 'message_stop') sawStop = true;
    if (ev && ev.type === 'error') sawError = true;
  }
  const arts = acc.getArtifacts();
  assert.equal(arts.length, 2);
  const code = arts.find((a) => a.identifier === 'data-proc');
  const notes = arts.find((a) => a.identifier === 'notes');
  assert.ok(code);
  assert.equal(code.closed, true);
  assert.ok(code.content.includes('import csv'));
  assert.ok(notes);
  assert.equal(notes.open, true);
  assert.equal(notes.closed, false);
  assert.ok(notes.content.includes('Unfinished'));
});

/* ------------------------------------------------------------------ *
 * Rate limit detection
 * ------------------------------------------------------------------ */
test('detects HTTP 429 with retry-after', () => {
  const r = RC.detectRateLimit({ status: 429, headers: { 'retry-after': '18000' } });
  assert.equal(r.isLimited, true);
  assert.equal(r.retryAfterSeconds, 18000);
});

test('detects streamed rate_limit_error', () => {
  const r = RC.detectRateLimit({
    status: 200,
    headers: {},
    eventData: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
  });
  assert.equal(r.isLimited, true);
});

test('does not false-positive on normal text', () => {
  const r = RC.detectRateLimit({
    status: 200,
    headers: {},
    eventData: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'rates and limits' } },
  });
  assert.equal(r.isLimited, false);
});

test('formatRetry renders hours', () => {
  assert.match(RC.formatRetry(18000), /5 hour/);
});

/* ------------------------------------------------------------------ *
 * Summary / continuation prompt
 * ------------------------------------------------------------------ */
test('buildStructuredSummary produces report and continuation prompt', () => {
  const s = RC.buildStructuredSummary({
    userMessages: ['Build a data pipeline'],
    assistantMessages: ['Here is a partial script'],
    artifacts: [
      { identifier: 'x', type: 'application/vnd.ant.code', title: 'x.py', language: 'python', content: 'def main(): pass', closed: false, open: true },
    ],
    rateLimited: true,
    rateLimitMessage: 'HTTP 429 — rate limit reached.',
    partial: true,
  });
  assert.ok(s.summaryText.includes('Build a data pipeline'));
  assert.ok(s.summaryText.includes('rate limit'));
  assert.ok(s.continuationPrompt.includes('Original task'));
  assert.ok(s.continuationPrompt.includes('data pipeline'));
  assert.equal(s.totalArtifacts, 1);
  assert.equal(s.openCount, 1);
});

test('type mapping resolves extensions', () => {
  assert.equal(RC.typeToExtension({ type: 'text/markdown' }), 'md');
  assert.equal(
    RC.typeToExtension({ type: 'application/vnd.ant.code', language: 'python' }),
    'py'
  );
  assert.equal(RC.typeToExtension({ type: 'application/vnd.ant.react' }), 'jsx');
  assert.equal(RC.typeToExtension({ type: 'application/vnd.ant.mermaid' }), 'mmd');
});

/* ------------------------------------------------------------------ *
 * ZIP writer
 * ------------------------------------------------------------------ */
test('makeZip produces a valid zip that Python can read', () => {
  const zip = RC.makeZip([
    { name: 'a.txt', data: 'hello world' },
    { name: 'sub/b.md', data: '# Title\n\nbody' },
  ]);
  const tmp = path.join(require('node:os').tmpdir(), 'rc-test-' + Date.now() + '.zip');
  fs.writeFileSync(tmp, Buffer.from(zip));
  const cp = require('node:child_process').spawnSync('python3', [
    '-c',
    'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(sorted(z.namelist()));print(z.read("a.txt").decode())',
    tmp,
  ]);
  try {
    assert.equal(cp.status, 0);
    const out = cp.stdout.toString();
    assert.ok(out.includes('a.txt'));
    assert.ok(out.includes('b.md'));
    assert.ok(out.includes('hello world'));
  } finally {
    fs.unlinkSync(tmp);
  }
});
