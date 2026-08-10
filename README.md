# 🌧 RainCheck Summary + Usage Counter

A **minimalistic** Chrome extension for claude.ai with two features:

1. **Generate Summary** — a one-button rate-limit handoff summary.
2. **Usage bars** (claude-counter style) — live session (5h) and weekly (7d)
   utilization percentages with progress bars and reset countdowns, injected
   into the chat input area.

Nothing runs automatically except the usage bars (which mirror claude-counter's
behavior). The summary is generated only when you press **Generate Summary**.

---

## Feature 1 — Generate Summary

Open a conversation, click the cloud button, press **Generate Summary**. It
fetches the conversation from Claude's own API (using your login) and produces a
handoff text with:

- the continuation header — *"You are continuing a session that was interrupted
  by a rate limit. Do NOT restart from scratch — continue exactly where it
  stopped."*
- **the summary of the text so far** (Claude's saved summary)
- **the entire text interaction** (all user + assistant messages)
- **the last text before the rate limit was hit**
- **the full chat JSON** (every user + assistant message) — view / copy
- Claude's saved summary again

Per-tab: empty on a new page; navigating to another conversation resets it.

## Feature 2 — Usage bars (claude-counter)

Shows `Session: NN% · resets in Xh Ym` and `Weekly: NN% · resets in Xd Yh` with
progress bars (turn red at ≥90%). Click the row to force-refresh.

Data comes from the same two sources claude-counter uses:
- `GET /api/organizations/{orgId}/usage` → `five_hour` / `seven_day` with
  `utilization` % and `resets_at`.
- Live `message_limit` SSE events (intercepted by an injected MAIN-world bridge)
  for exact, unrounded fractions.

> **No token counts are shown.** Claude's usage API only exposes percentages —
> it does not return exact token numbers (Anthropic now defines plans by
> multipliers, not fixed token budgets). Per your instruction, since the exact
> count isn't available from the API, we don't display it.

---

## Install (load unpacked)
1. Open `chrome://extensions`, toggle **Developer mode** ON.
2. Click **Load unpacked** and select the **`RainCheck`** folder (the one that
   directly contains `manifest.json`).
3. Open **claude.ai** — the cloud button appears bottom-right; the usage bars
   appear in the chat input area.

## Layout
```
RainCheck/
├── manifest.json                  MV3 manifest
├── src/
│   ├── content/isolated.js        ★ ISOLATED world: summary panel + usage bars
│   ├── injected/bridge.js         MAIN world: intercepts SSE + answers /usage
│   └── assets/cloud.png           the cute cloud icon
├── test/                          unit + jsdom UI smoke tests
└── package.json                   npm test
```

## Test
```bash
npm install   # dev dependency: jsdom (tests only)
npm test
```

## Privacy
Everything runs locally. The only requests are to Claude's own API (conversation
+ usage) for the account you're logged into. Nothing is sent elsewhere.
