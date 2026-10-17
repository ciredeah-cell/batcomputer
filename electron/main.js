'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Config } = require('./lib/config');
const hardware = require('./lib/hardware');
const gguf = require('./lib/gguf');
const planner = require('./lib/planner');
const { LlamaServer, findLlamaServer } = require('./lib/llama');
const tools = require('./lib/tools');
const { LocalAgent } = require('./lib/agent');
const cli = require('./lib/cli-agent');
const { SessionStore } = require('./lib/sessions');
const { Monitor } = require('./lib/monitor');
const comfy = require('./lib/comfy');

const isDev = process.argv.includes('--dev');
const isSmoke = process.env.LAGUNA_SMOKE === '1';

// The smoke check runs against a throwaway profile: it must never read or
// write the real one, and it has to start from the same blank state every time
// or its assertions drift with whatever the last run left behind.
if (isSmoke) {
  const smokeDir = path.join(require('os').tmpdir(), 'laguna-deck-smoke-' + process.pid);
  fs.rmSync(smokeDir, { recursive: true, force: true });
  fs.mkdirSync(smokeDir, { recursive: true });
  app.setPath('userData', smokeDir);
  app.on('quit', () => { try { fs.rmSync(smokeDir, { recursive: true, force: true }); } catch (_) { /* temp dir */ } });
}

let win = null;
let tray = null;
let config = null;
let hw = null;
let llama = null;
let agent = null;
let toolCtx = null;
let sessions = null;
let monitor = null;
let comfyServer = null;
let currentSessionId = null;
const cliSessions = new Map();          // 'claude' | 'copilot' -> session
const pendingApprovals = new Map();     // id -> resolve

/* ------------------------------- plumbing -------------------------------- */

function emit(event) {
  recordEvent(event);
  if (win && !win.isDestroyed()) win.webContents.send('deck:event', event);
}

// Everything the user sees in the transcript is also written to the active
// session, so closing the app is not the same as losing the conversation.
const RECORDERS = {
  'agent:user': (e) => ({ role: 'user', text: e.text }),
  'agent:assistant': (e) => (e.text || (e.toolCalls || []).length
    ? { role: 'assistant', text: e.text, reasoning: e.reasoning || '', toolCalls: e.toolCalls || [] } : null),
  'agent:tool_call': (e) => ({ role: 'tool', id: e.id, name: e.name, input: e.input, preview: e.preview, risk: e.risk, why: e.why, autoApproved: e.autoApproved }),
  'agent:tool_result': (e) => ({ role: 'tool_result', id: e.id, name: e.name, output: e.output, isError: e.isError, denied: e.denied, ms: e.ms }),
  'cli:sent': (e) => ({ role: 'user', text: e.text }),
  'cli:assistant': (e) => (e.text || (e.toolCalls || []).length
    ? { role: 'assistant', text: e.text, toolCalls: e.toolCalls || [], agent: e.agent } : null),
  'cli:tool_results': (e) => ({ role: 'cli_tool_results', results: e.results }),
  'cli:result': (e) => (e.text ? { role: 'assistant', text: e.text, agent: e.agent, final: true } : null),
};

function recordEvent(event) {
  if (!sessions || !currentSessionId) return;
  const make = RECORDERS[event.type];
  if (!make) return;
  try {
    const entry = make(event);
    if (entry) sessions.append(currentSessionId, entry);
  } catch (_) { /* recording must never break the stream */ }
}

function persistAgentHistory() {
  if (!sessions || !currentSessionId || !agent) return;
  sessions.setAgentMessages(currentSessionId, agent.messages);
}

function ensureSession(driver) {
  if (currentSessionId && sessions.load(currentSessionId)) return sessions.load(currentSessionId);
  const s = sessions.create({ driver: driver || { kind: null, modelId: null } });
  currentSessionId = s.id;
  config.patch({ activeSessionId: s.id });
  return s;
}

function buildToolCtx() {
  const cfg = config.get();
  toolCtx = new tools.ToolContext({
    workspace: cfg.workspace || app.getPath('documents'),
    shell: cfg.shell,
    approvalMode: cfg.approvalMode,
    onEvent: emit,
  });
  return toolCtx;
}

