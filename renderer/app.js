'use strict';
/* Laguna Deck renderer. Vanilla DOM on purpose: no build step, no framework,
   nothing to update when Electron moves. All model and tool output goes in via
   textContent -- never innerHTML -- so a model that emits markup cannot inject
   anything into the UI. */

const GB = 1024 ** 3;

const state = {
  config: null,
  hw: null,
  cli: null,
  comfy: null,            // detection result
  comfyStatus: null,      // server state
  comfyFlavors: {},
  platform: 'win32',
  llama: { state: 'stopped' },
  driver: { kind: null, modelId: null },   // what the composer talks to
  plan: null,
  planProfile: null,
  busy: false,
  streaming: null,                          // the live assistant bubble
  toolCards: new Map(),
  approvals: new Map(),
  serverLog: [],
  comfyLog: [],
  logView: 'llama',
  activity: [],
  cliStatus: {},
  sessions: [],
  sessionId: null,
  sample: null,                             // latest memory sample
  pendingComfyDir: null,
};

/* ------------------------------- utilities ------------------------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

function fmtBytes(b) {
  if (!b) return '0';
  if (b >= GB) return (b / GB).toFixed(2) + ' GiB';
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(0) + ' MiB';
  return b + ' B';
}

function fmtGBshort(b) { return (b / GB).toFixed(1); }

function shortPath(p, max = 42) {
  if (!p) return '—';
  return p.length <= max ? p : '…' + p.slice(-(max - 1));
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function toast(text, kind = 'system') {
  addMessage(kind === 'error' ? 'error' : 'system', text);
  pushActivity(text);
}

/* ------------------------------- bootstrap ------------------------------- */

async function boot() {
  const b = await window.deck.bootstrap();
  if (!b.ok) { toast('Failed to start: ' + b.error, 'error'); return; }
  state.config = b.config;
  state.hw = b.hw;
  state.cli = b.cli;
  state.comfy = b.comfy;
  state.comfyStatus = b.comfyStatus;
  state.comfyFlavors = b.comfyFlavors || {};
  state.platform = b.platform;
  state.llama = b.llama;
  state.sessions = b.sessions || [];
  state.sessionId = b.session ? b.session.id : null;

  renderHardwareLine();
  renderRail();
  renderCliRail();
  renderComfyRail();
  renderSessions();
  renderTopbar();
  applyConfigToSettings();
  renderDeck();
  renderComfyView();
  wireChrome();
  window.deck.onEvent(onEvent);

  if (b.session) restoreTranscript(b.session);
  // Land where you left off: same driver, same conversation.
  if (state.config.activeModelId && state.config.models.some((m) => m.id === state.config.activeModelId)) {
    selectDriver({ kind: 'local', modelId: state.config.activeModelId }, { silent: true });
  } else if (b.session && b.session.driver && b.session.driver.kind) {
    selectDriver({ kind: b.session.driver.kind, modelId: b.session.driver.modelId }, { silent: true });
  }
  setStatus('Idle');
}

function renderHardwareLine() {
  const hw = state.hw;
  if (!hw) return;
  const bw = hw.bandwidth && hw.bandwidth.gbPerSec ? hw.bandwidth.gbPerSec + ' GB/s' : 'bandwidth unknown';
  $('#hwLine').textContent = hw.totalRamGB + ' GB · ' + bw;
  $('#hwLine').title = [hw.cpuName, hw.gpus.map((g) => g.name).join(', '), hw.bandwidth.basis].filter(Boolean).join('\n');
}

/* --------------------------------- rail --------------------------------- */

function renderRail() {
  const list = $('#modelList');
  list.textContent = '';
  const models = state.config.models || [];
  if (!models.length) {
    list.append(el('li', { class: 'driver-meta rail-empty' }, 'No models added yet.'));
  }
  for (const m of models) {
    const loaded = state.llama.modelId === m.id;
    const dotClass = loaded
      ? (state.llama.state === 'ready' ? 'dot ready' : state.llama.state === 'error' ? 'dot error' : 'dot busy')
      : 'dot';
    const meta = [
      m.meta && m.meta.quant,
      m.meta && m.meta.paramsB ? m.meta.paramsB.toFixed(0) + 'B' : null,
      m.meta && m.meta.isMoE ? 'MoE ' + m.meta.expertUsedCount + '/' + m.meta.expertCount : null,
      fmtBytes(m.meta && m.meta.sizeBytes),
    ].filter(Boolean).join(' · ');

    list.append(el('li', {
      class: 'driver' + (state.driver.kind === 'local' && state.driver.modelId === m.id ? ' active' : ''),
      onclick: () => selectDriver({ kind: 'local', modelId: m.id }),
    },
      el('span', { class: dotClass }),
      el('div', { class: 'driver-body' },
        el('div', { class: 'driver-name' }, m.name, m.isPrimary ? el('span', { class: 'badge' }, 'primary') : null),
        el('div', { class: 'driver-meta', title: m.modelPath }, meta)),
      el('button', {
        class: 'icon-btn', title: 'Remove from the deck',
        onclick: async (e) => {
          e.stopPropagation();
          await window.deck.models.remove({ id: m.id });
          const r = await window.deck.bootstrap();
          state.config = r.config; state.llama = r.llama;
          if (state.driver.modelId === m.id) state.driver = { kind: null, modelId: null };
          renderRail(); renderTopbar(); renderDeck();
        },
      }, '×')));
  }
}

function renderCliRail() {
  const set = (which, dotId, metaId) => {
    const info = state.cli ? state.cli[which] : null;
    const sess = state.cliStatus[which];
    const dot = $(dotId);
    const meta = $(metaId);
    if (!info || !info.installed) {
      dot.className = 'dot absent';
      meta.textContent = 'not installed';
      meta.title = which === 'claude'
        ? 'Install Claude Code, then set its path in Settings.'
        : 'Install the GitHub Copilot CLI, then set its path in Settings.';
      return;
    }
    if (sess && sess.busy) dot.className = 'dot busy';
    else if (sess && sess.alive) dot.className = 'dot ready';
    else dot.className = 'dot';
    const bits = [info.version ? info.version.replace(/^.*?([\d.]+).*$/, 'v$1') : 'installed'];
    if (info.authed === false) bits.push('not signed in');
    if (sess && sess.alive) bits.push(sess.busy ? 'working' : 'session open');
    meta.textContent = bits.join(' · ');
    meta.title = [info.bin, info.detail].filter(Boolean).join('\n');
  };
  set('claude', '#dotClaude', '#metaClaude');
  set('copilot', '#dotCopilot', '#metaCopilot');
  $$('#cliList .driver').forEach((li) => {
    li.classList.toggle('active', state.driver.kind === li.dataset.cli);
    li.onclick = () => selectDriver({ kind: li.dataset.cli, modelId: null });
  });
}

function renderComfyRail() {
  const dot = $('#dotComfy');
  const meta = $('#metaComfy');
  const st = state.comfyStatus || {};
  const info = state.comfy || {};
  if (st.state === 'ready') { dot.className = 'dot ready'; meta.textContent = 'running on :' + st.port; }
  else if (st.state === 'starting' || st.state === 'installing') { dot.className = 'dot busy'; meta.textContent = st.state + '…'; }
  else if (st.state === 'error') { dot.className = 'dot error'; meta.textContent = 'failed — see the log'; }
  else if (info.installed) {
    dot.className = 'dot';
    const models = Object.values(info.models || {}).reduce((a, b) => a + b, 0);
    meta.textContent = 'installed' + (models ? ' · ' + models + ' model files' : ' · no models yet');
  } else { dot.className = 'dot absent'; meta.textContent = 'not installed — one click to set up'; }
  meta.title = info.dir || '';
  $('#comfyRow').classList.toggle('active', state.driver.kind === 'comfy');
  $('#comfyRow').onclick = () => selectDriver({ kind: 'comfy', modelId: null });
}

