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
  cliStatus: {},
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

function shortPath(p, max = 42) {
  if (!p) return '—';
  return p.length <= max ? p : '…' + p.slice(-(max - 1));
}

function toast(text, kind = 'system') {
  addMessage(kind === 'error' ? 'error' : 'system', text);
}

/* ------------------------------- bootstrap ------------------------------- */

async function boot() {
  const b = await window.deck.bootstrap();
  if (!b.ok) { toast('Failed to start: ' + b.error, 'error'); return; }
  state.config = b.config;
  state.hw = b.hw;
  state.cli = b.cli;
  state.platform = b.platform;
  state.llama = b.llama;
  renderHardwareLine();
  renderRail();
  renderCliRail();
  renderTopbar();
  applyConfigToSettings();
  renderDeck();
  wireChrome();
  window.deck.onEvent(onEvent);
  // Restore the last driver so relaunching the app lands where you left off.
  if (state.config.activeModelId && state.config.models.some((m) => m.id === state.config.activeModelId)) {
    selectDriver({ kind: 'local', modelId: state.config.activeModelId }, { silent: true });
  }
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

    const li = el('li', {
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
      }, '×'));
    list.append(li);
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

/* ------------------------------ driver switch ---------------------------- */

function selectDriver(driver, { silent = false } = {}) {
  state.driver = driver;
  renderRail();
  renderCliRail();
  renderTopbar();
  if (driver.kind === 'local' && driver.modelId) refreshPlan(driver.modelId);
  renderProfileForm();
  if (!silent) $('#input').focus();
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
      : (st === 'error' ? 'failed to load — see Server log' : 'not loaded');
    show('#btnLaunch', st !== 'ready' && st !== 'loading' && st !== 'starting');
    $('#btnLaunch').textContent = 'Load model';
    show('#btnUnload', loaded && st === 'ready');
    show('#btnOpenTerminal', false);
    show('#btnStop', state.busy);
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
    show('#btnStop', !!(sess && sess.busy));
  } else {
    dot.className = 'dot';
    name.textContent = 'No driver selected';
    meta.textContent = 'Pick a local model, or launch Claude Code or Copilot';
    show('#btnLaunch', false); show('#btnUnload', false); show('#btnOpenTerminal', false); show('#btnStop', false);
  }
  $('#btnSend').disabled = state.busy || !d.kind;
  $('#composerHint').textContent = d.kind === 'local'
    ? state.config.approvalMode
    : d.kind ? (d.kind === 'claude' ? state.config.cli.claude.permissionMode : (state.config.cli.copilot.allowAllTools ? 'all tools allowed' : 'tool prompts disabled')) : '';
}

/* ------------------------------- transcript ------------------------------ */

function transcriptEl() { return $('#transcript'); }

function clearEmptyState() {
  const e = $('#emptyState');
  if (e) e.remove();
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
  const output = el('div', { class: 'tool-output', text: ev.autoApproved ? 'running…' : 'waiting for approval…' });
  const args = el('div', { class: 'tool-args', text: JSON.stringify(ev.input || {}, null, 2) });
  const spinner = el('span', { class: 'spinner' });
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
}

function finishToolCard(ev) {
  const entry = state.toolCards.get(ev.id);
  if (!entry) { addMessage('system', ev.name + ': ' + ev.output); return; }
  const stick = atBottom();
  entry.output.textContent = ev.output || '(no output)';
  entry.output.classList.toggle('is-error', !!ev.isError);
  entry.spinner.replaceWith(el('span', { class: 'dot ' + (ev.denied ? 'error' : ev.isError ? 'error' : 'ready') }));
  if (ev.denied) entry.card.classList.add('denied');
  if (ev.ms !== undefined) entry.ms.textContent = ev.ms >= 1000 ? (ev.ms / 1000).toFixed(1) + 's' : ev.ms + 'ms';
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
  scrollDown(true);
}

/* ------------------------------ main events ------------------------------ */

