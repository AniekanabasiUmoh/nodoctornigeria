from __future__ import annotations

from fastapi.responses import HTMLResponse

_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>__APP_NAME__ &mdash; nodoctor.ng</title>
  <style>
    :root {
      --bg: #f4efe6;
      --panel: rgba(255,252,247,0.88);
      --panel-strong: rgba(255,252,247,0.96);
      --ink: #1b2219;
      --muted: #56635a;
      --emerald: #1d6d5f;
      --emerald-light: rgba(29,109,95,0.10);
      --emerald-border: rgba(29,109,95,0.22);
      --terracotta: #b94f2c;
      --terracotta-light: rgba(185,79,44,0.10);
      --terracotta-border: rgba(185,79,44,0.22);
      --gold: #9c6a00;
      --gold-light: rgba(156,106,0,0.10);
      --danger: #8f2d1e;
      --danger-bg: rgba(143,45,30,0.08);
      --line: rgba(27,34,25,0.10);
      --shadow: 0 8px 32px rgba(40,30,14,0.09);
      --radius: 22px;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Georgia, "Times New Roman", serif;
      background: var(--bg);
      color: var(--ink);
      min-height: 100dvh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }

    /* NAV */
    nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-strong);
      backdrop-filter: blur(12px);
      position: sticky; top: 0; z-index: 100;
    }
    .nav-brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }
    .nav-logo {
      width: 34px; height: 34px; border-radius: 50%;
      background: var(--emerald); color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 17px; font-weight: bold; font-family: Georgia, serif;
    }
    .nav-name { font-size: 1.05rem; color: var(--ink); }
    .nav-name span { color: var(--emerald); }
    .nav-badge {
      font-size: 0.68rem; background: var(--emerald-light); color: var(--emerald);
      border: 1px solid var(--emerald-border); border-radius: 999px; padding: 3px 10px;
      font-family: system-ui, sans-serif; letter-spacing: 0.06em; text-transform: uppercase;
    }

    /* LAYOUT */
    main {
      max-width: 760px; width: 100%;
      margin: 0 auto; padding: 24px 14px 40px;
      display: flex; flex-direction: column; gap: 18px;
    }

    /* HERO */
    .hero {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: var(--radius); padding: 24px 22px 20px;
      box-shadow: var(--shadow);
    }
    .hero-eyebrow {
      font-family: system-ui, sans-serif; font-size: 0.7rem;
      letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--emerald); margin-bottom: 9px;
    }
    .hero h1 { font-size: 1.8rem; line-height: 1.15; margin-bottom: 9px; font-weight: normal; }
    .hero p { color: var(--muted); font-size: 0.93rem; line-height: 1.6; }
    .hero-disclaimer {
      margin-top: 12px; padding: 9px 13px;
      background: var(--gold-light); border: 1px solid rgba(156,106,0,0.2);
      border-radius: 11px;
      font-family: system-ui, sans-serif; font-size: 0.78rem; color: var(--gold); line-height: 1.5;
    }

    /* TABS */
    .tab-row {
      display: flex; gap: 6px;
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 999px; padding: 5px;
      box-shadow: var(--shadow);
    }
    .tab-btn {
      flex: 1; border: none; background: transparent; cursor: pointer;
      padding: 9px 16px; border-radius: 999px;
      font-family: system-ui, sans-serif; font-size: 0.86rem; color: var(--muted);
      transition: background 0.15s, color 0.15s;
    }
    .tab-btn.active-community { background: var(--emerald); color: #fff; }
    .tab-btn.active-clinical  { background: var(--terracotta); color: #fff; }

    /* CHAT CARD */
    .chat-card {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: var(--radius); box-shadow: var(--shadow);
      overflow: hidden; display: flex; flex-direction: column;
    }
    .chat-header {
      padding: 12px 16px 10px; border-bottom: 1px solid var(--line);
      display: flex; align-items: center; gap: 8px;
    }
    .chat-header-dot { width: 9px; height: 9px; border-radius: 50%; }
    .dot-community { background: var(--emerald); }
    .dot-clinical   { background: var(--terracotta); }
    .chat-header-label {
      font-family: system-ui, sans-serif; font-size: 0.78rem;
      text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted);
    }

    /* THREAD */
    #thread {
      padding: 16px 14px;
      display: flex; flex-direction: column; gap: 12px;
      min-height: 110px; max-height: 480px;
      overflow-y: auto;
    }
    .msg { display: flex; flex-direction: column; gap: 4px; max-width: 90%; }
    .msg-user { align-self: flex-end; align-items: flex-end; }
    .msg-bot  { align-self: flex-start; align-items: flex-start; }
    .msg-bubble {
      padding: 11px 15px; border-radius: 17px;
      font-size: 0.93rem; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
    }
    .msg-user .msg-bubble {
      background: var(--emerald); color: #fff; border-bottom-right-radius: 5px;
    }
    .msg-bot .msg-bubble {
      background: var(--panel-strong); border: 1px solid var(--line);
      color: var(--ink); border-bottom-left-radius: 5px;
    }
    .msg-bot.clinical .msg-bubble { border-color: var(--terracotta-border); }

    .msg-disposition {
      display: inline-block; font-family: system-ui, sans-serif; font-size: 0.68rem;
      padding: 2px 8px; border-radius: 999px; margin-top: 2px;
    }
    .disp-ANSWER       { background: var(--emerald-light); color: var(--emerald); }
    .disp-EMERGENCY    { background: var(--danger-bg); color: var(--danger); }
    .disp-UNCERTAIN    { background: var(--gold-light); color: var(--gold); }
    .disp-INSUFFICIENT { background: var(--gold-light); color: var(--gold); }
    .disp-ASK          { background: var(--gold-light); color: var(--gold); }

    .citations {
      margin-top: 7px; padding: 9px 13px;
      background: var(--emerald-light); border: 1px solid var(--emerald-border);
      border-radius: 11px;
      font-family: system-ui, sans-serif; font-size: 0.76rem; color: var(--muted); line-height: 1.7;
    }
    .citations strong { color: var(--emerald); display: block; margin-bottom: 2px; }

    .dosage-pill {
      display: inline-block;
      background: var(--terracotta-light); border: 1px solid var(--terracotta-border);
      color: var(--terracotta); border-radius: 11px;
      padding: 5px 13px; font-family: system-ui, sans-serif; font-size: 0.8rem; margin-top: 5px;
    }
    .warning-pill {
      display: inline-block;
      background: var(--gold-light); border: 1px solid rgba(156,106,0,0.2);
      color: var(--gold); border-radius: 11px;
      padding: 5px 13px; font-family: system-ui, sans-serif; font-size: 0.78rem;
      margin-top: 4px; line-height: 1.4;
    }

    .feedback-row { display: flex; gap: 7px; margin-top: 7px; }
    .feedback-btn {
      border: 1px solid var(--line); background: transparent; cursor: pointer;
      border-radius: 999px; padding: 4px 13px;
      font-family: system-ui, sans-serif; font-size: 0.76rem; color: var(--muted);
      transition: border-color 0.12s, color 0.12s;
    }
    .feedback-btn:hover { border-color: var(--emerald); color: var(--emerald); }

    /* LOADING DOTS */
    .loading-bubble {
      padding: 11px 16px;
      background: var(--panel-strong); border: 1px solid var(--line);
      border-radius: 17px; border-bottom-left-radius: 5px;
      display: flex; gap: 5px; align-items: center;
    }
    .loading-bubble span {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--muted); animation: pulse 1.2s ease-in-out infinite;
    }
    .loading-bubble span:nth-child(2) { animation-delay: 0.2s; }
    .loading-bubble span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes pulse { 0%,80%,100%{opacity:0.2} 40%{opacity:1} }

    /* INPUT */
    .input-area {
      border-top: 1px solid var(--line);
      padding: 10px 12px;
      display: flex; gap: 8px; align-items: flex-end;
    }
    #query-input {
      flex: 1; min-height: 42px; max-height: 130px;
      border-radius: 16px; border: 1px solid var(--line);
      padding: 9px 14px; font-family: Georgia, serif;
      font-size: 0.93rem; color: var(--ink); background: var(--bg);
      resize: none; outline: none; line-height: 1.5;
      transition: border-color 0.15s;
    }
    #query-input:focus { border-color: var(--emerald); }
    #send-btn {
      flex-shrink: 0; width: 42px; height: 42px;
      border-radius: 50%; border: none; cursor: pointer;
      background: var(--emerald); color: #fff;
      font-size: 1rem; display: flex; align-items: center; justify-content: center;
      transition: opacity 0.15s;
    }
    #send-btn:disabled { opacity: 0.4; cursor: default; }
    #send-btn.clinical-mode { background: var(--terracotta); }

    /* FOOTER */
    footer {
      text-align: center; padding: 16px;
      font-family: system-ui, sans-serif; font-size: 0.73rem; color: var(--muted);
      border-top: 1px solid var(--line);
    }
    footer a { color: var(--emerald); text-decoration: none; }

    @media (max-width: 520px) {
      .hero h1 { font-size: 1.45rem; }
      main { padding: 14px 8px 28px; }
    }
  </style>