function requestApproval(req) {
  return new Promise((resolve) => {
    pendingApprovals.set(req.id, resolve);
    emit({ type: 'approval:request', ...req });
    // No timeout: a tool call waits as long as the user needs. The UI exposes
    // Deny and Cancel, and aborting the turn rejects everything outstanding.
  });
}

function resolveApproval(id, decision) {
  const resolve = pendingApprovals.get(id);
  if (!resolve) return { ok: false, error: 'no pending approval with that id' };
  pendingApprovals.delete(id);
  resolve(decision);
  return { ok: true };
}

function clearApprovals(decision = 'abort') {
  for (const [id, resolve] of pendingApprovals) { resolve(decision); pendingApprovals.delete(id); }
}

/* ------------------------------ model library ----------------------------- */

const SHARD_RE = /-\d{5}-of-\d{5}\.gguf$/i;

function scanModels(dir, depth = 3) {
  const found = [];
  const walk = (d, level) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (level < depth && !e.name.startsWith('.')) walk(p, level + 1);
      } else if (/\.gguf$/i.test(e.name)) {
        // Multi-part models are referenced by their first shard; llama.cpp
        // finds the rest. mmproj files are vision projectors, not models.
        if (SHARD_RE.test(e.name) && !/-00001-of-/i.test(e.name)) continue;
        if (/^mmproj|mmproj.*\.gguf$/i.test(e.name)) continue;
        found.push(p);
      }
    }
  };
  walk(dir, 0);
  return found;
}

function describeModel(modelPath) {
  const meta = gguf.readGGUF(modelPath);
  if (!meta.ok) return { ok: false, modelPath, error: meta.error };
  return { ok: true, modelPath, summary: meta.summary, tensorTypes: meta.tensorTypes, version: meta.version };
}

function registerModel(modelPath, { isPrimary = false } = {}) {
  const described = describeModel(modelPath);
  if (!described.ok) return described;
  const cfg = config.get();
  const existing = cfg.models.find((m) => m.modelPath === modelPath);
  const id = existing ? existing.id : crypto.randomUUID();
  const profile = existing && existing.profile
    ? { ...planner.defaultProfile(modelPath, described.summary, hw), ...existing.profile, modelPath }
    : planner.defaultProfile(modelPath, described.summary, hw);
  profile.backend = cfg.llamaBackend || profile.backend;
  const model = {
    id,
    name: existing ? existing.name : described.summary.name,
    modelPath,
    meta: described.summary,
    tensorTypes: described.tensorTypes,
    profile,
    isPrimary: existing ? existing.isPrimary : isPrimary,
    addedAt: existing ? existing.addedAt : new Date().toISOString(),
  };
  config.upsertModel(model);
  return { ok: true, model };
}

function planFor(modelId, overrides) {
  const model = config.model(modelId);
  if (!model) return { ok: false, error: 'unknown model' };
  const cfg = config.get();
  const profile = { ...model.profile, ...(overrides || {}) };
  const result = planner.plan({
    summary: model.meta,
    profile,
    hw,
    budgetGB: cfg.gpuBudgetGB || hw.suggestedGpuBudgetGB,
  });
  return {
    ok: true,
    modelId,
    profile,
    plan: result,
    commandPreview: [cfg.llamaServerPath || 'llama-server', ...planner.buildArgs(profile)].join(' '),
    env: planner.buildEnv({ ...profile, backend: cfg.llamaBackend }),
  };
}

/* --------------------------------- window -------------------------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0e1116',
    title: 'Laguna Deck',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // Links open in the user's browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

/**
 * Headless boot check (LAGUNA_SMOKE=1, or `npm run smoke`): load the real
 * window, then assert the renderer actually bootstrapped instead of dying on an
 * exception nobody sees. Catches the whole main-to-renderer path -- preload
 * bridge, IPC, first render -- which the node-only self-test cannot reach.
 */
