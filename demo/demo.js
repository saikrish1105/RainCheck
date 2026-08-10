#!/usr/bin/env node
/**
 * demo.js — end-to-end simulation of RainCheck's pipeline without Claude.
 *
 * It feeds a realistic claude.ai-shaped SSE stream (a document + a code
 * artifact + an un-closed artifact cut off by a rate limit) through the same
 * parser-core.js code the extension uses, then:
 *   - prints the structured interruption report (Feature 1, no-LLM),
 *   - writes each recovered artifact to demo/output/artifacts/ (Feature 2),
 *   - writes the transcript, the summary, and a .zip of all artifacts.
 *
 * Run:  npm run demo
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const RC = require('../src/shared/parser-core.js');

const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'claude-stream.txt');
const OUT = path.join(__dirname, 'output');
const ART_DIR = path.join(OUT, 'artifacts');

function reset() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(ART_DIR, { recursive: true });
}

function simulate(session) {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  const { frames, remainder } = RC.splitFrames(raw);
  if (remainder) frames.push(RC.parseFrame(remainder));

  const acc = new RC.ArtifactAccumulator();
  for (const frame of frames) {
    const parsed = RC.parseFrame(frame);
    const ev = RC.normalizeClaudeEvent(parsed);
    if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.text) {
      acc.feed(ev.delta.text);
      session.assistantMessages[0] = (session.assistantMessages[0] || '') + ev.delta.text;
    }
    if (ev && ev.type === 'error') {
      const rl = RC.detectRateLimit({ eventData: ev });
      if (rl.isLimited) session.rateLimit = rl;
    }
  }
  session.artifacts = acc.getArtifacts();
  session.partial = acc.hasOpen();
  return session;
}

function main() {
  reset();
  const session = {
    convId: 'demo-0001',
    title: 'Build a data pipeline',
    startedAt: Date.now() - 60000,
    userMessages: ['Build a data processor in Python and a short notes document.'],
    assistantMessages: [],
    artifacts: [],
    rateLimit: null,
    partial: false,
  };
  simulate(session);

  console.log('\n=== RainCheck end-to-end demo ===\n');
  console.log('Streamed: 1 document + 1 code artifact; a 2nd document was cut off by a rate limit.\n');

  const summary = RC.buildStructuredSummary({
    userMessages: session.userMessages,
    assistantMessages: session.assistantMessages,
    artifacts: session.artifacts,
    rateLimited: !!session.rateLimit,
    rateLimitMessage: session.rateLimit ? session.rateLimit.message : '',
    partial: session.partial,
  });

  // 1) Report
  fs.writeFileSync(path.join(OUT, 'report.md'), summary.summaryText);
  console.log('--- Structured report (Feature 1) ---------------------------');
  console.log(summary.summaryText);

  // 2) Artifacts (Feature 2)
  console.log('--- Recovered artifacts (Feature 2) --------------------------');
  for (const a of session.artifacts) {
    const ext = RC.typeToExtension(a);
    const name = RC.safeFilename(a.title || a.identifier || 'artifact', ext);
    fs.writeFileSync(path.join(ART_DIR, name), a.content);
    console.log(
      `  ${a.open ? '[PARTIAL]' : '[ok]      '} ${name}  (${a.type})  ${a.content.length} chars`
    );
  }

  // Transcript
  fs.writeFileSync(path.join(OUT, 'transcript.md'), RC.buildTranscript(session));

  // Zip of all artifacts
  const zip = RC.makeZip(
    session.artifacts.map((a) => ({
      name: RC.safeFilename(a.title || a.identifier || 'artifact', RC.typeToExtension(a)),
      data: a.content,
    }))
  );
  fs.writeFileSync(path.join(OUT, 'artifacts.zip'), Buffer.from(zip));

  // Continuation prompt
  console.log('--- Continuation prompt (for a fresh session) ----------------');
  console.log(summary.continuationPrompt);

  console.log('\nWrote: report.md, transcript.md, artifacts.zip, artifacts/*\n  → ' + OUT);
}

main();