</head>
<body>

<!-- __APP_NAME__ | Ask Community Bot | Review Queue -->

<nav>
  <a class="nav-brand" href="/">
    <div class="nav-logo">N</div>
    <span class="nav-name">no<span>doctor</span>.ng</span>
  </a>
  <span class="nav-badge">Beta</span>
</nav>

<main>
  <div class="hero">
    <p class="hero-eyebrow">Nigeria Standard Treatment Guidelines &mdash; AI Assistant</p>
    <h1>Medical guidance,<br>when there is no doctor.</h1>
    <p>Ask health questions in plain language. Every answer is drawn directly from the National Standard Treatment Guidelines (NSTG). No guessing. No invention.</p>
    <div class="hero-disclaimer">
      &#9888; This tool supports decision-making but does not replace a qualified clinician.
      In an emergency, go to the nearest hospital immediately.
    </div>
  </div>

  <div class="tab-row" role="tablist">
    <button class="tab-btn active-community" role="tab" data-mode="community" onclick="switchMode('community')">
      Community
    </button>
    <button class="tab-btn" role="tab" data-mode="clinical" onclick="switchMode('clinical')">
      Clinical / Clinician
    </button>
  </div>

  <div class="chat-card">
    <div class="chat-header">
      <div class="chat-header-dot dot-community" id="mode-dot"></div>
      <span class="chat-header-label" id="mode-label">Community &mdash; plain language, triage-aware</span>
    </div>
    <div id="thread" aria-live="polite" aria-label="Conversation"></div>
    <div class="input-area">
      <textarea
        id="query-input"
        rows="1"
        placeholder="Ask a health question&hellip;"
        aria-label="Your question"
        onkeydown="handleKey(event)"
        oninput="autoResize(this)"
      ></textarea>
      <button id="send-btn" onclick="sendQuery()" aria-label="Send">&#9654;</button>
    </div>
  </div>
