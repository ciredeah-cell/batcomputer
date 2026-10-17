'use strict';
// ComfyUI as a first-class citizen of the deck: find an existing install, set
// one up if there isn't one, start and stop it, and read its /system_stats so
// its VRAM numbers show up on the same gauge as everything else.
//
// The deck does not reimplement ComfyUI's interface -- it opens it. What it
// adds is the part people actually get stuck on: a Python environment with the
// right torch build for the box, and a server you can start and stop without a
// terminal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const REPO = 'https://github.com/comfyanonymous/ComfyUI.git';

// Which torch build to install. On Windows + AMD this is the decision that
// sinks most first attempts, so each option says plainly what it is for.
const TORCH_FLAVORS = {
  directml: {
    label: 'AMD on Windows (DirectML)',
    note: 'Runs on any DirectX 12 GPU including Radeon iGPUs. The portable path for an AMD Windows box.',
    packages: ['torch', 'torchvision', 'torch-directml'],
    index: null,
    launchArgs: ['--directml'],
  },
  rocm: {
    label: 'AMD on Linux (ROCm)',
    note: 'Official AMD acceleration, Linux only. On Windows choose DirectML instead.',
    packages: ['torch', 'torchvision', 'torchaudio'],
    index: 'https://download.pytorch.org/whl/rocm6.2',
    launchArgs: [],
  },
  cuda: {
    label: 'NVIDIA (CUDA)',
    note: 'For a discrete NVIDIA card.',
    packages: ['torch', 'torchvision', 'torchaudio'],
    index: 'https://download.pytorch.org/whl/cu124',
    launchArgs: [],
  },
  cpu: {
    label: 'CPU only',
    note: 'Works everywhere and is slow everywhere. Useful to confirm the install before fighting drivers.',
    packages: ['torch', 'torchvision'],
    index: 'https://download.pytorch.org/whl/cpu',
    launchArgs: ['--cpu'],
  },
};

function candidateDirs() {
  const home = os.homedir();
  const dirs = [
    path.join(home, 'ComfyUI'),
    path.join(home, 'Documents', 'ComfyUI'),
    path.join(home, 'Desktop', 'ComfyUI'),
    path.join(home, 'ComfyUI_windows_portable', 'ComfyUI'),
    path.join(home, 'Downloads', 'ComfyUI_windows_portable', 'ComfyUI'),
  ];
  if (process.platform === 'win32') {
    for (const drive of ['C:', 'D:', 'E:']) {
      dirs.push(path.join(drive + '\\', 'ComfyUI'));
      dirs.push(path.join(drive + '\\', 'ComfyUI_windows_portable', 'ComfyUI'));
      dirs.push(path.join(drive + '\\', 'AI', 'ComfyUI'));
    }
  }
  return dirs;
}

function isComfyDir(dir) {
  try { return fs.existsSync(path.join(dir, 'main.py')) && fs.existsSync(path.join(dir, 'comfy')); } catch (_) { return false; }
}

/** The interpreter to run ComfyUI with: its own venv, the portable embed, or the system one. */
function findPython(dir) {
  const win = process.platform === 'win32';
  const candidates = [
    path.join(dir, '.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python'),
    path.join(dir, 'venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python'),
    path.join(dir, '..', 'python_embeded', 'python.exe'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return { path: c, kind: c.includes('python_embeded') ? 'portable' : 'venv' }; } catch (_) { /* keep looking */ }
  }
  const sys = whichAny(win ? ['python.exe', 'py.exe', 'python3.exe'] : ['python3', 'python']);
  return sys ? { path: sys, kind: 'system' } : null;
}

function whichAny(names) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

function detect(configuredDir) {
  const dirs = configuredDir ? [configuredDir, ...candidateDirs()] : candidateDirs();
  for (const d of dirs) {
    if (!d || !isComfyDir(d)) continue;
    const python = findPython(d);
    return {
      installed: true,
      dir: d,
      python: python ? python.path : null,
      pythonKind: python ? python.kind : null,
      hasVenv: !!(python && python.kind === 'venv'),
      models: countModels(d),
    };
  }
  return {
    installed: false,
    dir: null,
    python: null,
    suggestedDir: path.join(os.homedir(), 'ComfyUI'),
    git: !!whichAny(process.platform === 'win32' ? ['git.exe'] : ['git']),
    systemPython: whichAny(process.platform === 'win32' ? ['python.exe', 'py.exe'] : ['python3', 'python']),
  };
}

function countModels(dir) {
  const base = path.join(dir, 'models');
  const out = {};
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const files = fs.readdirSync(path.join(base, e.name))
        .filter((f) => /\.(safetensors|ckpt|pt|pth|gguf|sft)$/i.test(f));
      if (files.length) out[e.name] = files.length;
    } catch (_) { /* unreadable subfolder */ }
  }
  return out;
}

/* --------------------------------- server -------------------------------- */

class ComfyServer {
  constructor({ onEvent }) {
    this.onEvent = onEvent || (() => {});
    this.proc = null;
    this.state = 'stopped';          // stopped | starting | ready | error | installing
    this.port = 8188;
    this.dir = null;
    this.log = [];
    this.lastError = null;
  }

  get baseUrl() { return 'http://127.0.0.1:' + this.port; }

  setState(state, extra = {}) {
    this.state = state;
    this.onEvent({ type: 'comfy:state', state, port: this.port, dir: this.dir, ...extra });
  }

