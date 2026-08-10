/**
 * panel.js — floating RainCheck UI. Injected into the page (ISOLATED world)
 * using a shadow root so Claude's styles can't break it and it can't leak
 * into the page. Pure DOM; all data is passed in via update().
 */
(function () {
  'use strict';
  const root = globalThis;
  if (root.RC && root.RC.Panel) return;

  const CSS = `
:host{all:initial;}
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
.rc-root{position:fixed;z-index:2147483647;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font-size:13px;line-height:1.45;color:#e7e7e7;}
.rc-fab{position:relative;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#2f6feb,#b146c2);color:#fff;font-size:11px;font-weight:700;letter-spacing:.3px;box-shadow:0 6px 20px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.1;}
.rc-fab .dot{position:absolute;top:-2px;right:-2px;width:14px;height:14px;border-radius:50%;background:#ff5c5c;border:2px solid #1a1a1a;display:none;}
.rc-fab.alert .dot{display:block;}
.rc-panel{width:400px;max-width:calc(100vw - 32px);max-height:min(82vh,680px);display:none;flex-direction:column;background:#1e1f24;border:1px solid #383a42;border-radius:14px;box-shadow:0 14px 40px rgba(0,0,0,.5);overflow:hidden;}
.rc-panel.open{display:flex;}
.rc-head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#26282e;border-bottom:1px solid #383a42;flex:0 0 auto;}
.rc-logo{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#2f6feb,#b146c2);display:flex;align-items:center;justify-content:center;font-size:14px;}
.rc-title{font-weight:700;font-size:14px;flex:1;}
.rc-close{background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;}
.rc-scroll{overflow-y:auto;flex:1 1 auto;padding:12px 14px;}
.rc-section{margin-bottom:16px;}
.rc-section h3{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#9aa0ab;}
.rc-banner{border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12.5px;}
.rc-banner.error{background:rgba(255,92,92,.14);border:1px solid rgba(255,92,92,.4);}
.rc-banner.warn{background:rgba(255,193,7,.12);border:1px solid rgba(255,193,7,.4);}
.rc-banner.ok{background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.4);}
.rc-banner b{color:#fff;}
.rc-btn{background:#2f6feb;color:#fff;border:none;border-radius:8px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;}
.rc-btn.secondary{background:#3a3d46;color:#e7e7e7;}
.rc-btn.small{padding:4px 9px;font-size:12px;}
.rc-btn:disabled{opacity:.5;cursor:not-allowed;}
.rc-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}
.rc-list{margin:0;padding:0;list-style:none;}
.rc-list li{background:#26282e;border:1px solid #383a42;border-radius:9px;padding:9px 10px;margin-bottom:8px;}
.rc-art{display:flex;align-items:center;gap:8px;}
.rc-art-info{flex:1;min-width:0;}
.rc-art-name{font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.rc-art-meta{font-size:11px;color:#9aa0ab;}
.rc-badge{font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;}
.rc-badge.partial{background:rgba(255,193,7,.2);color:#ffd166;}
.rc-badge.ok{background:rgba(52,211,153,.2);color:#5eead4;}
.rc-empty{color:#9aa0ab;font-size:12px;font-style:italic;}
.rc-textblock{background:#26282e;border:1px solid #383a42;border-radius:9px;padding:10px;font-size:12px;color:#cfd3dc;max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-word;}
.rc-muted{color:#9aa0ab;font-size:11px;}
.rc-foot{padding:10px 14px;border-top:1px solid #383a42;background:#26282e;flex:0 0 auto;display:flex;gap:8px;flex-wrap:wrap;}
`;

  class Panel {
    constructor() {
      this.host = document.createElement('div');
      this.host.id = '__raincheck_panel_host__';
      const shadow = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
      this.el = document.createElement('div');
      this.el.className = 'rc-root';
      shadow.appendChild(this.el);
      document.documentElement.appendChild(this.host);
      this.build(shadow);
      this.state = null;
      try { console.log('[RainCheck] panel created'); } catch (_) {}
    }

    build(shadow) {
      const rootEl = this.el;
      rootEl.innerHTML = `
        <div class="rc-panel">
          <div class="rc-head">
            <div class="rc-logo">🌧</div>
            <div class="rc-title">RainCheck</div>
            <button class="rc-close" title="Close">✕</button>
          </div>
          <div class="rc-scroll">
            <div class="rc-status"></div>
            <div class="rc-summary-section rc-section">
              <h3>Session report</h3>
              <div class="rc-summary"></div>
            </div>
            <div class="rc-artifacts-section rc-section">
              <h3>Recovered files &amp; artifacts</h3>
              <ul class="rc-list"></ul>
              <div class="rc-row rc-zip-row">
                <button class="rc-btn secondary small rc-dl-all">Download all (.zip)</button>
              </div>
            </div>
            <div class="rc-transcript-section rc-section">
              <h3>Transcript</h3>
              <div class="rc-row">
                <button class="rc-btn secondary small rc-dl-transcript">Download transcript (.md)</button>
              </div>
            </div>
            <div class="rc-cont-section rc-section">
              <h3>Resume on a fresh session</h3>
              <div class="rc-textblock rc-cont-text"></div>
              <div class="rc-row">
                <button class="rc-btn small rc-copy-cont">Copy continuation prompt</button>
              </div>
            </div>
          </div>
          <div class="rc-foot">
            <button class="rc-btn secondary small rc-options">Settings</button>
            <span class="rc-muted" style="flex:1;align-self:center;text-align:right;">All data stays on your device.</span>
          </div>
        </div>
        <button class="rc-fab" title="RainCheck"><span class="dot"></span><span>RC</span></button>
      `;

      this.els = {
        panel: rootEl.querySelector('.rc-panel'),
        fab: rootEl.querySelector('.rc-fab'),
        close: rootEl.querySelector('.rc-close'),
        status: rootEl.querySelector('.rc-status'),
        summary: rootEl.querySelector('.rc-summary'),
        list: rootEl.querySelector('.rc-list'),
        dlAll: rootEl.querySelector('.rc-dl-all'),
        dlTranscript: rootEl.querySelector('.rc-dl-transcript'),
        contText: rootEl.querySelector('.rc-cont-text'),
        copyCont: rootEl.querySelector('.rc-copy-cont'),
        options: rootEl.querySelector('.rc-options'),
      };

      this.els.fab.addEventListener('click', () => this.toggle());
      this.els.close.addEventListener('click', () => this.hide());
      this.els.dlAll.addEventListener('click', () => this.onDownloadAll && this.onDownloadAll(this.state));
      this.els.dlTranscript.addEventListener('click', () => this.onDownloadTranscript && this.onDownloadTranscript(this.state));
      this.els.copyCont.addEventListener('click', () => this.onCopyContinuation && this.onCopyContinuation(this.state));
      this.els.options.addEventListener('click', () => this.onOpenOptions && this.onOpenOptions());
    }

    show() {
      this.els.panel.classList.add('open');
    }
    hide() {
      this.els.panel.classList.remove('open');
    }
    toggle() {
      this.els.panel.classList.toggle('open');
    }

    setAlert(on) {
      this.els.fab.classList.toggle('alert', !!on);
    }

    update(state) {
      this.state = state || {};
      const s = this.state;

      // Status banner
      const status = this.els.status;
      status.innerHTML = '';
      if (s.rateLimited) {
        const b = document.createElement('div');
        b.className = 'rc-banner error';
        b.appendChild(document.createElement('b')).textContent = '⚠ Session interrupted — rate limit reached.';
        b.appendChild(document.createTextNode(' Your last response may be cut off. Everything captured below is safe to download.'));
        if (s.rateLimitMessage) {
          b.appendChild(document.createElement('br'));
          b.appendChild(document.createTextNode(s.rateLimitMessage));
        }
        if (s.retryAfterSeconds != null) {
          b.appendChild(document.createElement('br'));
          b.appendChild(document.createTextNode('Retry in ~' + (globalThis.RC.formatRetry ? globalThis.RC.formatRetry(s.retryAfterSeconds) : s.retryAfterSeconds + 's') + '.'));
        }
        status.appendChild(b);
        this.setAlert(true);
      } else if (s.interrupted || s.partial) {
        const b = document.createElement('div');
        b.className = 'rc-banner warn';
        b.appendChild(document.createElement('b')).textContent = '⚠ The last response was interrupted before finishing.';
        b.appendChild(document.createTextNode(' The open artifact below is partial.'));
        status.appendChild(b);
        this.setAlert(true);
      } else if (s.hasActivity) {
        const b = document.createElement('div');
        b.className = 'rc-banner ok';
        b.textContent = '✓ Monitoring this session. Captured content will appear here.';
        status.appendChild(b);
        this.setAlert(false);
      } else {
        const b = document.createElement('div');
        b.className = 'rc-banner ok';
        b.textContent = 'RainCheck is active on claude.ai.';
        status.appendChild(b);
        this.setAlert(false);
      }

      // Summary
      const sum = this.els.summary;
      sum.innerHTML = '';
      if (s.summaryText) {
        const pre = document.createElement('div');
        pre.className = 'rc-textblock';
        pre.textContent = s.summaryText;
        sum.appendChild(pre);
      } else {
        sum.appendChild(this.emptyEl('No session activity captured yet.'));
      }

      // Artifacts
      const list = this.els.list;
      list.innerHTML = '';
      const arts = s.artifacts || [];
      if (arts.length === 0) {
        list.appendChild(this.emptyEl('No artifacts recovered yet. They appear here the moment they stream in.'));
        this.els.dlAll.disabled = true;
      } else {
        this.els.dlAll.disabled = false;
        arts.slice()
          .reverse()
          .forEach((a) => {
            const li = document.createElement('li');
            const row = document.createElement('div');
            row.className = 'rc-art';
            const info = document.createElement('div');
            info.className = 'rc-art-info';
            const name = document.createElement('div');
            name.className = 'rc-art-name';
            name.textContent = a.title || a.identifier || 'Untitled';
            const meta = document.createElement('div');
            meta.className = 'rc-art-meta';
            meta.textContent =
              (globalThis.RC.typeToDisplayName ? globalThis.RC.typeToDisplayName(a) : a.type || 'Document') +
              ' · ' +
              (a.content ? a.content.length + ' chars' : '0 chars');
            info.appendChild(name);
            info.appendChild(meta);
            const badge = document.createElement('span');
            badge.className = 'rc-badge ' + (a.open ? 'partial' : 'ok');
            badge.textContent = a.open ? 'PARTIAL' : 'OK';
            const dl = document.createElement('button');
            dl.className = 'rc-btn small';
            dl.textContent = 'Download';
            dl.addEventListener('click', () => this.onDownloadArtifact && this.onDownloadArtifact(a));
            row.appendChild(info);
            row.appendChild(badge);
            row.appendChild(dl);
            li.appendChild(row);
            list.appendChild(li);
          });
      }

      // Continuation prompt
      if (s.continuationPrompt) {
        this.els.contText.textContent = s.continuationPrompt;
        this.els.copyCont.disabled = false;
      } else {
        this.els.contText.textContent = 'A ready-to-paste continuation prompt appears here after session activity is captured.';
        this.els.copyCont.disabled = true;
      }
    }

    emptyEl(text) {
      const d = document.createElement('div');
      d.className = 'rc-empty';
      d.textContent = text;
      return d;
    }
  }

  root.RC.Panel = Panel;
})();
