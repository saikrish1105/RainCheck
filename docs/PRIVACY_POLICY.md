# Privacy Policy — RainCheck

**Last updated:** 2026-08-10

RainCheck is a browser extension that helps you monitor your Claude.ai session
and weekly usage limits and generate a handoff summary of a conversation so you
can continue it elsewhere.

## Data we collect

RainCheck does **not** collect, transmit, or sell any data to us. There is no
server, no analytics, no tracking, and no third-party data sharing.

The extension only ever interacts with **Claude.ai on your own logged-in
session**, using the same APIs the Claude.ai web app itself uses. Specifically,
while you are on claude.ai, RainCheck may:

- Read your **session usage** (5-hour and weekly utilization percentages) and
  the **current conversation** (messages and any generated files) from
  Claude.ai's own API so it can display usage bars and build a handoff summary.
- Show a floating panel with the recovered conversation and a "Copy Markdown"
  / "Copy Summary" action.

All of this is limited to the `claude.ai` website you are already logged into,
requires **no extra permissions** beyond accessing that site, and the data is
used only to render the extension's own UI in your browser.

## Where data lives

Everything stays **local to your browser**. RainCheck does not send your
conversation, messages, usage, or any other personal information to any external
server other than Claude.ai itself (only to fetch the same data the Claude.ai
page you opened already loads). No data is stored on our servers.

## Permissions

RainCheck requests access only to `https://claude.ai/*` (and `*.claude.ai/*`),
which is necessary for the extension to function. It uses the `downloads`
capability only if you choose to save a file, and `storage` is not used to
collect personal data.

## Contact

If you have questions about this policy, please open an issue on the project's
GitHub repository.