async function runSmoke() {
  const wc = win.webContents;
  const errors = [];
  wc.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  wc.on('render-process-gone', (_e, details) => errors.push('renderer gone: ' + JSON.stringify(details)));
  await new Promise((resolve) => wc.once('did-finish-load', resolve));
  await new Promise((r) => setTimeout(r, 2500)); // let bootstrap() settle

  const probe = await wc.executeJavaScript(`(() => ({
    bridge: typeof window.deck === 'object' && typeof window.deck.bootstrap === 'function',
    gotConfig: !!(window.__deckState && window.__deckState.config),
    hwLine: document.querySelector('#hwLine').textContent,
    modelRows: document.querySelectorAll('#modelList li').length,
    cliRows: document.querySelectorAll('#cliList .driver').length,
    claudeMeta: document.querySelector('#metaClaude').textContent,
    comfyMeta: document.querySelector('#metaComfy').textContent,
    activeName: document.querySelector('#activeName').textContent,
    budget: document.querySelector('#budgetNums').textContent,
    sendDisabled: document.querySelector('#btnSend').disabled,
    tabs: document.querySelectorAll('.deck-tabs .tab').length,
    status: document.querySelector('#statusText').textContent,
    sessionRows: document.querySelectorAll('#sessionList li').length,
  }))()`).catch((err) => ({ error: err.message }));

  // Second phase: put a real (fixture) model through the library, then select
  // it, so the budget meter, the advice list and the offload form all render
  // for real. Those are the renderer's most involved paths.
  const { buildFixtureGGUF } = require('./lib/fixture-gguf');
  const fixture = path.join(app.getPath('temp'), 'laguna-deck-smoke.gguf');
  buildFixtureGGUF(fixture, { name: 'Smoke XS' });
  const added = await wc.executeJavaScript(
    'window.deck.models.add({ modelPath: ' + JSON.stringify(fixture) + ' })');
  await wc.executeJavaScript('location.reload()').catch(() => {});
  await new Promise((resolve) => wc.once('did-finish-load', resolve));
  await new Promise((r) => setTimeout(r, 2500));
  const deep = await wc.executeJavaScript(`(async () => {
    const row = document.querySelector('#modelList li.driver');
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 900));
    // Start a session, then look at the ComfyUI driver, then come back to the
    // offload tab -- the three views a user actually moves between.
    document.querySelector('#btnNewSession').click();
    await new Promise((r) => setTimeout(r, 700));
    const sessionsAfterNew = document.querySelectorAll('#sessionList li.session').length;
    document.querySelector('#comfyRow').click();
    await new Promise((r) => setTimeout(r, 500));
    const comfyShown = !document.querySelector('#comfyView').hidden && document.querySelector('#transcript').hidden;
    const comfyText = document.querySelector('#comfyView').textContent;
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('.deck-tabs .tab[data-tab="profile"]').click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      sessionsAfterNew,
      comfyShown,
      comfyText,
      ramText: document.querySelector('#ramText').textContent,
      sysNums: document.querySelector('#sysNums').textContent,
      sparkPainted: (() => {
        const c = document.querySelector('#sysSpark');
        try {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
        } catch (_) { return false; }
        return false;
      })(),
      rowRendered: !!row,
      rowText: row ? row.textContent : '',
      budget: document.querySelector('#budgetNums').textContent,
      statRows: document.querySelectorAll('#statGrid dt').length,
      advice: document.querySelectorAll('#adviceList .advice').length,
      profileFields: document.querySelectorAll('#profileForm .field').length,
      cmdline: (document.querySelector('#profileForm .cmdline') || {}).textContent || '',
      activeName: document.querySelector('#activeName').textContent,
      sendDisabled: document.querySelector('#btnSend').disabled,
    };
  })()`).catch((err) => ({ error: err.message }));

  const checks = [
    ['preload bridge present', probe.bridge === true],
    ['bootstrap returned config', probe.gotConfig === true],
    ['hardware line rendered', !!probe.hwLine && probe.hwLine !== 'probing hardware…'],
    ['both CLI driver rows rendered', probe.cliRows === 2],
    ['CLI detection ran', probe.claudeMeta !== 'checking…'],
    ['deck tabs rendered', probe.tabs === 4],
    ['ComfyUI detection ran', probe.comfyMeta !== 'checking…'],
    ['status strip reports state', !!probe.status && probe.status !== 'Idle' ? true : probe.status === 'Idle'],
    ['session rail rendered', probe.sessionRows >= 1],
    ['no driver selected on a clean profile', probe.sendDisabled === true],
    ['added model appears in the rail', deep.rowRendered === true],
    ['model row shows its MoE routing', /MoE 8\/64/.test(deep.rowText || '')],
    ['budget meter has numbers', /GiB \/ /.test(deep.budget || '')],
    ['budget stats rendered', (deep.statRows || 0) >= 6],
    ['offload form rendered', (deep.profileFields || 0) >= 12],
    ['command preview includes the model', /--jinja/.test(deep.cmdline || '')],
    ['selecting a model enables the composer', deep.sendDisabled === false],
    ['new session appears in the rail', (deep.sessionsAfterNew || 0) >= 1],
    ['ComfyUI driver swaps in its own view', deep.comfyShown === true],
    ['ComfyUI panel offers setup or start', /Install ComfyUI|Start ComfyUI/.test(deep.comfyText || '')],
    ['live RAM gauge has numbers',
      /[\d.]+ \/ [\d.]+ GB/.test(deep.ramText || '') && /GiB \/ .*GiB/.test(deep.sysNums || '')],
    ['memory history chart is drawn', deep.sparkPainted === true],
    ['no renderer errors', errors.length === 0],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if (probe.error) console.log('  probe error: ' + probe.error);
  if (deep.error) console.log('  deep-probe error: ' + deep.error);
  if (added && added.ok === false) console.log('  model add failed: ' + added.error);
  try { fs.unlinkSync(fixture); } catch (_) { /* best effort */ }

  // LAGUNA_SMOKE_SHOT=<path> saves a PNG of the loaded window, for eyeballing
  // the layout on a machine with no display.
  if (process.env.LAGUNA_SMOKE_SHOT) {
    try {
      const shot = async (suffix) => {
        const img = await wc.capturePage();
        const file = process.env.LAGUNA_SMOKE_SHOT.replace(/\.png$/, '') + suffix + '.png';
        fs.writeFileSync(file, img.toPNG());
        console.log('  screenshot: ' + file);
      };
      await shot('-offload');
      for (const tab of ['budget', 'system']) {
        await wc.executeJavaScript('document.querySelector(\'.deck-tabs .tab[data-tab="' + tab + '"]\').click()');
        await new Promise((r) => setTimeout(r, 600));
        await shot('-' + tab);
      }
    } catch (err) { console.log('  screenshot failed: ' + err.message); }
  }
  for (const e of errors) console.log('  console: ' + e);
  console.log(failed.length ? '\nsmoke FAILED (' + failed.length + ')\n' : '\nsmoke passed\n');
  app.exit(failed.length ? 1 : 0);
}

function createTray() {
  try {
    const img = nativeImage.createFromDataURL(TRAY_ICON);
    tray = new Tray(img);
    tray.setToolTip('Laguna Deck');
    const refresh = () => {
      const st = llama ? llama.status() : { state: 'stopped' };
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Laguna Deck', enabled: false },
        { label: 'Model: ' + st.state + (st.modelId ? '' : ' (none loaded)'), enabled: false },
        { type: 'separator' },
        { label: 'Show window', click: () => { if (!win) createWindow(); else win.show(); } },
        { label: 'Unload model', enabled: st.state === 'ready', click: () => llama.stop() },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.quit(); } },
      ]));
    };
    refresh();
    setInterval(refresh, 4000);
  } catch (_) { /* a tray is a nicety, not a requirement */ }
}