function onEvent(ev) {
  switch (ev.type) {
    /* llama-server lifecycle */
    case 'llama:state':
      state.llama = { ...state.llama, state: ev.state, modelId: ev.modelId, port: ev.port };
      if (ev.error) toast('llama-server: ' + ev.error, 'error');
      if (ev.state === 'ready' && ev.loadMs) toast('Model loaded in ' + (ev.loadMs / 1000).toFixed(1) + 's.');
      renderRail(); renderTopbar();
      break;
    case 'llama:log':
      state.serverLog.push(ev.line);
      if (state.serverLog.length > 500) state.serverLog.shift();
      if ($('.deck-pane[data-pane="log"]').classList.contains('active')) renderLog();
      break;

    /* local agent */
    case 'agent:user': break;                       // already rendered locally
    case 'agent:thinking': setBusy(true); break;
    case 'agent:delta': streamDelta(ev.text); break;
    case 'agent:reasoning': streamReasoning(ev.text); break;
    case 'agent:assistant': endStream(ev.text); break;
    case 'agent:tool_call': addToolCard(ev); break;
    case 'agent:tool_result': finishToolCard(ev); break;
    case 'agent:trimmed': toast('Trimmed older tool output to stay inside the context window.'); break;
    case 'agent:done':
      setBusy(false);
      $('#turnStats').textContent = [
        ev.stats.toolCalls ? ev.stats.toolCalls + ' tool calls' : null,
        ev.stats.tokensPerSec ? ev.stats.tokensPerSec + ' tok/s' : null,
        ev.stats.completionTokens ? ev.stats.completionTokens + ' out' : null,
        ev.stats.elapsedMs ? (ev.stats.elapsedMs / 1000).toFixed(1) + 's' : null,
        ev.stats.hitTurnLimit ? 'hit turn limit' : null,
      ].filter(Boolean).join(' · ');
      break;
    case 'agent:error': endStream(); setBusy(false); addMessage('error', ev.error); break;
    case 'agent:aborted': endStream(); setBusy(false); toast('Turn cancelled.'); break;
    case 'agent:reset': break;

    /* approvals */
    case 'approval:request': showApproval(ev); break;

    /* CLI drivers */
    case 'cli:started':
      state.cliStatus[ev.agent] = { ...(state.cliStatus[ev.agent] || {}), alive: true, cwd: ev.cwd, sessionId: ev.sessionId, busy: false };
      toast(cliName(ev.agent) + ' session started in ' + ev.cwd + (ev.note ? ' (' + ev.note + ')' : ''));
      renderCliRail(); renderTopbar();
      break;
    case 'cli:init':
      state.cliStatus[ev.agent] = { ...(state.cliStatus[ev.agent] || {}), alive: true, sessionId: ev.sessionId, model: ev.model };
      toast(cliName(ev.agent) + ' ready · ' + (ev.model || 'default model') + ' · session ' + String(ev.sessionId || '').slice(0, 8));
      renderCliRail(); renderTopbar();
      break;
    case 'cli:sent':
      state.cliStatus[ev.agent] = { ...(state.cliStatus[ev.agent] || {}), busy: true };
      setBusy(true); renderCliRail(); renderTopbar();
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
      $('#turnStats').textContent = [
        ev.numTurns ? ev.numTurns + ' turns' : null,
        ev.durationMs ? (ev.durationMs / 1000).toFixed(1) + 's' : null,
        typeof ev.costUsd === 'number' ? '$' + ev.costUsd.toFixed(4) : null,
        ev.isError ? 'ended with an error' : null,
      ].filter(Boolean).join(' · ');
      renderCliRail(); renderTopbar();
      break;
    case 'cli:stderr':
      if (/\S/.test(ev.text)) addMessage('system', cliName(ev.agent) + ': ' + ev.text.trim());
      break;
    case 'cli:raw': addMessage('system', ev.text); break;
    case 'cli:error': setBusy(false); addMessage('error', cliName(ev.agent) + ': ' + ev.error); break;
    case 'cli:exit':
      state.cliStatus[ev.agent] = { alive: false, busy: false };
      setBusy(false);
      toast(cliName(ev.agent) + ' session ended' + (ev.code ? ' (exit ' + ev.code + ')' : '') + '.');
      renderCliRail(); renderTopbar();
      break;
    case 'cli:system': case 'cli:other': case 'cli:user_echo': break;

    case 'tool:stream': break;   // live command output lands in the tool card on completion
    default: break;
  }
}