function renderSessions() {
  const list = $('#sessionList');
  list.textContent = '';
  if (!state.sessions.length) {
    list.append(el('li', { class: 'session-empty' }, 'Conversations you start are saved here.'));
    return;
  }
  for (const s of state.sessions.slice(0, 40)) {
    const current = s.id === state.sessionId;
    list.append(el('li', {
      class: 'session' + (current ? ' current' : ''),
      onclick: () => switchSession(s.id),
      title: s.title,
    },
      el('div', { class: 'session-body' },
        el('div', { class: 'session-title' }, s.title),
        el('div', { class: 'session-meta' },
          [s.messageCount + ' msg', s.toolCount ? s.toolCount + ' tools' : null, ago(s.updatedAt)].filter(Boolean).join(' · '))),
      el('button', {
        class: 'icon-btn', title: 'Delete this session',
        onclick: async (e) => {
          e.stopPropagation();
          const r = await window.deck.sessions.remove({ id: s.id });
          if (!r.ok) return;
          state.sessions = r.sessions;
          if (state.sessionId === s.id) { state.sessionId = r.activeId; clearTranscript(); }
          renderSessions();
        },
      }, '×')));
  }
}

async function switchSession(id) {
  if (id === state.sessionId || state.busy) return;
  const r = await window.deck.sessions.switch({ id });
  if (!r.ok) { toast(r.error, 'error'); return; }
  state.sessionId = id;
  state.sessions = r.sessions;
  clearTranscript();
  restoreTranscript(r.session);
  renderSessions();
  if (r.session.driver && r.session.driver.kind) {
    selectDriver({ kind: r.session.driver.kind, modelId: r.session.driver.modelId }, { silent: true });
  }
  setStatus('Session restored — ' + r.session.title);
}

/* ------------------------------ driver switch ---------------------------- */

function selectDriver(driver, { silent = false } = {}) {
  state.driver = driver;
  renderRail();
  renderCliRail();
  renderComfyRail();
  renderTopbar();
  renderViewMode();
  if (driver.kind === 'local' && driver.modelId) refreshPlan(driver.modelId);
  if (driver.kind === 'comfy') renderComfyView();
  renderProfileForm();
  if (!silent && driver.kind !== 'comfy') $('#input').focus();
}

// ComfyUI is not a chat driver, so it replaces the transcript and composer
// with its own panel rather than pretending to be one.
function renderViewMode() {
  const isComfy = state.driver.kind === 'comfy';
  $('#transcript').hidden = isComfy;
  $('#comfyView').hidden = !isComfy;
  $('#composer').hidden = isComfy;
  $('#approvalTray').hidden = isComfy;
}

function renderTopbar() {
  const d = state.driver;
  const dot = $('#activeDot');
  const name = $('#activeName');
  const meta = $('#activeMeta');
  const show = (id, on) => { const n = $(id); n.hidden = !on; };

  if (d.kind === 'local' && d.modelId) {
    const m = state.config.models.find((x) => x.id === d.modelId);
    const loaded = state.llama.modelId === d.modelId;
    const st = loaded ? state.llama.state : 'stopped';
    dot.className = 'dot ' + (st === 'ready' ? 'ready' : st === 'error' ? 'error' : st === 'stopped' ? '' : 'busy');
    name.textContent = m ? m.name : 'model';
    meta.textContent = loaded
      ? (st === 'ready'
        ? 'loaded on :' + state.llama.port + (state.plan && state.plan.plan.estTokPerSec ? ' · ~' + state.plan.plan.estTokPerSec + ' tok/s expected' : '')
        : st + '…')
      : (st === 'error' ? 'failed to load — see the log' : 'not loaded');
    show('#btnLaunch', st !== 'ready' && st !== 'loading' && st !== 'starting');
    $('#btnLaunch').textContent = 'Load model';
    show('#btnUnload', loaded && st === 'ready');
    $('#btnUnload').textContent = 'Unload';
    show('#btnOpenTerminal', false);
  } else if (d.kind === 'claude' || d.kind === 'copilot') {
    const label = d.kind === 'claude' ? 'Claude Code' : 'GitHub Copilot';
    const info = state.cli ? state.cli[d.kind] : null;
    const sess = state.cliStatus[d.kind];
    dot.className = 'dot ' + (sess && sess.busy ? 'busy' : sess && sess.alive ? 'ready' : info && info.installed ? '' : 'absent');
    name.textContent = label;
    meta.textContent = !info || !info.installed
      ? 'not installed'
      : sess && sess.alive
        ? (sess.cwd + (sess.sessionId ? ' · ' + String(sess.sessionId).slice(0, 8) : '') + (sess.costUsd ? ' · $' + sess.costUsd.toFixed(3) : ''))
        : 'ready to launch in ' + shortPath(state.config.workspace, 36);
    show('#btnLaunch', !!(info && info.installed) && !(sess && sess.alive));
    $('#btnLaunch').textContent = 'Launch ' + label;
    show('#btnUnload', !!(sess && sess.alive));
    $('#btnUnload').textContent = 'End session';
    show('#btnOpenTerminal', !!(info && info.installed));
  } else if (d.kind === 'comfy') {
    const st = state.comfyStatus || {};
    dot.className = 'dot ' + (st.state === 'ready' ? 'ready' : st.state === 'error' ? 'error' : !st.state || st.state === 'stopped' ? '' : 'busy');
    name.textContent = 'ComfyUI';
    meta.textContent = st.state === 'ready' ? st.url : (state.comfy && state.comfy.installed ? shortPath(state.comfy.dir, 40) : 'not installed');
    show('#btnLaunch', false); show('#btnUnload', false); show('#btnOpenTerminal', false);
  } else {
    dot.className = 'dot';
    name.textContent = 'No driver selected';
    meta.textContent = 'Pick a local model, or launch Claude Code, Copilot or ComfyUI';
    show('#btnLaunch', false); show('#btnUnload', false); show('#btnOpenTerminal', false);
  }
  show('#btnStop', state.busy);
  $('#btnSend').disabled = state.busy || !d.kind || d.kind === 'comfy';
  $('#composerHint').textContent = d.kind === 'local'
    ? state.config.approvalMode
    : d.kind === 'claude' ? state.config.cli.claude.permissionMode
      : d.kind === 'copilot' ? (state.config.cli.copilot.allowAllTools ? 'all tools allowed' : 'tool prompts disabled')
        : '';
}

/* --------------------------- status + activity --------------------------- */

function setStatus(text, kind = '') {
  $('#statusText').textContent = text;
  $('#statusStrip').className = kind;
}

function pushActivity(line) {
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.activity.push(stamp + '  ' + String(line).replace(/\s+$/, ''));
  if (state.activity.length > 400) state.activity.shift();
  const panel = $('#activityPanel');
  if (!panel.hidden) {
    const log = $('#activityLog');
    const stick = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 30;
    log.textContent = state.activity.join('\n');
    if (stick) panel.scrollTop = panel.scrollHeight;
  }
}

/* ------------------------------- transcript ------------------------------ */

function transcriptEl() { return $('#transcript'); }

function clearEmptyState() {
  const e = $('#emptyState');
  if (e) e.remove();
}

function clearTranscript() {
  transcriptEl().textContent = '';
  $('#approvalTray').textContent = '';
  state.toolCards.clear();
  state.streaming = null;
  $('#turnStats').textContent = '';
}

// Redraw a saved conversation. Tool cards come back closed with their output
// intact, so scrollback after a restart looks like scrollback before one.
function restoreTranscript(session) {
  if (!session || !session.entries || !session.entries.length) return;
  clearEmptyState();
  for (const e of session.entries) {
    if (e.role === 'user') addMessage('user', e.text);
    else if (e.role === 'assistant') { if (e.text) addMessage('assistant', e.text, { label: e.agent ? cliName(e.agent).toLowerCase() : undefined }); }
    else if (e.role === 'tool') addToolCard({ ...e, restored: true });
    else if (e.role === 'tool_result') finishToolCard(e);
    else if (e.role === 'cli_tool_results') for (const r of e.results || []) finishToolCard({ id: r.id, name: 'result', output: r.output, isError: r.isError });
  }
  scrollDown(true);
}

function atBottom() {
  const t = transcriptEl();
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}

function scrollDown(force = false) {
  const t = transcriptEl();
  if (force || atBottom()) t.scrollTop = t.scrollHeight;
}

function addMessage(role, text, opts = {}) {
  clearEmptyState();
  const stick = atBottom();
  const body = el('div', { class: 'msg-body' });
  if (text) body.textContent = text;
  const msg = el('div', { class: 'msg ' + role },
    el('div', { class: 'msg-head' }, opts.label || roleLabel(role)),
    body);
  transcriptEl().append(msg);
  scrollDown(stick);
  return { msg, body };
}

