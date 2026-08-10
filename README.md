# 🌧 RainCheck — Claude.ai Session Saver

A Chrome extension for claude.ai with two features:

1. **Usage bars** (claude-counter style) — live session (5h) and weekly (7d)
   utilization percentages with progress bars and reset countdowns, injected
   into the chat input area.
2. **Generate Summary** — a one-button handoff: turns your conversation into a
   clean, LLM-ready markdown transcript you can paste into another AI or session
   to continue where you left off.

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
│   ├── options/popup.html         toolbar popup (description + bouncing cloud)
│   └── assets/cloud.png           the orange smiling cloud (draggable button / logo)
├── website/                       dark-orange landing site (index, FAQ, Terms, Privacy)
├── docs/                          privacy policy + Chrome Web Store listing text
├── scripts/                       build + store-asset generation
├── test/                          unit + jsdom UI smoke tests
└── package.json                   npm test / npm run build
```

## Website

A dark, orange-themed static site lives in `website/` (no build step — plain
HTML/CSS). Pages:
- `index.html` — landing page (hero, features, how-it-works)
- `faq.html` — FAQ (accordion)
- `terms.html` — Terms of Service
- `privacy.html` — Privacy Policy

The "Install extension" buttons are placeholders — fill them in once the
extension is published to the Chrome Web Store. Preview locally with:

```bash
python3 -m http.server 8080 --directory website
```

## Test
```bash
npm install   # dev dependency: jsdom (tests only)
npm test
```

## Privacy
Everything runs locally. The only requests are to Claude's own API (conversation
+ usage) for the account you're logged into. Nothing is sent elsewhere.
