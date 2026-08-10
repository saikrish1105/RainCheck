# 🌧 RainCheck — Claude Session Saver

A **Chrome extension (Manifest V3)** that rescues your work when a Claude.ai session is
interrupted by a rate limit. It captures the data **already streaming into your own browser**
and turns it into things you can actually keep:

1. **Recovers hidden / partial artifacts** — every artifact, code block and document Claude
   streams to the page (even ones whose panel collapsed or whose response got cut off
   mid-stream) becomes a **Download** button.
2. **Builds a structured interruption report** — "here's the task, what was completed, what
   was cut off, and what's left" — with **no external AI dependency**.
3. **Generates a "continuation prompt"** you can paste into a fresh account/session to resume
   exactly where you stopped.
4. **(Optional, opt-in v2)** A bring-your-own-key AI handoff summary via Anthropic / OpenAI / Gemini.

It never sends your data anywhere. Everything is processed locally in `chrome.storage.local`.

> **About the ToS:** This tool only captures bytes that Anthropic already sends to *your own
> browser* and re-exports them for you — it does **not** bypass rate limits or call the API
> more than Claude's UI already does. It is best framed as *"export what's mine,"* not
> *"defeat rate limiting."* Use at your own discretion and review Anthropic's terms.

---

## How it works (the short version)

Claude.ai is a single-page app. Every token, artifact, and streamed chunk must pass through
the browser's `fetch`/`XHR` before you see it. RainCheck:

1. Injects a script into the page's **MAIN world** at `document_start` — *before* Claude's own
   bundles load — that **tees** every chat-completion stream (`fetch` + `XMLHttpRequest`).
   Claude's UI still gets the untouched stream; RainCheck also reads a `clone()` and forwards
   the raw bytes + HTTP status to an **ISOLATED-world** bridge via `postMessage`.
2. The bridge reassembles the stream, parses the SSE frames, and extracts artifacts out of
   the raw text (Claude wraps artifacts as
   `<antArtifact identifier="…" type="…" title="…" language="…">…</antArtifact>`).
   Even a **never-closed** tag is captured as a **partial** artifact and made downloadable.
3. It detects interruption via **HTTP 429**, a **streamed `rate_limit_error`**, or a
   rate-limit error envelope, and raises the panel.
4. The panel lists recovered files (with **Download** / **Download all (.zip)**), the
   structured report, the transcript, and the continuation prompt.

No encryption is broken and nothing is fetched beyond what Claude's UI already does — you're
just getting the data that's already in your browser.

---

## Project layout

```
RainCheck/
├── manifest.json                 MV3 manifest (content scripts in both worlds)
├── src/
│   ├── shared/parser-core.js     ★ core logic (SSE parse, artifacts, rate-limit,
│   │                                report, ZIP) — browser + Node (unit-tested)
│   ├── content/
│   │   ├── network-hook.js       MAIN world, document_start: tees fetch/XHR streams
│   │   ├── dom-extractor.js      reads already-rendered conversations from the DOM
│   │   ├── bridge.js             ISOLATED world: assembles sessions, drives UI
│   │   ├── panel.js              floating shadow-DOM panel
│   │   └── isolated.js           ★ GENERATED bundle (parser-core+dom-extractor+panel+bridge)
│   ├── background/service-worker.js   settings + optional LLM summarizer
│   └── options/                  settings page + action popup
├── scripts/build.js              bundles the isolated-world script
├── test/                         Node unit + jsdom integration tests
├── demo/demo.js                  offline end-to-end simulation (no Claude needed)
└── package.json                  npm test / npm run demo / npm run build
```

---

## Install (development / load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select the **`RainCheck`** folder (this repo root).
4. Open **claude.ai**, log in, and send a message. The **🌧 RC** floating button appears
   bottom-right. Open it to watch artifacts appear live.

That's it. No build step, no bundler, no dependencies.

### Build (one-time, after edits)

The isolated-world content script is bundled into a single file so the whole UI layer is
self-contained (see "Why a generated bundle" below). After editing any of
`parser-core.js` / `panel.js` / `bridge.js`, regenerate it:

```bash
npm install   # dev dependency: jsdom (tests only)
npm run build # regenerates src/content/isolated.js
```

> You only need `npm run build` if you change those files. The checked-in
> `src/content/isolated.js` is already up to date.

### Test without Claude

The core pipeline is fully offline-testable:

```bash
npm test      # 18 tests: unit (SSE, artifacts, rate-limit, reports, ZIP)
              #           + jsdom integration (loads real isolated.js in a DOM
              #             window, creates the FAB/panel, feeds a streamed
              #             artifact via postMessage, and DOM-scans a rendered chat)
npm run demo  # simulates a rate-limited stream and writes report/artifacts/transcript/zip
```

`npm run demo` writes to `demo/output/`: `report.md`, `transcript.md`, `artifacts.zip`,
and each recovered artifact in `artifacts/` — the exact behavior the extension performs on
a real session, demonstrated end-to-end.

---

## Feature 1 — interruption report (no-LLM)

The moment a rate limit is detected, RainCheck builds a structured report from data it already
holds (no AI needed):

- **The task** — the first user message.
- **What was completed** — recovered artifacts + counts of messages.
- **What was in progress (cut off)** — the un-closed artifact and its partial content.
- **Remaining work** — handoff guidance.

It also produces a ready-to-paste **continuation prompt** (included in the report and
copyable from the panel) for resuming on a fresh account/session.