function roleLabel(role) {
  if (role === 'user') return 'you';
  if (role === 'assistant') return driverLabel();
  if (role === 'error') return 'error';
  return 'deck';
}

function driverLabel() {
  if (state.driver.kind === 'local') {
    const m = state.config.models.find((x) => x.id === state.driver.modelId);
    return m ? m.name : 'local model';
  }
  if (state.driver.kind === 'claude') return 'claude code';
  if (state.driver.kind === 'copilot') return 'copilot';
  return 'deck';
}

function startStream() {
  if (state.streaming) return state.streaming;
  const { body } = addMessage('assistant', '');
  state.streaming = { body, text: '', reasoning: null };
  return state.streaming;
}

function streamDelta(text) {
  const s = startStream();
  const stick = atBottom();
  s.text += text;
  s.body.textContent = s.text;
  scrollDown(stick);
}

function streamReasoning(text) {
  const s = startStream();
  if (!s.reasoning) {
    const det = el('details', { class: 'reasoning' }, el('summary', {}, 'thinking'));
    const pre = el('div', {});
    det.append(pre);
    s.body.before(det);
    s.reasoning = pre;
  }
  s.reasoning.textContent += text;
  scrollDown();
}

function endStream(finalText) {
  if (!state.streaming) {
    if (finalText) addMessage('assistant', finalText);
    return;
  }
  // The final message is authoritative; deltas were a live preview of it.
  if (finalText && finalText.trim() && finalText.trim() !== state.streaming.text.trim()) {
    state.streaming.body.textContent = finalText;
  }
  if (!state.streaming.body.textContent.trim() && !state.streaming.reasoning) {
    state.streaming.body.closest('.msg').remove();
  }
  state.streaming = null;
}

function addToolCard(ev) {
  clearEmptyState();
  const stick = atBottom();
  const tagClass = 'tool-tag tag-' + (ev.risk || 'safe');
  const output = el('div', {
    class: 'tool-output',
    text: ev.restored ? '' : (ev.autoApproved ? 'running…' : 'waiting for approval…'),
  });
  const args = el('div', { class: 'tool-args', text: JSON.stringify(ev.input || {}, null, 2) });
  const spinner = ev.restored ? el('span', { class: 'dot' }) : el('span', { class: 'spinner' });
  const card = el('div', { class: 'tool-card risk-' + (ev.risk || 'safe') },
    el('div', {
      class: 'tool-head',
      onclick: (e) => e.currentTarget.parentElement.classList.toggle('open'),
    },
      spinner,
      el('span', { class: 'tool-name' }, ev.name),
      el('span', { class: 'tool-preview', title: ev.preview || '' }, ev.preview || ''),
      ev.recovered ? el('span', { class: 'tool-tag tag-edit', title: 'recovered from plain text -- this model did not emit a structured tool call' }, 'text') : null,
      el('span', { class: tagClass, title: ev.why || '' }, ev.risk || 'safe'),
      el('span', { class: 'tool-ms' })),
    args, output);
  transcriptEl().append(card);
  state.toolCards.set(ev.id, { card, output, spinner, ms: card.querySelector('.tool-ms') });
  scrollDown(stick);
  if (!ev.restored) pushActivity(ev.name + ': ' + (ev.preview || ''));
}

function finishToolCard(ev) {
  const entry = state.toolCards.get(ev.id);
  if (!entry) { addMessage('system', ev.name + ': ' + (ev.output || '')); return; }
  const stick = atBottom();
  entry.output.textContent = ev.output || '(no output)';
  entry.output.classList.toggle('is-error', !!ev.isError);
  if (entry.spinner && entry.spinner.isConnected) {
    entry.spinner.replaceWith(el('span', { class: 'dot ' + (ev.denied || ev.isError ? 'error' : 'ready') }));
  }
  if (ev.denied) entry.card.classList.add('denied');
  if (ev.ms !== undefined && ev.ms !== null) entry.ms.textContent = ev.ms >= 1000 ? (ev.ms / 1000).toFixed(1) + 's' : ev.ms + 'ms';
  // Errors are the output you actually need to read, so open those by default.
  if (ev.isError) entry.card.classList.add('open');
  scrollDown(stick);
}

/* ------------------------------- approvals ------------------------------- */

function showApproval(req) {
  const tray = $('#approvalTray');
  const decide = async (decision) => {
    node.remove();
    state.approvals.delete(req.id);
    await window.deck.agent.approve({ id: req.id, decision });
    setStatus(decision === 'deny' ? 'Denied — the model will adapt'
      : decision === 'abort' ? 'Cancelling…' : 'Approved — working…', 'busy');
  };
  const node = el('div', { class: 'approval' + (req.risk === 'destructive' ? ' destructive' : '') },
    el('div', { class: 'approval-head' },
      el('b', {}, req.name),
      el('span', { class: 'approval-why' }, req.risk === 'destructive' ? 'looks destructive: ' + req.why : req.why)),
    el('div', { class: 'approval-cmd' }, req.preview || JSON.stringify(req.input, null, 2)),
    el('div', { class: 'approval-actions' },
      el('button', { class: 'pill-btn primary', onclick: () => decide('allow') }, 'Allow once'),
      req.risk === 'destructive' ? null
        : el('button', { class: 'pill-btn', onclick: () => decide('always') }, 'Allow ' + req.name + ' this session'),
      el('button', { class: 'pill-btn', onclick: () => decide('deny') }, 'Deny'),
      el('button', { class: 'pill-btn danger', onclick: () => decide('abort') }, 'Cancel turn')));
  tray.append(node);
  state.approvals.set(req.id, node);
  setStatus('Waiting for your approval — ' + req.name, 'busy');
  scrollDown(true);
}

/* ------------------------------ main events ------------------------------ */

