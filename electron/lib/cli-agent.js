'use strict';
// Launches Claude Code and GitHub Copilot CLI as drivers inside the deck.
//
// Both are real agents with their own tools, permissions, and auth, so the deck
// does not try to re-implement them: it spawns the CLI, feeds it the user's
// turns, and renders its event stream. Two shapes, because the CLIs differ:
//
//   claude   - one long-lived process per session. With
//              --input-format stream-json the session stays open and each user
//              turn is a JSON line on stdin, so context persists in-process.
//   copilot  - one process per turn (-p is one-shot), with continuity through
//              --resume, which reattaches the previous session.
//
// Neither is run through a PTY: both have non-interactive modes that emit
// machine-readable output, which keeps the app free of native modules.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function which(bin) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 15000, windowsHide: true, maxBuffer: 2 << 20, cwd: opts.cwd }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : null });
    });
  });
}

/** Is each CLI installed, and is it signed in? Drives the launcher's UI state. */
async function detect(cfg = {}) {
  const claudeBin = (cfg.claude && cfg.claude.bin) || which('claude');
  const copilotBin = (cfg.copilot && cfg.copilot.bin) || which('copilot');

  const out = {
    claude: { installed: !!claudeBin, bin: claudeBin, version: null, authed: null, authMethod: null, detail: null },
    copilot: { installed: !!copilotBin, bin: copilotBin, version: null, authed: null, detail: null },
  };

  if (claudeBin) {
    const v = await run(claudeBin, ['--version']);
    out.claude.version = v.stdout.trim().split('\n')[0] || null;
    // `claude auth status` prints JSON and exits 0 when signed in, 1 when not.
    const a = await run(claudeBin, ['auth', 'status']);
    out.claude.authed = a.ok;
    try {
      const j = JSON.parse(a.stdout);
      out.claude.authMethod = j.authMethod || null;
      out.claude.authed = !!j.authMethod && j.authMethod !== 'none';
    } catch (_) {
      out.claude.detail = (a.stdout || a.stderr).trim().slice(0, 200) || null;
    }
  }

  if (copilotBin) {
    const v = await run(copilotBin, ['--version']);
    out.copilot.version = v.stdout.trim().split('\n')[0] || null;
    // The CLI has no auth-status subcommand; a token in the environment or a
    // stored credential file is the signal available to us.
    const tokenEnv = !!(process.env.COPILOT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
    const stored = ['.copilot', path.join('.config', 'copilot')]
      .some((rel) => { try { return fs.existsSync(path.join(os.homedir(), rel)); } catch (_) { return false; } });
    out.copilot.authed = tokenEnv || stored;
    out.copilot.detail = tokenEnv
      ? 'using a token from the environment'
      : (stored ? 'using the CLI\'s stored login' : 'run `copilot` once in a terminal to sign in, or set COPILOT_GITHUB_TOKEN');
  }

  return out;
}

/* ------------------------------ Claude Code ------------------------------ */

class ClaudeSession {
  constructor({ bin, cwd, onEvent, model, effort, permissionMode, extraArgs, sessionId, resume }) {
    this.bin = bin;
    this.cwd = cwd;
    this.onEvent = onEvent || (() => {});
    this.model = model || null;
    this.effort = effort || null;
    this.permissionMode = permissionMode || 'acceptEdits';
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
    this.sessionId = sessionId || crypto.randomUUID();
    this.resume = resume || null;
    this.proc = null;
    this.buf = '';
    this.alive = false;
    this.busy = false;
    this.lastResult = null;
    this.costUsd = 0;
  }

  args() {
    const a = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',                      // required for stream-json output
      '--include-partial-messages',     // token-level deltas for a live feel
      '--replay-user-messages',         // echo our turns back so the UI can confirm receipt
      '--permission-mode', this.permissionMode,
    ];
    if (this.resume) a.push('--resume', this.resume);
    else a.push('--session-id', this.sessionId);
    if (this.model) a.push('--model', this.model);
    if (this.effort) a.push('--effort', this.effort);
    a.push(...this.extraArgs.filter(Boolean));
    return a;
  }

  start() {
    if (this.proc) return { ok: true, pid: this.proc.pid };
    const args = this.args();
    this.commandLine = [this.bin, ...args].join(' ');
    this.proc = spawn(this.bin, args, {
      cwd: this.cwd,
      windowsHide: true,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.bin),
    });
    this.alive = true;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.ingest(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => this.onEvent({ type: 'cli:stderr', agent: 'claude', text: chunk }));
    this.proc.on('error', (err) => {
      this.alive = false;
      this.onEvent({ type: 'cli:error', agent: 'claude', error: err.message });
    });
    this.proc.on('exit', (code, signal) => {
      this.alive = false;
      this.busy = false;
      this.proc = null;
      this.onEvent({ type: 'cli:exit', agent: 'claude', code, signal });
    });
    this.onEvent({ type: 'cli:started', agent: 'claude', pid: this.proc.pid, cwd: this.cwd, commandLine: this.commandLine, sessionId: this.sessionId });
    return { ok: true, pid: this.proc.pid, sessionId: this.sessionId, commandLine: this.commandLine };
  }

  ingest(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) {
        this.onEvent({ type: 'cli:raw', agent: 'claude', text: line });
        continue;
      }
      this.handle(msg);
    }
  }

  handle(msg) {
    // Normalise the CLI's stream-json into the same event vocabulary the local
    // agent emits, so the renderer has one transcript format to draw.
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id || this.sessionId;
          this.onEvent({
            type: 'cli:init', agent: 'claude', sessionId: this.sessionId,
            model: msg.model, tools: msg.tools, cwd: msg.cwd, permissionMode: msg.permissionMode,
          });
        } else {
          this.onEvent({ type: 'cli:system', agent: 'claude', subtype: msg.subtype, data: msg });
        }
        return;

      case 'stream_event': {
        const ev = msg.event || {};
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && ev.delta.text) {
            this.onEvent({ type: 'cli:delta', agent: 'claude', text: ev.delta.text, parentToolUseId: msg.parent_tool_use_id || null });
          } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
            this.onEvent({ type: 'cli:reasoning', agent: 'claude', text: ev.delta.thinking });
          }
        }
        return;
      }

      case 'assistant': {
        const content = (msg.message && msg.message.content) || [];
        const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const toolUses = content.filter((b) => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        this.onEvent({ type: 'cli:assistant', agent: 'claude', text, toolCalls: toolUses, parentToolUseId: msg.parent_tool_use_id || null });
        return;
      }

      case 'user': {
        const content = (msg.message && msg.message.content) || [];
        const results = Array.isArray(content)
          ? content.filter((b) => b.type === 'tool_result').map((b) => ({
            id: b.tool_use_id,
            output: typeof b.content === 'string'
              ? b.content
              : (Array.isArray(b.content) ? b.content.map((c) => c.text || '').join('\n') : ''),
            isError: !!b.is_error,
          }))
          : [];
        if (results.length) this.onEvent({ type: 'cli:tool_results', agent: 'claude', results });
        else this.onEvent({ type: 'cli:user_echo', agent: 'claude', data: msg });
        return;
      }

      case 'result':
        this.busy = false;
        this.lastResult = msg;
        if (typeof msg.total_cost_usd === 'number') this.costUsd = msg.total_cost_usd;
        this.onEvent({
          type: 'cli:result', agent: 'claude', subtype: msg.subtype,
          text: msg.result || '', isError: msg.is_error || msg.subtype !== 'success',
          durationMs: msg.duration_ms, numTurns: msg.num_turns,
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
          usage: msg.usage || null,
        });
        return;

      default:
        this.onEvent({ type: 'cli:other', agent: 'claude', data: msg });
    }
  }

  send(text) {
    if (!this.proc || !this.alive) throw new Error('the Claude Code session is not running');
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    });
    this.busy = true;
    this.proc.stdin.write(line + '\n');
    this.onEvent({ type: 'cli:sent', agent: 'claude', text });
    return { ok: true };
  }

  interrupt() {
    if (!this.proc) return { ok: false };
    // stream-json input has no interrupt message; closing stdin ends the run
    // cleanly and leaves the transcript resumable by session id.
    try { this.proc.stdin.end(); } catch (_) { /* already closed */ }
    return { ok: true, note: 'input closed; resume with the session id to continue' };
  }

  stop() {
    if (!this.proc) return { ok: true };
    const proc = this.proc;
    try { proc.stdin.end(); } catch (_) { /* already closed */ }
    return new Promise((resolve) => {
      const done = () => resolve({ ok: true });
      proc.once('exit', done);
      setTimeout(() => {
        try {
          if (process.platform === 'win32') execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
          else proc.kill('SIGTERM');
        } catch (_) { /* gone */ }
      }, 1500);
      setTimeout(done, 8000);
    });
  }

  status() {
    return {
      agent: 'claude', alive: this.alive, busy: this.busy, pid: this.proc ? this.proc.pid : null,
      cwd: this.cwd, sessionId: this.sessionId, model: this.model, permissionMode: this.permissionMode,
      costUsd: this.costUsd, commandLine: this.commandLine || null,
    };
  }
}

