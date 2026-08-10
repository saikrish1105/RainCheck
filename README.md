# 🌧 RainCheck Summary

A **minimalistic** Chrome extension for claude.ai. One button. One output.

When you hit a rate limit (or just want to hand a conversation off to a fresh
session), open the panel and press **Generate Summary**. It fetches the current
conversation from Claude's own API (using your existing login) and produces a
single handoff text containing:

- the continuation header — *"You are continuing a session that was interrupted
  by a rate limit. Do NOT restart from scratch — continue exactly where it
  stopped."*
- **the summary of the text so far** (Claude's saved summary, pulled from the API)
- **the entire text interaction** (all user + assistant messages)
- **the last text before the rate limit was hit**
- **the full chat JSON** (every user + assistant message) — view it and copy it
- Claude's saved summary again, below the JSON

**Nothing happens automatically.** No stream capture, no auto-popup — only when
you press **Generate Summary**.

## Behavior
- **Per-tab.** Each claude.ai tab runs its own copy. A **new/empty** page shows an
  empty panel ("Open a Claude conversation first…"). If you navigate to a
  different conversation, the panel resets to show that page's details on demand.
- **Draggable cloud button.** The little cloud can be dragged anywhere on the
  page; clicking it (without dragging) opens/closes the panel.

## Install (load unpacked)
1. Open `chrome://extensions`, toggle **Developer mode** ON.
2. Click **Load unpacked** and select the **`RainCheck`** folder (the one that
   directly contains `manifest.json`).
3. Open **claude.ai** — the cloud button appears bottom-right.

## Layout
```
RainCheck/
├── manifest.json                  MV3 manifest
├── src/
│   ├── content/isolated.js        ★ everything (UI + API call + output builder)
│   └── assets/cloud.png           the cute cloud icon
├── test/summary.test.js           unit tests for the output builder
└── package.json                   npm test
```

## Test
```bash
npm test   # unit tests for the handoff-text builder
```

## Privacy
Everything runs locally in your browser. The only request is to Claude's own API
for the conversation you already have open. Nothing is sent anywhere else.