function onEvent(ev) {
  switch (ev.type) {
    /* live memory */
    case 'monitor:sample': state.sample = ev.sample; renderMemory(); break;

    /* llama-server lifecycle */
    case 'llama:state':
      state.llama = { ...state.llama, state: ev.state, modelId: ev.modelId, port: ev.port };
      if (ev.error) { toast('llama-server: ' + ev.error, 'error'); setStatus('Model failed to load', 'error'); }
      if (ev.state === 'loading') setStatus('Loading model into memory…', 'busy');
      if (ev.state === 'ready') {
        setStatus('Model ready' + (ev.loadMs ? ' (' + (ev.loadMs / 1000).toFixed(1) + 's)' : ''));
        pushActivity('model ready on :' + ev.port);
      }
      if (ev.state === 'stopped') setStatus('Model unloaded');
      renderRail(); renderTopbar();
      break;
    case 'llama:log':
      state.serverLog.push(ev.line);
      if (state.serverLog.length > 500) state.serverLog.shift();
      if (/error|failed|cannot|unable/i.test(ev.line)) pushActivity('llama-server: ' + ev.line);
      if (state.logView === 'llama' && $('.deck-pane[data-pane="log"]').classList.contains('active')) renderLog();
      break;

    /* local agent */
    case 'agent:user': break;                       // already rendered locally
    case 'agent:thinking': setBusy(true); setStatus('Thinking…', 'busy'); break;
    case 'agent:delta': streamDelta(ev.text); setStatus('Writing…', 'busy'); break;
    case 'agent:reasoning': streamReasoning(ev.text); break;
    case 'agent:assistant': endStream(ev.text); break;
    case 'agent:tool_call': addToolCard(ev); setStatus('Running ' + ev.name + '…', 'busy'); break;
    case 'agent:tool_result': finishToolCard(ev); break;
    case 'agent:trimmed': pushActivity('trimmed older tool output to fit the context window'); break;
    case 'agent:done':
      setBusy(false);
      setStatus('Done');
      $('#turnStats').textContent = [
        ev.stats.toolCalls ? ev.stats.toolCalls + ' tool calls' : null,
        ev.stats.tokensPerSec ? ev.stats.tokensPerSec + ' tok/s' : null,
        ev.stats.completionTokens ? ev.stats.completionTokens + ' out' : null,
        ev.stats.elapsedMs ? (ev.stats.elapsedMs / 1000).toFixed(1) + 's' : null,
        ev.stats.hitTurnLimit ? 'hit turn limit' : null,
      ].filter(Boolean).join(' · ');
      refreshSessions();
      break;
    case 'agent:error': endStream(); setBusy(false); addMessage('error', ev.error); setStatus(ev.error, 'error'); break;
    case 'agent:aborted': endStream(); setBusy(false); setStatus('Cancelled'); break;
    case 'agent:reset': break;

    /* approvals */
    case 'approval:request': showApproval(ev); break;

    /* CLI drivers */
    case 'cli:started':
      state.cliStatus[ev.agent] = { ...(state.cliStatus[ev.agent] || {}), alive: true, cwd: ev.cwd, sessionId: ev.sessionId, busy: false };
      setStatus(cliName(ev.agent) + ' session started in ' + ev.cwd);
      pushActivity(cliName(ev.agent) + ' started' + (ev.note ? ' (' + ev.note + ')' : ''));
      renderCliRail(); renderTopbar(); refreshSessions();
      break;
    case 'cli:init':
      state.cliStatus[ev.agent] = { ...(state.cliStatus[ev.agent] || {}), alive: true, sessionId: ev.sessionId, model: ev.model };
      setStatus(cliName(ev.agent) + ' ready · ' + (ev.model || 'default model'));
      renderCliRail(); renderTopbar();
      break;
    case 'cli:sent':
      state.cliStatus[ev.agent] = { ...(state.cliStatus[ev.agent] || {}), busy: true };
      setBusy(true); setStatus(cliName(ev.agent) + ' is working…', 'busy');
      renderCliRail(); renderTopbar();
      break;
    case 'cli:delta': streamDelta(ev.text); break;
    case 'cli:reasoning': streamReasoning(ev.text); break;
    case 'cli:assistant':
      endStream(ev.text);
      for (const tc of ev.toolCalls || []) {
        addToolCard({ id: tc.id, name: tc.name, input: tc.input, preview: previewFor(tc), risk: 'edit', why: 'run by ' + cliName(ev.agent), autoApproved: true });
      }
      break;
    case 'cli:tool_results':
      for (const r of ev.results || []) finishToolCard({ id: r.id, name: 'result', output: r.output, isError: r.isError });
      break;
    case 'cli:result':
      endStream(ev.text);
      state.cliStatus[ev.agent] = { ...(state.cliStatus[ev.agent] || {}), busy: false, costUsd: ev.costUsd || (state.cliStatus[ev.agent] || {}).costUsd };
      setBusy(false);
      setStatus(ev.isError ? cliName(ev.agent) + ' ended with an error' : 'Done', ev.isError ? 'error' : '');
      $('#turnStats').textContent = [
        ev.numTurns ? ev.numTurns + ' turns' : null,
        ev.durationMs ? (ev.durationMs / 1000).toFixed(1) + 's' : null,
        typeof ev.costUsd === 'number' ? '$' + ev.costUsd.toFixed(4) : null,
      ].filter(Boolean).join(' · ');
      renderCliRail(); renderTopbar(); refreshSessions();
      break;
    case 'cli:stderr': if (/\S/.test(ev.text)) pushActivity(cliName(ev.agent) + ': ' + ev.text.trim()); break;
    case 'cli:raw': pushActivity(ev.text); break;
    case 'cli:error': setBusy(false); addMessage('error', cliName(ev.agent) + ': ' + ev.error); setStatus(ev.error, 'error'); break;
    case 'cli:exit':
      state.cliStatus[ev.agent] = { alive: false, busy: false };
      setBusy(false);
      setStatus(cliName(ev.agent) + ' session ended' + (ev.code ? ' (exit ' + ev.code + ')' : ''));
      renderCliRail(); renderTopbar();
      break;
    case 'cli:system': case 'cli:other': case 'cli:user_echo': break;

    /* ComfyUI */
    case 'comfy:state':
      state.comfyStatus = { ...(state.comfyStatus || {}), state: ev.state, port: ev.port, dir: ev.dir, error: ev.error };
      if (ev.state === 'ready') { setStatus('ComfyUI is running on :' + ev.port); pushActivity('ComfyUI ready on port ' + ev.port); }
      if (ev.state === 'error') setStatus('ComfyUI: ' + ev.error, 'error');
      renderComfyRail(); renderTopbar(); renderComfyView();
      break;
    case 'comfy:log':
      state.comfyLog.push(ev.line);
      if (state.comfyLog.length > 600) state.comfyLog.shift();
      renderComfyLog();
      if (state.logView === 'comfy' && $('.deck-pane[data-pane="log"]').classList.contains('active')) renderLog();
      break;

    case 'tool:stream': break;   // live command output lands in the tool card on completion
    default: break;
  }
}

function previewFor(tc) {
  const i = tc.input || {};
  return i.command || i.file_path || i.path || i.pattern || i.description || JSON.stringify(i).slice(0, 160);
}

function cliName(which) {
  return which === 'claude' ? 'Claude Code' : which === 'copilot' ? 'Copilot' : 'ComfyUI';
}

function setBusy(busy) {
  state.busy = busy;
  $('#btnSend').disabled = busy || !state.driver.kind || state.driver.kind === 'comfy';
  $('#btnStop').hidden = !busy;
  $('#activeDot').className = 'dot ' + (busy ? 'busy' : state.driver.kind === 'local'
    ? (state.llama.state === 'ready' ? 'ready' : '') : ((state.cliStatus[state.driver.kind] || {}).alive ? 'ready' : ''));
}

async function refreshSessions() {
  const r = await window.deck.sessions.list();
  if (!r.ok) return;
  state.sessions = r.sessions;
  state.sessionId = r.activeId;
  renderSessions();
}

/* --------------------------------- send --------------------------------- */

async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || state.busy) return;
  if (!state.driver.kind) { toast('Pick a driver first.'); return; }

  if (state.driver.kind === 'local') {
    if (state.llama.state !== 'ready' || state.llama.modelId !== state.driver.modelId) {
      const ok = await loadActiveModel();
      if (!ok) return;
    }
  } else {
    const sess = state.cliStatus[state.driver.kind];
    if (!sess || !sess.alive) {
      const started = await launchCli(state.driver.kind);
      if (!started) return;
    }
  }

  input.value = '';
  autosize(input);
  addMessage('user', text);
  $('#turnStats').textContent = '';
  setBusy(true);
  setStatus('Sending…', 'busy');

  const res = state.driver.kind === 'local'
    ? await window.deck.agent.send({ text })
    : await window.deck.cli.send({ agent: state.driver.kind, text });

  if (!res.ok) { setBusy(false); addMessage('error', res.error); setStatus(res.error, 'error'); }
  refreshSessions();
}

async function loadActiveModel() {
  const id = state.driver.modelId;
  if (!id) return false;
  if (!state.config.llamaServerPath) {
    toast('Set the llama-server path in Settings first.', 'error');
    openSettings();
    return false;
  }
  // Warn before launching something the planner says will not fit, rather than
  // letting the user watch llama-server die 40 seconds in.
  if (state.plan && state.plan.plan && !state.plan.plan.fits) {
    const over = (state.plan.plan.overflow / GB).toFixed(1);
    addMessage('system', 'Loading anyway: the plan is ' + over + ' GiB over the GPU budget. If it fails or crawls, apply the Deck panel’s suggestions.');
  }
  setStatus('Loading ' + driverLabel() + '…', 'busy');
  const r = await window.deck.llama.swap({ id });
  if (!r.ok) { addMessage('error', 'Could not load the model: ' + r.error); setStatus(r.error, 'error'); return false; }
  state.llama = r.status;
  renderRail(); renderTopbar();
  return true;
}

async function launchCli(which) {
  setStatus('Launching ' + cliName(which) + '…', 'busy');
  const r = await window.deck.cli.start({ agent: which, cwd: state.config.workspace });
  if (!r.ok) { addMessage('error', r.error); setStatus(r.error, 'error'); return false; }
  state.cliStatus[which] = r.status;
  if (r.sessions) { state.sessions = r.sessions; renderSessions(); }
  renderCliRail(); renderTopbar();
  return true;
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}

/* ------------------------------ memory views ----------------------------- */