/* --------------------------- GitHub Copilot CLI --------------------------- */

class CopilotSession {
  constructor({ bin, cwd, onEvent, model, allowAllTools, allowTools, denyTools, extraArgs, addDirs }) {
    this.bin = bin;
    this.cwd = cwd;
    this.onEvent = onEvent || (() => {});
    this.model = model || null;
    this.allowAllTools = !!allowAllTools;
    this.allowTools = allowTools || [];
    this.denyTools = denyTools || [];
    this.addDirs = addDirs || [];
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
    this.proc = null;
    this.busy = false;
    this.started = false;
    this.turns = 0;
    this.buf = '';
  }

  args(prompt, { resume }) {
    const a = ['-p', prompt, '--output-format', 'json', '--no-ask-user'];
    if (this.allowAllTools) a.push('--allow-all-tools');
    for (const t of this.allowTools) a.push('--allow-tool', t);
    // Deny rules outrank both --allow-tool and --allow-all-tools, so the
    // destructive list in config stays effective in every mode.
    for (const t of this.denyTools) a.push('--deny-tool', t);
    for (const d of this.addDirs) a.push('--add-dir', d);
    if (this.model) a.push('--model', this.model);
    if (resume) a.push('--continue');
    a.push(...this.extraArgs.filter(Boolean));
    return a;
  }