  pushLog(text) {
    for (const line of String(text).replace(/\r/g, '').split('\n')) {
      if (!line.trim()) continue;
      this.log.push(line);
      if (this.log.length > 500) this.log.shift();
      this.onEvent({ type: 'comfy:log', line });
    }
  }

  async start({ dir, python, port, flavor, extraArgs }) {
    if (this.proc) return { ok: true, already: true, port: this.port };
    if (!dir || !isComfyDir(dir)) throw new Error('that folder does not look like a ComfyUI install: ' + dir);
    const py = python || (findPython(dir) || {}).path;
    if (!py) throw new Error('no Python found for ComfyUI. Install Python 3.11+, or set it in Settings.');

    this.dir = dir;
    this.port = port || 8188;
    this.log = [];
    this.lastError = null;

    const args = ['-s', 'main.py', '--port', String(this.port), '--listen', '127.0.0.1'];
    const flavorArgs = (TORCH_FLAVORS[flavor] || {}).launchArgs || [];
    args.push(...flavorArgs, ...(extraArgs || []));
    this.commandLine = [py, ...args].join(' ');
    this.setState('starting', { commandLine: this.commandLine });

    this.proc = spawn(py, args, { cwd: dir, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => this.pushLog(d.toString()));
    this.proc.stderr.on('data', (d) => this.pushLog(d.toString()));
    this.proc.on('error', (err) => { this.lastError = err.message; this.setState('error', { error: err.message }); });
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.state === 'stopping') this.setState('stopped');
      else {
        this.lastError = 'ComfyUI exited (code ' + code + '). Last log: ' + this.log.slice(-3).join(' | ');
        this.setState('error', { error: this.lastError });
      }
    });

    await this.waitReady();
    return { ok: true, port: this.port, url: this.baseUrl };
  }

  async waitReady(timeoutMs = 5 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error(this.lastError || 'ComfyUI exited during startup');
      const stats = await this.stats().catch(() => null);
      if (stats) { this.setState('ready', { stats }); return true; }
      await new Promise((r) => setTimeout(r, 800));
    }
    await this.stop();
    throw new Error('ComfyUI did not come up within the timeout');
  }

  async stats() {
    const r = await fetch(this.baseUrl + '/system_stats', { signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error('system_stats ' + r.status);
    return r.json();
  }

  async stop() {
    if (!this.proc) { this.setState('stopped'); return { ok: true }; }
    this.setState('stopping');
    const proc = this.proc;
    return new Promise((resolve) => {
      proc.once('exit', () => resolve({ ok: true }));
      try {
        if (process.platform === 'win32') execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else proc.kill('SIGTERM');
      } catch (_) { resolve({ ok: true }); }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} resolve({ ok: true }); }, 8000);
    });
  }

  status() {
    return {
      state: this.state,
      port: this.port,
      dir: this.dir,
      url: this.baseUrl,
      pid: this.proc ? this.proc.pid : null,
      error: this.lastError,
      log: this.log.slice(-60),
      commandLine: this.commandLine || null,
    };
  }
}

/* -------------------------------- installer ------------------------------- */

/**
 * Clone ComfyUI, build a venv, install torch for the chosen flavor, then the
 * requirements. Every command is echoed before it runs so the log reads like
 * something you could have typed yourself -- which matters when step three of
 * five fails and the user has to finish by hand.
 */
async function install({ dir, flavor, onLog, pythonPath }) {
  const f = TORCH_FLAVORS[flavor];
  if (!f) throw new Error('unknown torch flavor: ' + flavor);
  const log = (text) => onLog && onLog(text.endsWith('\n') ? text : text + '\n');

  const git = whichAny(process.platform === 'win32' ? ['git.exe'] : ['git']);
  if (!git) throw new Error('git is not installed. Install Git for Windows, then try again.');
  const basePython = pythonPath || whichAny(process.platform === 'win32' ? ['python.exe', 'py.exe'] : ['python3', 'python']);
  if (!basePython) throw new Error('Python is not installed. Install Python 3.11 or newer, then try again.');

  const step = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    log('\n$ ' + [cmd, ...args].join(' '));
    const p = spawn(cmd, args, { windowsHide: true, env: process.env, ...opts });
    p.stdout.on('data', (d) => log(d.toString()));
    p.stderr.on('data', (d) => log(d.toString()));
    p.on('error', (err) => reject(new Error(cmd + ' failed to start: ' + err.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error([cmd, ...args].join(' ') + ' exited with code ' + code))));
  });

  if (!isComfyDir(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await step(git, ['clone', '--depth', '1', REPO, dir]);
  } else {
    log('ComfyUI is already in ' + dir + ' — skipping the clone.');
  }

  const win = process.platform === 'win32';
  const venvPython = path.join(dir, '.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
  if (!fs.existsSync(venvPython)) {
    await step(basePython, ['-m', 'venv', '.venv'], { cwd: dir });
  } else {
    log('Reusing the existing .venv.');
  }

  await step(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: dir });
  const torchArgs = ['-m', 'pip', 'install', ...f.packages];
  if (f.index) torchArgs.push('--index-url', f.index);
  await step(venvPython, torchArgs, { cwd: dir });
  await step(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt'], { cwd: dir });

  log('\nDone. ComfyUI is installed in ' + dir + ' with a ' + f.label + ' torch build.');
  log('Put checkpoints in ' + path.join(dir, 'models', 'checkpoints') + ' before your first run.');
  return { ok: true, dir, python: venvPython };
}

module.exports = { detect, install, ComfyServer, TORCH_FLAVORS, isComfyDir, findPython };