function renderMemory() {
  const s = state.sample;
  if (!s) return;
  const procBytes = Object.values(s.procs || {}).reduce((n, p) => n + (p.rssBytes || 0), 0);
  const usedPct = (s.usedBytes / s.totalBytes) * 100;
  const procPct = (procBytes / s.totalBytes) * 100;
  const level = usedPct > 92 ? 'critical' : usedPct > 80 ? 'high' : '';

  // rail strip
  const bar = $('.ram-bar');
  bar.className = 'ram-bar ' + level;
  $('#ramFill').style.width = usedPct.toFixed(1) + '%';
  $('#ramModel').style.width = procPct.toFixed(1) + '%';
  $('#ramText').textContent = fmtGBshort(s.usedBytes) + ' / ' + fmtGBshort(s.totalBytes) + ' GB';
  $('#ramModelText').textContent = procBytes ? fmtGBshort(procBytes) + ' GB loaded' : '';
  drawSpark($('#ramSpark'), s.history, s.totalBytes, 26);

  // deck system pane
  $('#sysNums').textContent = fmtBytes(s.usedBytes) + ' / ' + fmtBytes(s.totalBytes) + '  (' + s.usedPct + '%)'
    + (s.history.length < 6 ? '  · collecting' : '');
  $('.gauge').className = 'gauge ' + level;
  $('#sysFill').style.width = usedPct.toFixed(1) + '%';
  $('#sysModelFill').style.width = procPct.toFixed(1) + '%';
  drawSpark($('#sysSpark'), s.history, s.totalBytes, 56, {
    marker: state.plan ? state.plan.plan.budgetBytes : null,
    markerLabel: 'GPU budget',
  });

  const grid = $('#procGrid');
  grid.textContent = '';
  const rows = [
    ['Free', fmtBytes(s.freeBytes)],
    ...Object.entries(s.procs || {}).map(([name, p]) => [name + ' (pid ' + p.pid + ')', fmtBytes(p.rssBytes)]),
  ];
  if (rows.length === 1) rows.push(['Deck processes', 'none running']);
  for (const [k, v] of rows) grid.append(el('dt', {}, k), el('dd', {}, v));

  const gpuBlock = $('#gpuBlock');
  gpuBlock.textContent = '';
  if (s.gpu) {
    const pct = (s.gpu.usedBytes / s.gpu.totalBytes) * 100;
    const fill = el('div', { class: 'gauge-fill' });
    fill.style.width = pct.toFixed(1) + '%';
    gpuBlock.append(el('div', { class: 'gpu-block' },
      el('div', {}, 'Dedicated VRAM (' + s.gpu.source + ')'),
      el('div', { class: 'gauge' }, fill),
      el('div', { class: 'deck-note' }, fmtBytes(s.gpu.usedBytes) + ' / ' + fmtBytes(s.gpu.totalBytes))));
  }

  $('#sysNote').textContent = state.hw && state.hw.unified
    ? 'This machine shares one memory pool between CPU and GPU, so the bar above is the real constraint: whatever a model holds is RAM Windows cannot use. Unload between models rather than hoping the driver reclaims it.'
    : 'System RAM. Dedicated VRAM is reported separately when a vendor tool is available.';
}

// A thin filled area chart. No library: it is two fills and a line, and drawing
// it by hand keeps the app dependency-free.
function drawSpark(canvas, history, total, height, opts = {}) {
  if (!canvas || !history || history.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, height);

  const pts = history.slice(-90);
  const x = (i) => (i / Math.max(1, pts.length - 1)) * w;
  const y = (v) => height - (v / total) * height;

  ctx.beginPath();
  ctx.moveTo(0, height);
  pts.forEach((p, i) => ctx.lineTo(x(i), y(p.usedBytes)));
  ctx.lineTo(w, height);
  ctx.closePath();
  ctx.fillStyle = 'rgba(59, 74, 99, 0.55)';
  ctx.fill();

  // the share held by the deck's own processes
  ctx.beginPath();
  ctx.moveTo(0, height);
  pts.forEach((p, i) => ctx.lineTo(x(i), y(p.modelBytes || 0)));
  ctx.lineTo(w, height);
  ctx.closePath();
  ctx.fillStyle = 'rgba(29, 127, 120, 0.75)';
  ctx.fill();

  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.usedBytes)) : ctx.moveTo(x(i), y(p.usedBytes))));
  ctx.strokeStyle = '#8fa2bd';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Where the GPU budget sits on the same axis, so "will it fit" and "what is
  // in use right now" can be read against each other.
  if (opts.marker && opts.marker < total) {
    const my = y(opts.marker);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, my);
    ctx.lineTo(w, my);
    ctx.strokeStyle = 'rgba(139, 127, 245, 0.8)';
    ctx.stroke();
    ctx.setLineDash([]);
    if (opts.markerLabel && my > 10) {
      ctx.fillStyle = 'rgba(139, 127, 245, 0.9)';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(opts.markerLabel, 2, my - 3);
    }
  }
  ctx.restore();
}

/* ------------------------------- deck panel ------------------------------ */

async function refreshPlan(modelId, overrides) {
  const r = await window.deck.models.plan({ id: modelId, overrides });
  if (!r.ok) { state.plan = null; renderDeck(); return; }
  state.plan = r;
  state.planProfile = r.profile;
  renderDeck();
  renderTopbar();
}

function renderDeck() {
  renderBudget();
  renderLog();
  renderMemory();
}

function renderBudget() {
  const grid = $('#statGrid');
  const advice = $('#adviceList');
  grid.textContent = '';
  advice.textContent = '';

  const hw = state.hw || {};
  $('#hwNote').textContent = [
    hw.cpuName,
    hw.gpus && hw.gpus.length ? hw.gpus.map((g) => g.name).join(', ') : null,
    hw.bandwidth && hw.bandwidth.gbPerSec
      ? 'Memory bandwidth ≈ ' + hw.bandwidth.gbPerSec + ' GB/s (' + hw.bandwidth.basis + '). Decode speed is bounded by this, not by compute.'
      : 'Memory bandwidth unknown, so throughput estimates are omitted.',
  ].filter(Boolean).join(' — ');

  if (!state.plan) {
    $('#budgetNums').textContent = '—';
    for (const seg of ['#segWeights', '#segKV', '#segOverhead']) $(seg).style.width = '0%';
    grid.append(el('dt', {}, 'No local model selected'), el('dd', {}, '—'));
    return;
  }

  const p = state.plan.plan;
  const budget = p.budgetBytes;
  const pct = (b) => Math.max(0, Math.min(100, (b / budget) * 100));
  $('#segWeights').style.width = pct(p.modelBytes - p.offloadedExpertBytes) + '%';
  $('#segKV').style.width = pct(p.kvBytes) + '%';
  $('#segOverhead').style.width = pct(p.overheadBytes) + '%';
  $('#meter').classList.toggle('over', !p.fits);
  $('#budgetNums').textContent = fmtBytes(p.gpuBytes) + ' / ' + fmtBytes(budget);

  const m = state.config.models.find((x) => x.id === state.plan.modelId);
  const meta = (m && m.meta) || {};
  const rows = [
    ['Model file', fmtBytes(p.modelBytes)],
    meta.isMoE ? ['Experts', meta.expertUsedCount + ' of ' + meta.expertCount + ' per token'] : ['Type', 'dense'],
    ['Resident weights', fmtBytes(p.modelBytes - p.offloadedExpertBytes)],
    p.offloadedExpertBytes ? ['Experts in CPU memory', fmtBytes(p.offloadedExpertBytes)] : null,
    ['KV cache', fmtBytes(p.kvBytes) + ' @ ' + state.planProfile.ctx + ' ctx'],
    ['Compute buffers', fmtBytes(p.overheadBytes)],
    ['Fits budget', p.fits ? 'yes' : 'no, over by ' + fmtBytes(p.overflow)],
    ['Read per token', fmtBytes(p.activeBytesPerToken)],
    p.estTokPerSec ? ['Expected decode', '≈ ' + p.estTokPerSec + ' tok/s'] : null,
    p.offloadedExpertBytes && p.estTokPerSecResident ? ['If fully resident', '≈ ' + p.estTokPerSecResident + ' tok/s'] : null,
  ].filter(Boolean);
  for (const [k, v] of rows) {
    grid.append(el('dt', {}, k), el('dd', { class: k === 'Fits budget' ? (p.fits ? 'good' : 'bad') : '' }, v));
  }

  for (const a of p.advice) {
    const node = el('div', { class: 'advice ' + a.level }, a.text);
    if (a.apply) {
      node.append(el('button', {
        class: 'pill-btn apply-btn',
        onclick: async () => {
          const next = { ...state.planProfile, ...a.apply };
          await window.deck.models.update({ id: state.plan.modelId, patch: { profile: a.apply } });
          const b = await window.deck.bootstrap();
          state.config = b.config;
          await refreshPlan(state.plan.modelId, next);
          renderProfileForm();
        },
      }, 'Apply'));
    }
    advice.append(node);
  }
}