The optional **AI summary** (`src/background/service-worker.js`) can upgrade this to natural
language, but only if you configure **your own** API key in Settings — off by default.

---

## Feature 2 — recovering hidden / partial artifacts

The stream is teed before Claude's UI consumes it, so even artifacts whose panel you never
opened, that auto-collapsed, or that got cut off are captured:

- Complete artifacts → **OK** badge + Download.
- Never-closed artifacts → **PARTIAL** badge + Download (you still get everything up to the
  cutoff).
- **Download all (.zip)** — a dependency-free ZIP writer builds the archive in-browser.
- File type is inferred from the artifact MIME type (and the `language` attribute for code),
  so `text/markdown` → `.md`, `application/vnd.ant.code`+`language=python` → `.py`, etc.

> **Known limitation — PDFs.** Claude delivers generated PDFs as binary assets through a
> *separate* mechanism, not as streamed `<antArtifact>` text. So the stream parser won't
> capture PDFs. Use the **"Scan this conversation"** feature below (or Claude's own download
> button) to get PDFs.

---

## Feature 3 — scan an existing conversation (DOM extraction)

Open any chat (old or new) and hit **"Scan this conversation"** in the panel. RainCheck reads
the **already-rendered DOM** — no network interception needed — and recovers:

- the full transcript (user + assistant messages),
- rendered artifacts / code blocks (via the "Existing conversation" section),

then exposes the usual Download / Download all / Transcript / Continuation-prompt actions.
This is what makes existing conversations recoverable retroactively.

### Tuning DOM selectors

DOM extraction relies on heuristic selectors (centralized in `src/content/dom-extractor.js`
in the `SELECTORS` table). If a Claude update changes its markup and scanning stops finding
content, the fastest fix is a small DOM snapshot. On the claude.ai page, in the console run:

```js
copy(document.querySelector('[data-testid="user-message"], [data-testid="assistant-message"]')?.outerHTML)
```

and paste it to me — I'll adjust `SELECTORS` accordingly.

---

## Privacy

- All parsing, reporting, and ZIP building happens **locally in your browser**.
- Recovered sessions are stored in **`chrome.storage.local`** (never synced, never sent out).
- Nothing leaves your device except an **optional AI-summary request** using **your own key**,
  and only if you explicitly enable it.

---

## Settings page

From the toolbar icon → **Open settings** (or `chrome://extensions` → RainCheck → Details →
Extension options):

- **Behavior**: enable capture; auto-open the panel on rate limit.
- **Optional AI summary**: provider (Anthropic / OpenAI / Gemini), model, base URL, API key.

---

## Limitations & maintenance

- **Fragility.** Claude.ai is a moving target — endpoints, SSE shapes, and the
  `<antArtifact …>` markup can change without notice. The URL matcher and event normalizer
  cover the current known patterns (`/completion`, `/append-messages`, `/chat_conversations/*`,
  and both raw + `stream_event`-wrapped SSE), but expect occasional updates.
- **Stream format verification.** The exact byte format can drift. If artifacts stop
  appearing after a Claude update, follow the "Verify against the live network" steps below.
- **Non-text binary** (some uploaded/downloaded files) is best-effort; the primary value is
  the streamed text/code/document content.
- **Rate limits reset on a rolling window** in the web app, so "wait 5 hours" is a user-facing
  countdown, not a hard server value; RainCheck reads `retry-after` when present and otherwise
  shows the detected message.

---

## What I'd want from you when you test on a real session

I simulated everything I could on my own (the whole pipeline is unit-tested and demoed
offline). The one thing I **cannot** simulate from here is a *live, authenticated claude.ai
network trace*, because it requires your logged-in browser session. When you first use it on a
real chat, if anything looks off, grab a short trace so I can tighten the matcher. Exactly how:

1. Open claude.ai → DevTools (**F12**) → **Network** tab → filter **Fetch/XHR**.
2. Send a message.
3. Right-click the request whose name contains `completion` or `append-messages` →
   **Copy → Copy as cURL** (or open it → **Response**, and grab a few streamed `event:`/`data:`
   lines).
4. Paste that into the issue/PR so I can confirm the endpoint + payload shape match the
   current frontend.

That's the only thing I need that I can't do for you — everything else (parsing, artifact
recovery, reporting, ZIP) is already implemented and tested.

---

## Tech notes

- Manifest V3 with two `content_scripts` entries: one in **`"world": "MAIN"`** (the hook,
  `document_start`) and one in the default **ISOLATED** world (bridge + panel). Cross-world
  messaging uses `window.postMessage` with a namespaced message + `source`/`origin` checks.
- **Why a generated bundle?** Chrome runs the multiple JS files of one `content_scripts` entry
  in a shared isolated world, but relying on a `globalThis` value set in one file and read in
  a later file is fragile across Chrome versions/environments. So the ISOLATED world loads a
  single self-contained file (`src/content/isolated.js`) produced by `scripts/build.js` from
  `parser-core.js` + `panel.js` + `bridge.js`. This eliminates cross-file global dependencies.
- Zero runtime dependencies — SSE parsing, artifact extraction, and the ZIP writer are all
  hand-rolled and unit-tested. (`jsdom` is a dev dependency used only by the tests.)
- The core logic in `src/shared/parser-core.js` runs in both the browser and Node, which is
  why the unit tests and demo exercise the *exact* code the extension ships.
