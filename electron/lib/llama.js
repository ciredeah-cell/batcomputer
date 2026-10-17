'use strict';
// Supervises one llama-server process. On a unified-memory box only one model
// can be resident at a time, so "switch model" means stop-then-start and the UI
// has to show that honestly instead of pretending it is instant.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildArgs, buildEnv } = require('./planner');

const STATES = ['stopped', 'starting', 'loading', 'ready', 'stopping', 'error'];

class LlamaServer {
  constructor({ onEvent }) {
    this.onEvent = onEvent || (() => {});
    this.proc = null;
    this.state = 'stopped';
    this.modelId = null;
    this.profile = null;
    this.port = 8080;
    this.logLines = [];
    this.lastError = null;
    this.startedAt = null;
    this.exitInfo = null;
  }

  setState(state, extra = {}) {
    this.state = state;
    this.onEvent({ type: 'llama:state', state, modelId: this.modelId, port: this.port, ...extra });
  }

  log(line) {
    const text = String(line).replace(/\r/g, '');
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      this.logLines.push(l);
      if (this.logLines.length > 600) this.logLines.shift();
      this.onEvent({ type: 'llama:log', line: l });
      // llama-server reports load progress on stderr; surface it so a 30-second
      // model load doesn't look like a hang.
      const m = /load_tensors:|llama_model_loader:|main: server is listening|warming up/.exec(l);
      if (m && this.state === 'starting') this.setState('loading');
    }
  }

  get baseUrl() { return 'http://127.0.0.1:' + this.port; }

  async start({ binPath, profile, modelId, backend }) {
    if (this.proc) await this.stop();
    if (!binPath) throw new Error('llama-server path is not set (Settings → llama.cpp binary)');
    if (!fs.existsSync(binPath)) throw new Error('llama-server not found at ' + binPath);
    if (!profile || !profile.modelPath) throw new Error('model profile has no modelPath');
    if (!fs.existsSync(profile.modelPath)) throw new Error('model file not found: ' + profile.modelPath);

    this.profile = profile;
    this.modelId = modelId;
    this.port = profile.port || 8080;
    this.logLines = [];
    this.lastError = null;
    this.exitInfo = null;
    this.startedAt = Date.now();

    const args = buildArgs(profile);
    const env = { ...process.env, ...buildEnv({ ...profile, backend: backend || profile.backend }) };
    this.commandLine = quoteCmd(binPath, args);
    this.setState('starting', { commandLine: this.commandLine });

    this.proc = spawn(binPath, args, {
      env,
      cwd: path.dirname(binPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (d) => this.log(d.toString()));
    this.proc.stderr.on('data', (d) => this.log(d.toString()));
    this.proc.on('error', (err) => {
      this.lastError = err.message;
      this.setState('error', { error: err.message });
    });
    this.proc.on('exit', (code, signal) => {
      const wasReady = this.state === 'ready';
      this.proc = null;
      this.exitInfo = { code, signal };
      if (this.state === 'stopping') this.setState('stopped');
      else {
        this.lastError = 'llama-server exited (code ' + code + (signal ? ', signal ' + signal : '') + ')'
          + (wasReady ? '' : '. Last log: ' + this.logLines.slice(-3).join(' | '));
        this.setState('error', { error: this.lastError });
      }
    });

    await this.waitReady();
    return { ok: true, port: this.port, commandLine: this.commandLine };
  }

  async waitReady(timeoutMs = 20 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error(this.lastError || 'llama-server exited during startup');
      try {
        const r = await fetch(this.baseUrl + '/health', { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          const props = await this.props().catch(() => null);
          this.setState('ready', { props, loadMs: Date.now() - this.startedAt });
          return true;
        }
      } catch (_) { /* not listening yet */ }
      await sleep(600);
    }
    await this.stop();
    throw new Error('llama-server did not become ready within the timeout');
  }

  async props() {
    const r = await fetch(this.baseUrl + '/props', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('props ' + r.status);
    return r.json();
  }

  async stop() {
    if (!this.proc) { this.setState('stopped'); return { ok: true }; }
    this.setState('stopping');
    const proc = this.proc;
    return new Promise((resolve) => {
      const done = () => resolve({ ok: true });
      proc.once('exit', done);
      try {
        if (process.platform === 'win32') {
          // llama-server does not handle a Node-sent SIGTERM on Windows; the
          // process tree has to be torn down by the OS.
          execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } else {
          proc.kill('SIGTERM');
        }
      } catch (_) { done(); }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} done(); }, 8000);
    });
  }

  status() {
    return {
      state: this.state,
      modelId: this.modelId,
      port: this.port,
      baseUrl: this.baseUrl,
      pid: this.proc ? this.proc.pid : null,
      error: this.lastError,
      commandLine: this.commandLine || null,
      uptimeMs: this.startedAt && this.state === 'ready' ? Date.now() - this.startedAt : null,
      log: this.logLines.slice(-80),
    };
  }
}

function quoteCmd(bin, args) {
  const q = (s) => (/[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s);
  return [bin, ...args].map(q).join(' ');
}

const WIN_CANDIDATES = [
  'C:\\llama.cpp\\llama-server.exe',
  path.join(os.homedir(), 'llama.cpp', 'llama-server.exe'),
  path.join(os.homedir(), 'Downloads', 'llama-server.exe'),
  'C:\\Program Files\\llama.cpp\\llama-server.exe',
];

/** Best-effort discovery of llama-server so first run isn't a file-picker hunt. */
function findLlamaServer(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of pathDirs) {
    try { const p = path.join(d, exe); if (fs.existsSync(p)) return p; } catch (_) {}
  }
  if (process.platform === 'win32') {
    for (const c of WIN_CANDIDATES) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  }
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { LlamaServer, findLlamaServer, STATES };