function renderLog() {
  const pre = $('#serverLog');
  const lines = state.logView === 'comfy' ? state.comfyLog : state.serverLog;
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
  pre.textContent = lines.length
    ? lines.join('\n')
    : (state.logView === 'comfy' ? 'ComfyUI has not been started from the deck yet.' : 'No llama-server output yet.');
  if (stick) pre.scrollTop = pre.scrollHeight;
}

/* ----------------------------- profile editor ---------------------------- */

const PROFILE_FIELDS = [
  { group: 'Context and cache' },
  { key: 'ctx', label: 'context length', type: 'number', step: 1024, hint: 'Tokens. The KV cache scales linearly with this.' },
  { key: 'cacheTypeK', label: 'KV cache K', type: 'select', options: ['f16', 'q8_0', 'q5_1', 'q4_0'] },
  { key: 'cacheTypeV', label: 'KV cache V', type: 'select', options: ['f16', 'q8_0', 'q5_1', 'q4_0'] },
  { key: 'flashAttn', label: 'flash attention', type: 'select', options: ['on', 'off', 'auto'], hint: 'auto omits the flag, for older llama.cpp builds.' },
  { group: 'Offload' },
  { key: 'gpuLayers', label: '-ngl (GPU layers)', type: 'number', step: 1, hint: '99 means every layer. On unified memory, keep it high.' },
  { key: 'cpuMoe', label: '--n-cpu-moe', type: 'number', step: 1, hint: 'Layers whose experts stay in CPU memory. The cheapest thing to offload on an MoE.' },
  { key: 'cpuMoeAll', label: '--cpu-moe (all experts)', type: 'checkbox' },
  { group: 'Throughput' },
  { key: 'batch', label: '-b (batch)', type: 'number', step: 256 },
  { key: 'ubatch', label: '-ub (micro-batch)', type: 'number', step: 128, hint: 'Bigger is faster at prompt processing and costs compute buffer.' },
  { key: 'threads', label: '-t (threads)', type: 'number', step: 1 },
  { key: 'parallel', label: '--parallel slots', type: 'number', step: 1 },
  { key: 'mlock', label: '--mlock', type: 'checkbox', hint: 'Pin weights in RAM so the OS cannot page them out.' },
  { key: 'noMmap', label: '--no-mmap', type: 'checkbox' },
  { key: 'jinja', label: '--jinja (tool calling)', type: 'checkbox', hint: 'Required for the model to emit structured tool calls.' },
  { group: 'Speculative decoding' },
  { key: 'draftModelPath', label: 'draft model', type: 'path', hint: 'A small model that proposes tokens the big one verifies. Pure win when bandwidth-bound.' },
  { key: 'draftMax', label: '--draft-max', type: 'number', step: 1 },
  { group: 'Server' },
  { key: 'port', label: 'port', type: 'number', step: 1 },
];

function renderProfileForm() {
  const host = $('#profileForm');
  host.textContent = '';
  if (state.driver.kind !== 'local' || !state.plan) {
    host.append(el('p', { class: 'deck-note' }, 'Select a local model to edit its launch profile.'));
    return;
  }
  const profile = { ...state.planProfile };
  const modelId = state.plan.modelId;

  const onChange = async (key, value) => {
    profile[key] = value;
    await window.deck.models.update({ id: modelId, patch: { profile: { [key]: value } } });
    const b = await window.deck.bootstrap();
    state.config = b.config;
    await refreshPlan(modelId, profile);
    renderProfileForm();
  };

  for (const f of PROFILE_FIELDS) {
    if (f.group) { host.append(el('h4', {}, f.group)); continue; }
    const value = profile[f.key];
    let control;
    if (f.type === 'number') {
      control = el('input', { type: 'number', step: f.step || 1, value: value === null || value === undefined ? '' : value });
      control.addEventListener('change', () => onChange(f.key, control.value === '' ? null : Number(control.value)));
    } else if (f.type === 'checkbox') {
      control = el('input', { type: 'checkbox' });
      control.checked = !!value;
      control.addEventListener('change', () => onChange(f.key, control.checked));
    } else if (f.type === 'select') {
      control = el('select', {}, ...f.options.map((o) => el('option', { value: o, selected: o === value }, o)));
      control.addEventListener('change', () => onChange(f.key, control.value));
    } else if (f.type === 'path') {
      control = el('button', { class: 'path-btn', title: value || 'none' }, value ? shortPath(value, 28) : 'none');
      control.addEventListener('click', async () => {
        const r = await window.deck.pick.file({ title: 'Choose a draft model', filters: [{ name: 'GGUF', extensions: ['gguf'] }] });
        if (r.ok) onChange(f.key, r.path);
        else if (value) onChange(f.key, null);
      });
    }
    host.append(el('label', { class: 'field row', title: f.hint || '' }, el('span', {}, f.label), control));
  }

  host.append(el('h4', {}, 'Command line'));
  host.append(el('div', { class: 'cmdline' }, state.plan.commandPreview));
  const envKeys = Object.keys(state.plan.env || {});
  if (envKeys.length) {
    host.append(el('div', { class: 'cmdline' }, envKeys.map((k) => k + '=' + state.plan.env[k]).join('\n')));
  }
  host.append(el('div', { class: 'profile-actions' },
    el('button', { class: 'pill-btn primary', onclick: () => loadActiveModel() }, 'Load with these settings'),
    el('button', { class: 'pill-btn', onclick: async () => { await window.deck.llama.stop(); } }, 'Unload')));
  host.append(el('p', { class: 'deck-note' },
    'Changes save as you make them and take effect on the next load. Anything the deck does not expose can go in extraArgs in config.json.'));
}

/* ------------------------------- ComfyUI view ---------------------------- */

function renderComfyView() {
  const info = state.comfy || {};
  const st = state.comfyStatus || {};
  const stateEl = $('#comfyState');
  const running = st.state === 'ready';
  const working = st.state === 'starting' || st.state === 'installing';

  stateEl.textContent = running ? 'running on port ' + st.port
    : st.state === 'installing' ? 'installing…'
      : st.state === 'starting' ? 'starting…'
        : st.state === 'error' ? 'error'
          : info.installed ? 'installed, not running' : 'not installed';
  stateEl.className = 'comfy-state ' + (running ? 'ready' : st.state === 'error' ? 'error' : working ? 'working' : '');

  $('#comfyBlurb').textContent = info.installed
    ? 'Image generation, running locally. The deck starts and stops the server and keeps its memory use on the same gauge as everything else; the interface itself opens in a browser or in a deck window.'
    : 'ComfyUI is the node-based image generator. The deck can set it up for you: it clones the repo, builds a private Python environment beside it, and installs a torch build that matches this machine. Nothing is installed system-wide.';

  $('#comfyPathRow').hidden = !info.installed;
  $('#btnComfyDir').textContent = info.dir ? shortPath(info.dir, 40) : 'choose…';
  $('#btnComfyDir').title = info.dir || '';
  $('#comfyPort').value = (state.config.comfy && state.config.comfy.port) || st.port || 8188;

  $('#btnComfyStart').hidden = !info.installed || running || working;
  $('#btnComfyOpen').hidden = !running;
  $('#btnComfyOpenApp').hidden = !running;
  $('#btnComfyStop').hidden = !running && !working;

  const install = $('#comfyInstall');
  install.hidden = !!info.installed;
  if (!info.installed) {
    $('#btnComfyInstallDir').textContent = shortPath(state.pendingComfyDir || info.suggestedDir || '', 40);
    const sel = $('#comfyFlavor');
    if (!sel.options.length) {
      for (const [key, f] of Object.entries(state.comfyFlavors)) {
        sel.append(el('option', { value: key, selected: key === (state.config.comfy && state.config.comfy.flavor) }, f.label));
      }
    }
    const f = state.comfyFlavors[sel.value];
    const missing = [];
    if (info.git === false) missing.push('git is not installed');
    if (!info.systemPython) missing.push('Python is not installed');
    $('#comfyFlavorNote').textContent = missing.length
      ? missing.join(' · ') + ' — install those first, then come back.'
      : (f ? f.note : '');
    $('#btnComfyInstall').disabled = missing.length > 0 || working;
  }

  const stats = $('#comfyStats');
  if (running && st.stats) {
    const dev = (st.stats.devices || [])[0];
    stats.hidden = false;
    stats.textContent = dev
      ? dev.name + ' — VRAM ' + fmtBytes(dev.vram_total - dev.vram_free) + ' used of ' + fmtBytes(dev.vram_total)
      : JSON.stringify(st.stats.system || {});
  } else stats.hidden = true;

  renderComfyLog();
}