  start() {
    // Nothing long-lived to start: -p is one process per turn. We mark the
    // session open so the UI can show it as an active driver.
    this.started = true;
    this.onEvent({ type: 'cli:started', agent: 'copilot', cwd: this.cwd, note: 'one process per turn (-p); context continues with --continue' });
    return { ok: true };
  }

  send(text) {
    if (this.busy) throw new Error('the Copilot turn is still running');
    const resume = this.turns > 0;
    const args = this.args(text, { resume });
    this.commandLine = [this.bin, ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ');
    this.busy = true;
    this.turns++;
    this.buf = '';
    this.onEvent({ type: 'cli:sent', agent: 'copilot', text, commandLine: this.commandLine });

    this.proc = spawn(this.bin, args, {
      cwd: this.cwd,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.bin),
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.ingest(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => this.onEvent({ type: 'cli:stderr', agent: 'copilot', text: chunk }));
    this.proc.on('error', (err) => {
      this.busy = false;
      this.onEvent({ type: 'cli:error', agent: 'copilot', error: err.message });
    });
    this.proc.on('exit', (code) => {
      this.busy = false;
      const tail = this.buf.trim();
      if (tail) this.line(tail);
      this.proc = null;
      this.onEvent({ type: 'cli:result', agent: 'copilot', subtype: code === 0 ? 'success' : 'error', isError: code !== 0, exitCode: code });
    });
    return { ok: true };
  }

  ingest(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.line(line.trim());
    }
  }

  line(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) {
      // --output-format json emits JSONL, but plain progress text still appears
      // on some paths; show it rather than swallowing it.
      this.onEvent({ type: 'cli:delta', agent: 'copilot', text: line + '\n' });
      return;
    }
    const type = msg.type || '';
    if (type === 'workflow.result' || msg.data && msg.data.run) {
      const run = (msg.data && msg.data.run) || {};
      this.onEvent({
        type: 'cli:result', agent: 'copilot', subtype: run.status || 'completed',
        text: typeof run.result === 'string' ? run.result : JSON.stringify(run.result || ''),
        isError: run.status === 'error', runId: run.runId,
      });
      return;
    }
    if (typeof msg.text === 'string' || typeof msg.content === 'string') {
      this.onEvent({ type: 'cli:assistant', agent: 'copilot', text: msg.text || msg.content, toolCalls: [] });
      return;
    }
    this.onEvent({ type: 'cli:other', agent: 'copilot', data: msg });
  }

  interrupt() {
    if (!this.proc) return { ok: false };
    try {
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else this.proc.kill('SIGTERM');
    } catch (_) { /* gone */ }
    return { ok: true };
  }

  async stop() {
    this.interrupt();
    this.started = false;
    return { ok: true };
  }

  status() {
    return {
      agent: 'copilot', alive: this.started, busy: this.busy, pid: this.proc ? this.proc.pid : null,
      cwd: this.cwd, turns: this.turns, model: this.model,
      allowAllTools: this.allowAllTools, denyTools: this.denyTools,
      commandLine: this.commandLine || null,
    };
  }
}

/**
 * Hand a CLI off to a real terminal, for when the user wants the full TUI --
 * slash commands, the permission prompts, `/resume`, all of it. The deck's
 * embedded pane is the scripted path; this is the escape hatch.
 */
function openInTerminal({ agent, bin, cwd, resumeId }) {
  const inner = agent === 'claude'
    ? [bin, resumeId ? '--resume ' + resumeId : ''].filter(Boolean).join(' ')
    : bin;
  if (process.platform === 'win32') {
    const wt = which('wt');
    if (wt) {
      const child = spawn(wt, ['-d', cwd, 'cmd', '/k', inner], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { ok: true, via: 'windows-terminal' };
    }
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', 'cd /d "' + cwd + '" && ' + inner], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, via: 'cmd' };
  }
  for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
    const t = which(term);
    if (!t) continue;
    const args = term === 'gnome-terminal' ? ['--working-directory=' + cwd, '--', 'bash', '-lc', inner + '; exec bash']
      : ['-e', 'bash -lc "' + inner + '; exec bash"'];
    const child = spawn(t, args, { cwd, detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, via: term };
  }
  return { ok: false, error: 'no terminal emulator found' };
}

module.exports = { detect, which, ClaudeSession, CopilotSession, openInTerminal };