function previewFor(tc) {
  const i = tc.input || {};
  return i.command || i.file_path || i.path || i.pattern || i.description || JSON.stringify(i).slice(0, 160);
}

function cliName(which) { return which === 'claude' ? 'Claude Code' : 'Copilot'; }

function setBusy(busy) {
  state.busy = busy;
  $('#btnSend').disabled = busy || !state.driver.kind;
  $('#btnStop').hidden = !busy;
  $('#activeDot').className = 'dot ' + (busy ? 'busy' : state.driver.kind === 'local'
    ? (state.llama.state === 'ready' ? 'ready' : '') : ((state.cliStatus[state.driver.kind] || {}).alive ? 'ready' : ''));
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

  const res = state.driver.kind === 'local'
    ? await window.deck.agent.send({ text })
    : await window.deck.cli.send({ agent: state.driver.kind, text });

  if (!res.ok) { setBusy(false); addMessage('error', res.error); }
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
  toast('Loading ' + driverLabel() + '…');
  const r = await window.deck.llama.swap({ id });
  if (!r.ok) { addMessage('error', 'Could not load the model: ' + r.error); return false; }
  state.llama = r.status;
  renderRail(); renderTopbar();
  return true;
}

async function launchCli(which) {
  const r = await window.deck.cli.start({ agent: which, cwd: state.config.workspace });
  if (!r.ok) { addMessage('error', r.error); return false; }
  state.cliStatus[which] = r.status;
  renderCliRail(); renderTopbar();
  return true;
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
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
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
  pre.textContent = state.serverLog.length ? state.serverLog.join('\n') : 'No llama-server output yet.';
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
    const row = el('label', { class: 'field row', title: f.hint || '' }, el('span', {}, f.label), control);
    host.append(row);
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
    else await window.deck.cli.interrupt({ agent: state.driver.kind });
    setBusy(false);
  });

  $('#btnNewChat').addEventListener('click', async () => {
    transcriptEl().textContent = '';
    $('#approvalTray').textContent = '';
    state.toolCards.clear();
    state.streaming = null;
    $('#turnStats').textContent = '';
    if (state.driver.kind === 'local') await window.deck.agent.reset();
    else if (state.driver.kind) {
      await window.deck.cli.stop({ agent: state.driver.kind });
      state.cliStatus[state.driver.kind] = { alive: false, busy: false };
      renderCliRail(); renderTopbar();
    }
    toast('New chat. The workspace and driver are unchanged.');
  });

  $('#btnLaunch').addEventListener('click', async () => {
    if (state.driver.kind === 'local') await loadActiveModel();
    else if (state.driver.kind) await launchCli(state.driver.kind);
  });

  $('#btnUnload').addEventListener('click', async () => {
    if (state.driver.kind === 'local') {
      await window.deck.llama.stop();
      toast('Model unloaded; the memory is back.');
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
    else toast('Opened ' + cliName(state.driver.kind) + ' in a terminal (' + r.via + ')'
      + (r.via && state.driver.kind === 'claude' && sess.sessionId ? ', resuming this session' : '') + '.');
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

  /* model library */
  $('#btnAddModel').addEventListener('click', async () => {
    const r = await window.deck.pick.file({ title: 'Choose a GGUF model', filters: [{ name: 'GGUF', extensions: ['gguf'] }] });
    if (!r.ok) return;
    const add = await window.deck.models.add({ modelPath: r.path });
    if (!add.ok) { toast('Could not read that file: ' + add.error, 'error'); return; }
    state.config = add.config;
    renderRail();
    selectDriver({ kind: 'local', modelId: add.model.id });
    toast('Added ' + add.model.name + '.');
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