function renderComfyLog() {
  const pre = $('#comfyLog');
  if (!pre) return;
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
  pre.textContent = state.comfyLog.length ? state.comfyLog.slice(-300).join('\n') : '';
  pre.hidden = !state.comfyLog.length;
  if (stick) pre.scrollTop = pre.scrollHeight;
}

async function refreshComfy() {
  const r = await window.deck.comfy.detect();
  if (!r.ok) return;
  state.comfy = r.comfy;
  state.comfyStatus = r.status;
  state.comfyFlavors = r.flavors || state.comfyFlavors;
  renderComfyRail();
  if (state.driver.kind === 'comfy') renderComfyView();
}

/* -------------------------------- settings ------------------------------- */

function applyConfigToSettings() {
  const c = state.config;
  $('#btnWorkspace').textContent = shortPath(c.workspace, 30);
  $('#btnWorkspace').title = c.workspace || '';
  $('#approvalMode').value = c.approvalMode;
  $('#btnLlamaPath').textContent = c.llamaServerPath ? shortPath(c.llamaServerPath, 34) : 'not set';
  $('#btnLlamaPath').title = c.llamaServerPath || '';
  $('#llamaBackend').value = c.llamaBackend;
  $('#gpuBudget').value = c.gpuBudgetGB || (state.hw ? state.hw.suggestedGpuBudgetGB : '');
  $('#budgetHint').textContent = state.hw
    ? 'This box reports ' + state.hw.totalRamGB + ' GB of RAM' +
      (state.hw.unified
        ? '. On unified memory the GPU share is a driver setting (AMD Software → Performance → Tuning → Variable Graphics Memory); set this to match it, leaving headroom for Windows.'
        : '.')
    : '';
  $('#btnClaudeBin').textContent = c.cli.claude.bin ? shortPath(c.cli.claude.bin, 30) : 'PATH';
  $('#claudeModel').value = c.cli.claude.model || '';
  $('#claudeEffort').value = c.cli.claude.effort || '';
  $('#claudePermission').value = c.cli.claude.permissionMode || 'acceptEdits';
  $('#btnCopilotBin').textContent = c.cli.copilot.bin ? shortPath(c.cli.copilot.bin, 30) : 'PATH';
  $('#copilotModel').value = c.cli.copilot.model || '';
  $('#copilotAllowAll').checked = !!c.cli.copilot.allowAllTools;
  $('#copilotDeny').value = (c.cli.copilot.denyTools || []).join(', ');
  $('#sampTemp').value = c.sampling.temperature;
  $('#sampTopP').value = c.sampling.top_p;
  $('#sampMax').value = c.sampling.max_tokens;
}

async function patchConfig(patch) {
  const r = await window.deck.config.patch({ patch });
  if (!r.ok) { toast('Could not save settings: ' + r.error, 'error'); return; }
  state.config = r.config;
  applyConfigToSettings();
  renderTopbar();
  if (state.driver.kind === 'local' && state.driver.modelId) refreshPlan(state.driver.modelId);
}

function openSettings() { $('#settingsModal').hidden = false; }
function closeSettings() { $('#settingsModal').hidden = true; }

/* --------------------------------- chrome -------------------------------- */