</main>

<footer>
  nodoctor.ng &mdash; powered by Nigeria Standard Treatment Guidelines &middot;
  <a href="/health">API status</a>
</footer>

<script>
  var currentMode = 'community';
  var loading = false;

  var thread   = document.getElementById('thread');
  var input    = document.getElementById('query-input');
  var sendBtn  = document.getElementById('send-btn');
  var modeDot  = document.getElementById('mode-dot');
  var modeLbl  = document.getElementById('mode-label');

  var MODE = {
    community: {
      dot: 'dot-community',
      label: 'Community \u2014 plain language, triage-aware',
      placeholder: 'Ask in plain language. E.g. My child has fever and is not eating.',
    },
    clinical: {
      dot: 'dot-clinical',
      label: 'Clinical \u2014 structured answers, dosing, citations',
      placeholder: 'E.g. Artemether-Lumefantrine dose for 18 kg child.',
    },
  };

  function switchMode(mode) {
    currentMode = mode;
    var m = MODE[mode];
    document.querySelectorAll('.tab-btn').forEach(function(b) {
      b.classList.remove('active-community', 'active-clinical');
      if (b.dataset.mode === mode) b.classList.add('active-' + mode);
    });
    modeDot.className = 'chat-header-dot ' + m.dot;
    modeLbl.textContent = m.label;
    input.placeholder = m.placeholder;
    sendBtn.classList.toggle('clinical-mode', mode === 'clinical');
    input.focus();
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 130) + 'px';
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuery(); }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function appendUser(text) {
    var el = document.createElement('div');
    el.className = 'msg msg-user';
    el.innerHTML = '<div class="msg-bubble">' + esc(text) + '</div>';
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
  }

  function appendLoader() {
    var el = document.createElement('div');
    el.className = 'msg msg-bot';
    el.innerHTML = '<div class="loading-bubble"><span></span><span></span><span></span></div>';
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
    return el;
  }

  function buildBotEl(data, mode) {
    var el = document.createElement('div');
    el.className = 'msg msg-bot' + (mode === 'clinical' ? ' clinical' : '');

    var disp = data.disposition || '';
    var dispMap = {
      'ANSWER':'disp-ANSWER','EMERGENCY_ESCALATE':'disp-EMERGENCY',
      'UNCERTAIN_ESCALATE':'disp-UNCERTAIN','INSUFFICIENT_EVIDENCE':'disp-INSUFFICIENT',
      'ASK_CLARIFY':'disp-ASK'
    };
    var dispCls = dispMap[disp] || 'disp-ANSWER';

    var html = '<div class="msg-bubble">' + esc(data.answer) + '</div>';
    html += '<span class="msg-disposition ' + dispCls + '">' + esc(disp.replace(/_/g,' ')) + '</span>';

    if (data.dosage) {
      var d = data.dosage;
      var dt = '';
      if (d.dose_range_mg && d.dose_range_mg.length === 2)
        dt = d.dose_range_mg[0] + '\u2013' + d.dose_range_mg[1] + ' mg';
      else if (d.dose_mg != null)
        dt = d.dose_mg + ' mg';
      if (dt)
        html += '<div class="dosage-pill">\u25b6 Dose: ' + dt + (d.medication ? ' \u2014 ' + esc(d.medication) : '') + '</div>';
    }

    if (data.warnings && data.warnings.length) {
      data.warnings.forEach(function(w) {
        html += '<div class="warning-pill">\u26a0 ' + esc(w) + '</div>';
      });
    }

    if (data.citations && data.citations.length) {
      html += '<div class="citations"><strong>Sources (NSTG)</strong>';
      data.citations.forEach(function(c) {
        var line = esc(c.condition || '');
        if (c.section) line += ' &rarr; ' + esc(c.section);
        if (c.subsection) line += ' &rarr; ' + esc(c.subsection);
        if (c.page) line += ' (p.' + c.page + ')';
        html += '<div>' + line + '</div>';
      });
      html += '</div>';
    }

    if (data.interaction_id) {
      var iid = esc(data.interaction_id);
      html += '<div class="feedback-row">'
        + '<button class="feedback-btn" onclick="sendFeedback(\'' + iid + '\',\'up\',this)">Helpful</button>'
        + '<button class="feedback-btn" onclick="sendFeedback(\'' + iid + '\',\'down\',this)">Needs review</button>'
        + '</div>';
    }

    el.innerHTML = html;
    return el;
  }

  async function sendQuery() {
    var query = input.value.trim();
    if (!query || loading) return;
    loading = true;
    sendBtn.disabled = true;
    input.value = '';
    input.style.height = 'auto';

    appendUser(query);
    var loader = appendLoader();

    try {
      var path = currentMode === 'community' ? '/api/community/query' : '/api/clinical/query';
      var res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query, top_k: currentMode === 'community' ? 4 : 5 }),
      });
      if (!res.ok) throw new Error('Server error ' + res.status);
      var data = await res.json();
      loader.replaceWith(buildBotEl(data, currentMode));
    } catch (err) {
      var errEl = document.createElement('div');
      errEl.className = 'msg msg-bot';
      errEl.innerHTML = '<div class="msg-bubble" style="border-color:var(--terracotta-border);color:var(--danger)">Could not reach the server. Please check your connection and try again.</div>';
      loader.replaceWith(errEl);
    } finally {
      loading = false;
      sendBtn.disabled = false;
      input.focus();
      thread.scrollTop = thread.scrollHeight;
    }
  }

  async function sendFeedback(iid, rating, btn) {
    var row = btn.closest('.feedback-row');
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interaction_id: iid, rating: rating }),
      });
      row.innerHTML = '<span style="font-family:system-ui;font-size:0.76rem;color:var(--muted)">'
        + (rating === 'up' ? 'Marked helpful. Thank you.' : 'Flagged for review. Thank you.') + '</span>';
    } catch (_) {
      row.innerHTML = '<span style="font-family:system-ui;font-size:0.76rem;color:var(--muted)">Feedback failed.</span>';
    }
  }

  // Welcome
  (function() {
    var el = document.createElement('div');
    el.className = 'msg msg-bot';
    el.innerHTML = '<div class="msg-bubble">Hello. I answer health questions using the Nigeria Standard Treatment Guidelines.<br><br>'
      + 'Use <strong>Community</strong> for plain-language advice, or <strong>Clinical</strong> for clinician queries with dosing and citations.<br><br>'
      + 'What would you like to know?</div>';
    thread.appendChild(el);
  })();

  switchMode('community');
</script>
</body>
</html>"""


def render_home_page(app_name: str) -> HTMLResponse:
    return HTMLResponse(_HTML.replace("__APP_NAME__", app_name))