// A 16x16 teal square: enough to be findable in the tray without shipping a binary asset.
const TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPElEQVR42mNkIAIwDg0wGBkZGf4zMDAwMDAwMPxnYGBgYGBgYPjPwMDAwMDAwPCfgYGBgYGBgeE/AwMDAwMDAwBvRwgBkmQ1cQAAAABJRU5ErkJggg==';

/* ---------------------------------- IPC ---------------------------------- */

function wireIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_evt, payload) => {
    try { return await fn(payload || {}); } catch (err) {
      return { ok: false, error: err.message, stack: isDev ? err.stack : undefined };
    }
  });

  handle('app:bootstrap', async () => {
    const cfg = config.get();
    if (!cfg.llamaServerPath) {
      const found = findLlamaServer(null);
      if (found) config.patch({ llamaServerPath: found });
    }
    if (!cfg.workspace) config.patch({ workspace: app.getPath('documents') });
    buildToolCtx();
    return {
      ok: true,
      config: config.get(),
      hw,
      llama: llama.status(),
      cli: await cli.detect(config.get().cli),
      comfy: comfy.detect(config.get().comfy && config.get().comfy.dir),
      comfyStatus: comfyServer.status(),
      comfyFlavors: comfy.TORCH_FLAVORS,
      sessions: sessions.list(),
      session: currentSessionId ? sessions.load(currentSessionId) : null,
      platform: process.platform,
      appVersion: app.getVersion(),
      tools: Object.entries(tools.TOOLS).map(([name, t]) => ({ name, risk: t.risk, description: t.description })),
    };
  });

  handle('config:patch', async ({ patch }) => {
    const data = config.patch(patch || {});
    buildToolCtx();
    return { ok: true, config: data };
  });

  handle('config:reveal', async () => {
    shell.showItemInFolder(config.file);
    return { ok: true };
  });

  handle('fs:pickDirectory', async ({ title }) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    return { ok: !r.canceled, path: r.canceled ? null : r.filePaths[0] };
  });

  handle('fs:pickFile', async ({ title, filters }) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose a file', properties: ['openFile'], filters });
    return { ok: !r.canceled, path: r.canceled ? null : r.filePaths[0] };
  });

  handle('hw:refresh', async () => {
    hw = await hardware.probe();
    return { ok: true, hw };
  });

  handle('models:scan', async ({ dir }) => {
    const target = dir || config.get().modelsDir;
    if (!target) return { ok: false, error: 'no models folder set' };
    const paths = scanModels(target);
    const results = paths.map((p) => {
      const d = describeModel(p);
      return d.ok
        ? { modelPath: p, name: d.summary.name, sizeBytes: d.summary.sizeBytes, meta: d.summary }
        : { modelPath: p, error: d.error };
    });
    config.patch({ modelsDir: target });
    return { ok: true, dir: target, found: results };
  });

  handle('models:add', async ({ modelPath, isPrimary }) => {
    const r = registerModel(modelPath, { isPrimary });
    return r.ok ? { ok: true, config: config.get(), model: r.model } : r;
  });

  handle('models:remove', async ({ id }) => {
    if (llama.modelId === id && llama.state !== 'stopped') await llama.stop();
    return { ok: true, config: config.removeModel(id) };
  });

  handle('models:update', async ({ id, patch }) => {
    const model = config.model(id);
    if (!model) return { ok: false, error: 'unknown model' };
    const next = { ...model, ...patch, profile: { ...model.profile, ...(patch.profile || {}) } };
    config.upsertModel(next);
    return { ok: true, config: config.get(), model: next };
  });

  handle('models:plan', async ({ id, overrides }) => planFor(id, overrides));

  handle('models:inspect', async ({ modelPath }) => {
    const meta = gguf.readGGUF(modelPath);
    if (!meta.ok) return meta;
    // The full kv map includes the tokenizer; strip the elided arrays for the UI.
    const kv = {};
    for (const [k, v] of Object.entries(meta.kv)) {
      if (v && typeof v === 'object' && v.__elided) kv[k] = '[' + v.count + ' values]';
      else kv[k] = v;
    }
    return { ok: true, summary: meta.summary, kv, tensorTypes: meta.tensorTypes, version: meta.version };
  });

  handle('llama:start', async ({ id, overrides }) => {
    const cfg = config.get();
    const model = config.model(id);
    if (!model) return { ok: false, error: 'unknown model' };
    const profile = { ...model.profile, ...(overrides || {}) };
    const binPath = findLlamaServer(cfg.llamaServerPath);
    const res = await llama.start({ binPath, profile, modelId: id, backend: cfg.llamaBackend });
    config.patch({ activeModelId: id });
    if (overrides) config.upsertModel({ ...model, profile });
    return { ok: true, ...res, status: llama.status() };
  });

  handle('llama:stop', async () => {
    await llama.stop();
    return { ok: true, status: llama.status() };
  });

  handle('llama:status', async () => ({ ok: true, status: llama.status() }));

  handle('llama:swap', async ({ id, overrides }) => {
    // One model at a time: on a unified-memory box the second one would evict
    // the first anyway, so make the stop explicit and visible.
    const cfg = config.get();
    const model = config.model(id);
    if (!model) return { ok: false, error: 'unknown model' };
    await llama.stop();
    const profile = { ...model.profile, ...(overrides || {}) };
    const res = await llama.start({
      binPath: findLlamaServer(cfg.llamaServerPath),
      profile,
      modelId: id,
      backend: cfg.llamaBackend,
    });
    config.patch({ activeModelId: id });
    if (overrides) config.upsertModel({ ...model, profile });
    return { ok: true, ...res, status: llama.status() };
  });

  /* ----- local agent ----- */

  handle('agent:send', async ({ text, enabledTools }) => {
    const cfg = config.get();
    const model = cfg.activeModelId ? config.model(cfg.activeModelId) : null;
    ensureSession({ kind: 'local', modelId: cfg.activeModelId });
    buildToolCtx();
    const res = await agent.send({
      text,
      toolCtx,
      modelName: model ? model.name : null,
      sampling: cfg.sampling,
      approvalMode: cfg.approvalMode,
      enabledTools: enabledTools && enabledTools.length ? enabledTools : undefined,
    });
    persistAgentHistory();
    return { ok: true, ...res, sessions: sessions.list() };
  });

  handle('agent:abort', async () => {
    clearApprovals('abort');
    agent.abort();
    return { ok: true };
  });

  handle('agent:reset', async () => { agent.reset(); return { ok: true }; });
  handle('agent:transcript', async () => ({ ok: true, messages: agent.transcript() }));
  handle('agent:approve', async ({ id, decision }) => resolveApproval(id, decision));

  /* ----- sessions ----- */

  handle('sessions:list', async () => ({ ok: true, sessions: sessions.list(), activeId: currentSessionId }));

  handle('sessions:new', async ({ driver }) => {
    if (currentSessionId) persistAgentHistory();
    const s = sessions.create({ driver });
    currentSessionId = s.id;
    config.patch({ activeSessionId: s.id });
    agent.reset();
    return { ok: true, session: s, sessions: sessions.list() };
  });

  handle('sessions:switch', async ({ id }) => {
    const s = sessions.load(id);
    if (!s) return { ok: false, error: 'no such session' };
    if (currentSessionId) persistAgentHistory();
    currentSessionId = id;
    config.patch({ activeSessionId: id });
    // Restore the model-facing history too, so the model remembers what the
    // transcript shows rather than just appearing to.
    agent.reset();
    agent.messages = Array.isArray(s.agent) ? s.agent.slice() : [];
    agent.systemText = agent.messages.length && agent.messages[0].role === 'system' ? agent.messages[0].content : null;
    return { ok: true, session: s, sessions: sessions.list() };
  });

  handle('sessions:delete', async ({ id }) => {
    sessions.remove(id);
    if (currentSessionId === id) {
      currentSessionId = null;
      config.patch({ activeSessionId: null });
      agent.reset();
    }
    return { ok: true, sessions: sessions.list(), activeId: currentSessionId };
  });

  handle('sessions:rename', async ({ id, title }) => {
    const s = sessions.patch(id, { title: String(title || '').slice(0, 120) || 'Untitled' });
    return s ? { ok: true, session: s, sessions: sessions.list() } : { ok: false, error: 'no such session' };
  });

  handle('sessions:get', async ({ id }) => {
    const s = sessions.load(id || currentSessionId);
    return s ? { ok: true, session: s } : { ok: false, error: 'no such session' };
  });

  /* ----- memory monitor ----- */

  handle('monitor:sample', async () => ({ ok: true, sample: await monitor.sample() }));

  /* ----- ComfyUI ----- */

  handle('comfy:detect', async () => {
    const cfg = config.get();
    return { ok: true, comfy: comfy.detect(cfg.comfy && cfg.comfy.dir), status: comfyServer.status(), flavors: comfy.TORCH_FLAVORS };
  });

  handle('comfy:install', async ({ dir, flavor }) => {
    const target = dir || comfy.detect().suggestedDir;
    comfyServer.setState('installing', { dir: target });
    emit({ type: 'comfy:log', line: 'Installing ComfyUI into ' + target + ' (' + flavor + ')' });
    try {
      const r = await comfy.install({ dir: target, flavor, onLog: (line) => emit({ type: 'comfy:log', line }) });
      config.patch({ comfy: { dir: target, python: r.python, flavor } });
      comfyServer.setState('stopped');
      return { ok: true, ...r, comfy: comfy.detect(target) };
    } catch (err) {
      comfyServer.setState('error', { error: err.message });
      return { ok: false, error: err.message };
    }
  });

  handle('comfy:start', async ({ dir, port }) => {
    const cfg = config.get();
    const found = comfy.detect((cfg.comfy && cfg.comfy.dir) || dir);
    const target = dir || found.dir;
    if (!target) return { ok: false, error: 'ComfyUI is not installed yet' };
    const res = await comfyServer.start({
      dir: target,
      python: cfg.comfy && cfg.comfy.python,
      port: port || (cfg.comfy && cfg.comfy.port) || 8188,
      flavor: cfg.comfy && cfg.comfy.flavor,
      extraArgs: (cfg.comfy && cfg.comfy.extraArgs) || [],
    });
    config.patch({ comfy: { dir: target, port: res.port } });
    return { ok: true, ...res, status: comfyServer.status() };
  });

  handle('comfy:stop', async () => { await comfyServer.stop(); return { ok: true, status: comfyServer.status() }; });

  handle('comfy:status', async () => {
    const stats = comfyServer.state === 'ready' ? await comfyServer.stats().catch(() => null) : null;
    return { ok: true, status: comfyServer.status(), stats };
  });

  handle('comfy:open', async ({ inApp }) => {
    if (comfyServer.state !== 'ready') return { ok: false, error: 'ComfyUI is not running' };
    if (inApp) {
      const w = new BrowserWindow({
        width: 1500, height: 950, backgroundColor: '#0e1116', title: 'ComfyUI',
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      w.loadURL(comfyServer.baseUrl);
      return { ok: true, via: 'window' };
    }
    await shell.openExternal(comfyServer.baseUrl);
    return { ok: true, via: 'browser' };
  });

  handle('comfy:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Locate your ComfyUI folder', properties: ['openDirectory'] });
    if (r.canceled) return { ok: false };
    const found = comfy.detect(r.filePaths[0]);
    if (!found.installed) return { ok: false, error: 'that folder has no main.py / comfy directory' };
    config.patch({ comfy: { dir: found.dir, python: found.python } });
    return { ok: true, comfy: found };
  });

  /* ----- CLI drivers ----- */

  handle('cli:detect', async () => ({ ok: true, cli: await cli.detect(config.get().cli) }));

  handle('cli:start', async ({ agent: which, cwd, resume }) => {
    const cfg = config.get();
    const detected = await cli.detect(cfg.cli);
    const info = detected[which];
    if (!info || !info.installed) {
      return {
        ok: false,
        error: which === 'claude'
          ? 'Claude Code is not on PATH. Install it, then point Settings at the binary.'
          : 'GitHub Copilot CLI is not on PATH. Install it, then point Settings at the binary.',
      };
    }
    const workDir = cwd || cfg.workspace;
    if (!workDir || !fs.existsSync(workDir)) return { ok: false, error: 'working directory does not exist: ' + workDir };

    const existing = cliSessions.get(which);
    if (existing) await existing.stop();

    let session;
    if (which === 'claude') {
      session = new cli.ClaudeSession({
        bin: info.bin,
        cwd: workDir,
        onEvent: emit,
        model: cfg.cli.claude.model,
        effort: cfg.cli.claude.effort,
        permissionMode: cfg.cli.claude.permissionMode,
        extraArgs: cfg.cli.claude.extraArgs,
        resume: resume || null,
      });
    } else {
      session = new cli.CopilotSession({
        bin: info.bin,
        cwd: workDir,
        onEvent: emit,
        model: cfg.cli.copilot.model,
        allowAllTools: cfg.cli.copilot.allowAllTools,
        allowTools: cfg.cli.copilot.allowTools,
        denyTools: cfg.cli.copilot.denyTools,
        extraArgs: cfg.cli.copilot.extraArgs,
        addDirs: [],
      });
    }
    cliSessions.set(which, session);
    ensureSession({ kind: which, modelId: null });
    const started = await session.start();
    if (which === 'claude' && session.sessionId) sessions.patch(currentSessionId, { cliSessionId: session.sessionId });
    return { ok: true, started, status: session.status(), sessions: sessions.list() };
  });

  handle('cli:send', async ({ agent: which, text }) => {
    const session = cliSessions.get(which);
    if (!session) return { ok: false, error: 'no ' + which + ' session is running; launch it first' };
    return { ok: true, ...session.send(text) };
  });

  handle('cli:interrupt', async ({ agent: which }) => {
    const session = cliSessions.get(which);
    if (!session) return { ok: false, error: 'no session' };
    return { ok: true, ...session.interrupt() };
  });

  handle('cli:stop', async ({ agent: which }) => {
    const session = cliSessions.get(which);
    if (!session) return { ok: true };
    await session.stop();
    cliSessions.delete(which);
    return { ok: true };
  });

  handle('cli:status', async () => {
    const out = {};
    for (const [k, s] of cliSessions) out[k] = s.status();
    return { ok: true, sessions: out };
  });

  handle('cli:openTerminal', async ({ agent: which, cwd, resumeId }) => {
    const cfg = config.get();
    const detected = await cli.detect(cfg.cli);
    const info = detected[which];
    if (!info || !info.installed) return { ok: false, error: which + ' is not installed' };
    return cli.openInTerminal({ agent: which, bin: info.bin, cwd: cwd || cfg.workspace, resumeId });
  });

  handle('shell:openPath', async ({ target }) => {
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  });

  handle('shell:openExternal', async ({ url }) => {
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'only http(s) links are opened' };
    await shell.openExternal(url);
    return { ok: true };
  });
}