function wireChrome() {
  const input = $('#input');
  input.addEventListener('input', () => autosize(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#btnSend').addEventListener('click', send);

  $('#btnStop').addEventListener('click', async () => {
    if (state.driver.kind === 'local') await window.deck.agent.abort();
    else if (state.driver.kind) await window.deck.cli.interrupt({ agent: state.driver.kind });
    setBusy(false);
    setStatus('Stopped');
  });

  $('#btnNewChat').addEventListener('click', () => startNewSession());
  $('#btnNewSession').addEventListener('click', () => startNewSession());

  $('#btnActivity').addEventListener('click', () => {
    const panel = $('#activityPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      $('#activityLog').textContent = state.activity.join('\n') || 'Nothing yet.';
      panel.scrollTop = panel.scrollHeight;
    }
  });

  $('#btnLaunch').addEventListener('click', async () => {
    if (state.driver.kind === 'local') await loadActiveModel();
    else if (state.driver.kind) await launchCli(state.driver.kind);
  });

  $('#btnUnload').addEventListener('click', async () => {
    if (state.driver.kind === 'local') {
      await window.deck.llama.stop();
      setStatus('Model unloaded — the memory is back');
    } else if (state.driver.kind) {
      await window.deck.cli.stop({ agent: state.driver.kind });
      state.cliStatus[state.driver.kind] = { alive: false, busy: false };
      renderCliRail(); renderTopbar();
    }
  });

  $('#btnOpenTerminal').addEventListener('click', async () => {
    const sess = state.cliStatus[state.driver.kind] || {};
    const r = await window.deck.cli.openTerminal({
      agent: state.driver.kind,
      cwd: state.config.workspace,
      resumeId: state.driver.kind === 'claude' ? sess.sessionId : null,
    });
    if (!r.ok) toast('Could not open a terminal: ' + r.error, 'error');
    else setStatus('Opened ' + cliName(state.driver.kind) + ' in a terminal (' + r.via + ')');
  });

  $('#btnWorkspace').addEventListener('click', async () => {
    const r = await window.deck.pick.directory({ title: 'Choose the workspace folder' });
    if (r.ok) {
      await patchConfig({ workspace: r.path });
      $('#btnWorkspace').textContent = shortPath(r.path, 30);
      toast('Workspace is now ' + r.path + '. Relaunch a CLI session to move it there.');
    }
  });

  $('#approvalMode').addEventListener('change', (e) => patchConfig({ approvalMode: e.target.value }));

  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSettings(); $('#scanModal').hidden = true; }
  });

  $('#btnDeckToggle').addEventListener('click', () => $('#app').classList.toggle('deck-hidden'));

  $$('.deck-tabs .tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.deck-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.deck-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab.dataset.tab));
    if (tab.dataset.tab === 'log') renderLog();
    if (tab.dataset.tab === 'profile') renderProfileForm();
    if (tab.dataset.tab === 'system') renderMemory();
  }));

  $$('.log-switch .chip').forEach((chip) => chip.addEventListener('click', () => {
    state.logView = chip.dataset.log;
    $$('.log-switch .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderLog();
  }));

  /* settings fields */
  $('#btnLlamaPath').addEventListener('click', async () => {
    const r = await window.deck.pick.file({
      title: 'Locate llama-server',
      filters: state.platform === 'win32' ? [{ name: 'Executable', extensions: ['exe'] }] : undefined,
    });
    if (r.ok) patchConfig({ llamaServerPath: r.path });
  });
  $('#llamaBackend').addEventListener('change', (e) => patchConfig({ llamaBackend: e.target.value }));
  $('#gpuBudget').addEventListener('change', (e) => patchConfig({ gpuBudgetGB: Number(e.target.value) || null }));
  $('#btnClaudeBin').addEventListener('click', async () => {
    const r = await window.deck.pick.file({ title: 'Locate the claude binary' });
    if (r.ok) { await patchConfig({ cli: { claude: { bin: r.path } } }); await refreshCli(); }
  });
  $('#claudeModel').addEventListener('change', (e) => patchConfig({ cli: { claude: { model: e.target.value || null } } }));
  $('#claudeEffort').addEventListener('change', (e) => patchConfig({ cli: { claude: { effort: e.target.value || null } } }));
  $('#claudePermission').addEventListener('change', (e) => patchConfig({ cli: { claude: { permissionMode: e.target.value } } }));
  $('#btnCopilotBin').addEventListener('click', async () => {
    const r = await window.deck.pick.file({ title: 'Locate the copilot binary' });
    if (r.ok) { await patchConfig({ cli: { copilot: { bin: r.path } } }); await refreshCli(); }
  });
  $('#copilotModel').addEventListener('change', (e) => patchConfig({ cli: { copilot: { model: e.target.value || null } } }));
  $('#copilotAllowAll').addEventListener('change', (e) => patchConfig({ cli: { copilot: { allowAllTools: e.target.checked } } }));
  $('#copilotDeny').addEventListener('change', (e) => patchConfig({
    cli: { copilot: { denyTools: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } },
  }));
  $('#sampTemp').addEventListener('change', (e) => patchConfig({ sampling: { temperature: Number(e.target.value) } }));
  $('#sampTopP').addEventListener('change', (e) => patchConfig({ sampling: { top_p: Number(e.target.value) } }));
  $('#sampMax').addEventListener('change', (e) => patchConfig({ sampling: { max_tokens: Number(e.target.value) } }));
  $('#btnRevealConfig').addEventListener('click', () => window.deck.config.reveal());

  /* ComfyUI */
  $('#btnComfyStart').addEventListener('click', async () => {
    setStatus('Starting ComfyUI…', 'busy');
    const r = await window.deck.comfy.start({ port: Number($('#comfyPort').value) || 8188 });
    if (!r.ok) { setStatus('ComfyUI: ' + r.error, 'error'); pushActivity('ComfyUI failed to start: ' + r.error); }
    else { state.comfyStatus = r.status; renderComfyRail(); renderComfyView(); }
  });
  $('#btnComfyStop').addEventListener('click', async () => {
    const r = await window.deck.comfy.stop();
    state.comfyStatus = r.status;
    renderComfyRail(); renderComfyView(); setStatus('ComfyUI stopped');
  });
  $('#btnComfyOpen').addEventListener('click', () => window.deck.comfy.open({ inApp: false }));
  $('#btnComfyOpenApp').addEventListener('click', () => window.deck.comfy.open({ inApp: true }));
  $('#btnComfyDir').addEventListener('click', async () => {
    const r = await window.deck.comfy.pickDir();
    if (!r.ok && r.error) toast(r.error, 'error');
    await refreshComfy();
  });
  $('#btnComfyInstallDir').addEventListener('click', async () => {
    const r = await window.deck.pick.directory({ title: 'Where should ComfyUI be installed?' });
    if (!r.ok) return;
    const base = r.path.replace(/[\\/]+$/, '');
    state.pendingComfyDir = /comfyui$/i.test(base) ? base : base + (state.platform === 'win32' ? '\\ComfyUI' : '/ComfyUI');
    renderComfyView();
  });
  $('#comfyFlavor').addEventListener('change', () => renderComfyView());
  $('#btnComfyInstall').addEventListener('click', async () => {
    const dir = state.pendingComfyDir || (state.comfy && state.comfy.suggestedDir);
    const flavor = $('#comfyFlavor').value;
    $('#btnComfyInstall').disabled = true;
    setStatus('Installing ComfyUI — this takes a few minutes', 'busy');
    const r = await window.deck.comfy.install({ dir, flavor });
    $('#btnComfyInstall').disabled = false;
    if (!r.ok) { setStatus('Install failed: ' + r.error, 'error'); return; }
    await patchConfig({ comfy: { dir: r.dir, python: r.python, flavor } });
    await refreshComfy();
    setStatus('ComfyUI installed — press Start');
  });

  /* model library */
  $('#btnAddModel').addEventListener('click', async () => {
    const r = await window.deck.pick.file({ title: 'Choose a GGUF model', filters: [{ name: 'GGUF', extensions: ['gguf'] }] });
    if (!r.ok) return;
    const add = await window.deck.models.add({ modelPath: r.path });
    if (!add.ok) { toast('Could not read that file: ' + add.error, 'error'); return; }
    state.config = add.config;
    renderRail();
    selectDriver({ kind: 'local', modelId: add.model.id });
    setStatus('Added ' + add.model.name);
  });

  $('#btnScanModels').addEventListener('click', async () => {
    const dir = await window.deck.pick.directory({ title: 'Choose a folder of GGUF models' });
    if (!dir.ok) return;
    const r = await window.deck.models.scan({ dir: dir.path });
    if (!r.ok) { toast('Scan failed: ' + r.error, 'error'); return; }
    showScanResults(r);
  });

  $('#btnCloseScan').addEventListener('click', () => { $('#scanModal').hidden = true; });
  $('#scanModal').addEventListener('click', (e) => { if (e.target.id === 'scanModal') $('#scanModal').hidden = true; });

  setInterval(refreshCliStatus, 5000);
  setInterval(() => { if (state.sessions.length) renderSessions(); }, 60000);  // keep "3m ago" honest
  window.addEventListener('resize', () => renderMemory());
}

async function startNewSession() {
  const r = await window.deck.sessions.create({ driver: state.driver });
  if (!r.ok) { toast(r.error, 'error'); return; }
  state.sessionId = r.session.id;
  state.sessions = r.sessions;
  clearTranscript();
  renderSessions();
  setStatus('New session. The workspace and driver are unchanged.');
}

async function refreshCli() {
  const r = await window.deck.cli.detect();
  if (r.ok) { state.cli = r.cli; renderCliRail(); renderTopbar(); }
}

async function refreshCliStatus() {
  const r = await window.deck.cli.status();
  if (!r.ok) return;
  let changed = false;
  for (const [k, v] of Object.entries(r.sessions)) {
    const prev = state.cliStatus[k] || {};
    if (prev.alive !== v.alive || prev.busy !== v.busy) changed = true;
    state.cliStatus[k] = { ...prev, ...v };
  }
  if (changed) { renderCliRail(); renderTopbar(); }
}

function showScanResults(r) {
  const list = $('#scanList');
  list.textContent = '';
  $('#scanDir').textContent = r.dir + ' — ' + r.found.length + ' GGUF file(s)';
  const known = new Set((state.config.models || []).map((m) => m.modelPath));
  if (!r.found.length) list.append(el('li', { class: 'deck-note' }, 'Nothing with a .gguf extension under that folder.'));
  for (const f of r.found) {
    if (f.error) {
      list.append(el('li', { class: 'scan-row bad' },
        el('div', { class: 'scan-body' },
          el('div', { class: 'scan-name' }, f.modelPath.split(/[\\/]/).pop()),
          el('div', { class: 'scan-meta' }, f.error))));
      continue;
    }
    const meta = f.meta || {};
    const already = known.has(f.modelPath);
    const btn = el('button', { class: 'pill-btn' + (already ? '' : ' primary') }, already ? 'added' : 'Add');
    btn.disabled = already;
    btn.addEventListener('click', async () => {
      const add = await window.deck.models.add({ modelPath: f.modelPath });
      if (!add.ok) { toast(add.error, 'error'); return; }
      state.config = add.config;
      btn.disabled = true; btn.textContent = 'added'; btn.classList.remove('primary');
      renderRail();
    });
    list.append(el('li', { class: 'scan-row' },
      el('div', { class: 'scan-body' },
        el('div', { class: 'scan-name', title: f.modelPath }, meta.name || f.modelPath.split(/[\\/]/).pop()),
        el('div', { class: 'scan-meta' }, [
          meta.arch,
          meta.quant,
          meta.isMoE ? 'MoE ' + meta.expertUsedCount + '/' + meta.expertCount : 'dense',
          fmtBytes(meta.sizeBytes),
          meta.contextLength ? meta.contextLength + ' ctx' : null,
        ].filter(Boolean).join(' · '))),
      btn));
  }
  $('#scanModal').hidden = false;
}

// Exposed for the headless smoke check in main.js; handy in devtools too.
window.__deckState = state;

boot();
