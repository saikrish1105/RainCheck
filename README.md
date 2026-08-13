# 🌧 RainCheck — Claude.ai Session Saver

A Chrome extension for claude.ai with two features:

1. **Usage bars** (claude-counter style) — live session (5h) and weekly (7d)
   utilization percentages with progress bars and reset countdowns, injected
   into the chat input area.
   <img width="930" height="140" alt="Screenshot 2026-08-10 152805" src="https://github.com/user-attachments/assets/0063fa01-1767-4338-907a-5798c3410e1d" />

3. **Generate Summary** — a one-button handoff: turns your conversation into a
   clean, LLM-ready markdown transcript you can paste into another AI or session
   to continue where you left off.
   <img width="1895" height="760" alt="Screenshot 2026-08-10 155203" src="https://github.com/user-attachments/assets/4f67d1cc-53fd-4574-8264-659e3479b09e" />


Nothing runs automatically except the usage bars. The summary is generated only
when you press **Generate Summary**.

The brand mark is a **cute orange smiling cloud**:
- It's the extension icon and the draggable in-page button (a transparent,
  genuinely cloud-shaped button — no rectangular box).
- The summary panel **anchors to the cloud**: wherever you drag the cloud, the
  panel opens right next to it (above if there's room, otherwise below).

---

## Feature 1 — Generate Summary

Open a conversation, click the cloud button, press **Generate Summary**. It
fetches the conversation from Claude's own API (using your login) and produces a
handoff text with:

- **the summary of the text so far** (Claude's saved summary)
- **a clean Markdown transcript** of the whole conversation — view / **Copy Markdown**
- Claude's saved summary again

The conversation is converted from Claude's raw JSON into a **clean, LLM-ready
Markdown transcript** (title, saved summary, and `### User N` / `### Assistant N`
turns, with generated files included as code blocks). All the noise — `uuid`,
`index`, `created_at`, internal `tool_use`/`thinking` plumbing — is dropped so
you can paste the transcript straight into another AI to continue the work.

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
1. Go to the link : [Extension](https://chromewebstore.google.com/detail/raincheck/epbnfdblpahffkbbfcmfaaflpibcinnk)
2. Press add to chrome
3. And you can use it on any chat in claude!!

## Layout
```
RainCheck/
├── manifest.json                  MV3 manifest
├── src/
│   ├── content/isolated.js        ★ ISOLATED world: summary panel + usage bars
│   ├── injected/bridge.js         MAIN world: intercepts SSE + answers /usage
│   ├── options/popup.html         toolbar popup (description + bouncing cloud)
│   └── assets/cloud.png           the orange smiling cloud (draggable button / logo)
├── website/                       dark-orange landing site (index, FAQ, Terms, Privacy)
├── docs/                          privacy policy + Chrome Web Store listing text
├── scripts/                       build + store-asset generation
├── test/                          unit + jsdom UI smoke tests
└── package.json                   npm test / npm run build
```

## Website

Check out the landing page for the extension at [Homepage](https://raincheck.krish.systems/)
```

## Privacy
Everything runs locally. The only requests are to Claude's own API (conversation
+ usage) for the account you're logged into. Nothing is sent elsewhere.