/* --------------------------------- boot ---------------------------------- */

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  app.whenReady().then(async () => {
    config = new Config(app.getPath('userData'));
    sessions = new SessionStore(app.getPath('userData'));
    const savedSession = config.get().activeSessionId;
    currentSessionId = savedSession && sessions.load(savedSession) ? savedSession : null;
    hw = await hardware.probe();
    llama = new LlamaServer({ onEvent: emit });
    comfyServer = new comfy.ComfyServer({ onEvent: emit });
    agent = new LocalAgent({
      getStatus: () => llama.status(),
      onEvent: emit,
      requestApproval,
      getConfig: () => {
        const cfg = config.get();
        const model = cfg.activeModelId ? config.model(cfg.activeModelId) : null;
        return { ctx: model && model.profile ? model.profile.ctx : 8192, sampling: cfg.sampling };
      },
    });
    // Restore the previous conversation's model-facing history, so reopening
    // the app continues the chat instead of only redrawing it.
    if (currentSessionId) {
      const s0 = sessions.load(currentSessionId);
      if (s0 && Array.isArray(s0.agent) && s0.agent.length) agent.messages = s0.agent.slice();
    }

    monitor = new Monitor({ onSample: (sample) => emit({ type: 'monitor:sample', sample }) });
    monitor.trackPids(() => {
      const pids = {};
      if (llama.proc) pids['llama-server'] = llama.proc.pid;
      if (comfyServer.proc) pids.comfyui = comfyServer.proc.pid;
      for (const [name, s2] of cliSessions) { const st = s2.status(); if (st.pid) pids[name] = st.pid; }
      return pids;
    });
    monitor.start();

    buildToolCtx();
    wireIpc();
    createWindow();
    if (isSmoke) { await runSmoke(); return; }
    createTray();
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!win) createWindow(); });

  // Never leave a llama-server or a CLI agent running after the window closes:
  // on a unified-memory box an orphan holds tens of gigabytes.
  app.on('before-quit', async (e) => {
    if (app.__cleaning) return;
    app.__cleaning = true;
    e.preventDefault();
    clearApprovals('abort');
    try { agent.abort(); } catch (_) { /* nothing running */ }
    try { persistAgentHistory(); sessions.flushAll(); } catch (_) { /* best effort */ }
    try { monitor.stop(); } catch (_) { /* not started */ }
    for (const [, s] of cliSessions) { try { await s.stop(); } catch (_) { /* already gone */ } }
    try { await comfyServer.stop(); } catch (_) { /* already gone */ }
    try { await llama.stop(); } catch (_) { /* already gone */ }
    app.exit(0);
  });
}
