/* Options page logic. */
const DEFAULT_BASE = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
};
const DEFAULT_MODEL = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
};

function el(id) {
  return document.getElementById(id);
}

function load() {
  chrome.runtime.sendMessage({ type: 'get-settings' }, (res) => {
    const s = (res && res.settings) || {};
    el('enabled').checked = s.enabled !== false;
    el('autoOpen').checked = s.autoOpenOnRateLimit !== false;
    const llm = s.llm || {};
    el('llmEnabled').checked = !!llm.enabled;
    el('provider').value = llm.provider || 'anthropic';
    el('model').value = llm.model || DEFAULT_MODEL[el('provider').value];
    el('baseUrl').value = llm.baseUrl || DEFAULT_BASE[el('provider').value];
    el('apiKey').value = llm.apiKey || '';
  });
}

function save() {
  const provider = el('provider').value;
  const settings = {
    enabled: el('enabled').checked,
    autoOpenOnRateLimit: el('autoOpen').checked,
    llm: {
      enabled: el('llmEnabled').checked,
      provider,
      baseUrl: el('baseUrl').value.trim() || DEFAULT_BASE[provider],
      model: el('model').value.trim() || DEFAULT_MODEL[provider],
      apiKey: el('apiKey').value.trim(),
    },
  };
  chrome.runtime.sendMessage({ type: 'save-settings', settings }, (res) => {
    const st = el('status');
    st.textContent = res && res.ok ? 'Saved ✓' : 'Error saving';
    setTimeout(() => (st.textContent = ''), 1800);
  });
}

el('provider').addEventListener('change', () => {
  const p = el('provider').value;
  el('baseUrl').value = DEFAULT_BASE[p];
  el('model').value = DEFAULT_MODEL[p];
});
el('save').addEventListener('click', save);

load();
