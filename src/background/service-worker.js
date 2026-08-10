/**
 * service-worker.js — MV3 background service worker.
 *
 * Responsibilities:
 *   - Store default settings on install.
 *   - Handle the "open options" request from content scripts.
 *   - Persist / serve extension settings (get-settings / save-settings).
 *   - OPTIONAL: "llm-summarize" — turn a recovered transcript into a natural
 *     language handoff summary using a provider/API key the user configured
 *     themselves in the options page. Off by default; never used unless the
 *     user opts in. This keeps the key out of page scripts.
 */
const DEFAULTS = {
  enabled: true,
  autoOpenOnRateLimit: true,
  // Optional AI summary (bring-your-own-key).
  llm: {
    enabled: false,
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    model: 'claude-sonnet-4-20250514',
    apiKey: '',
  },
};

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ settings: DEFAULTS }, (data) => resolve(data.settings || DEFAULTS));
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ settings: null }, (data) => {
    if (!data.settings) chrome.storage.local.set({ settings: DEFAULTS });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message && message.type) {
    case 'open-options':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      break;

    case 'get-settings':
      getSettings().then((s) => sendResponse({ ok: true, settings: s }));
      return true; // async

    case 'save-settings':
      chrome.storage.local.set({ settings: message.settings || DEFAULTS }, () =>
        sendResponse({ ok: true })
      );
      break;

    case 'llm-summarize':
      handleLlmSummarize(message.payload || {})
        .then((r) => sendResponse({ ok: true, text: r }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true; // async

    default:
      sendResponse({ ok: false, error: 'unknown message' });
  }
  return false;
});

/* ------------------------------------------------------------------ *
 * Optional LLM summarizer
 * ------------------------------------------------------------------ */
async function handleLlmSummarize({ transcript, promptHint }) {
  const settings = await getSettings();
  const llm = settings.llm || {};
  if (!llm.enabled || !llm.apiKey) {
    throw new Error(
      'LLM summarization is not enabled. Configure a provider and API key in RainCheck settings.'
    );
  }
  const text = transcript || '';
  if (!text) throw new Error('Nothing to summarize.');

  const provider = String(llm.provider || 'anthropic').toLowerCase();
  const system =
    'You are an assistant that produces a concise, copy-pasteable handoff summary of an ' +
    'interrupted AI chat session. Output: (1) the task, (2) what was completed, (3) what was ' +
    'in progress and cut off, (4) remaining steps. Plain text, no preamble.';

  if (provider === 'anthropic') {
    const res = await fetch(llm.baseUrl || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': llm.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: llm.model || 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system,
        messages: [
          { role: 'user', content: (promptHint ? promptHint + '\n\n' : '') + text.slice(0, 80000) },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Anthropic API error ' + res.status);
    return data.content?.map((c) => c.text || '').join('\n') || '';
  }

  if (provider === 'openai') {
    const res = await fetch(llm.baseUrl || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + llm.apiKey },
      body: JSON.stringify({
        model: llm.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: (promptHint ? promptHint + '\n\n' : '') + text.slice(0, 80000) },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'OpenAI API error ' + res.status);
    return data.choices?.[0]?.message?.content || '';
  }

  if (provider === 'gemini') {
    const key = llm.apiKey;
    const base = llm.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/models';
    const model = llm.model || 'gemini-2.0-flash';
    const url = base + '/' + model + ':generateContent?key=' + key;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [
          { role: 'user', parts: [{ text: (promptHint ? promptHint + '\n\n' : '') + text.slice(0, 80000) }] },
        ],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Gemini API error ' + res.status);
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';
  }

  throw new Error('Unsupported provider: ' + llm.provider);
}
