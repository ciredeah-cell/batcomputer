'use strict';
// The local agent's tool surface. Three rules hold throughout:
//   1. File operations are confined to the workspace (plus explicitly added dirs).
//   2. Every tool declares a risk class; the approval layer, not the tool,
//      decides whether it runs.
//   3. Output is capped, because a 40 MB log pasted into a 32k context window
//      destroys the conversation it was meant to inform.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_OUTPUT = 60000;
const MAX_FILE = 400000;

// Commands that only read. Matched against the whole command line, so a
// shell operator anywhere (&&, |, ;, backtick, $()) disqualifies it.
const READ_ONLY_COMMANDS = [
  /^git\s+(status|log|diff|show|branch|remote|rev-parse|describe)\b/i,
  /^(ls|dir|pwd|cd|type|cat|head|tail|wc|find|where|which)\b/i,
  /^(node|python|py)\s+--version$/i,
  /^(npm|pip|cargo|dotnet)\s+(--version|list|ls)\b/i,
  /^(get-childitem|get-content|get-location|select-string|measure-object)\b/i,
  /^nvidia-smi\b/i, /^rocm-smi\b/i, /^systeminfo$/i, /^wmic\b/i,
];

const SHELL_OPERATORS = /[|;`]|&&|\$\(|>\s*\S|<\s*\S/;

// Things no approval mode should wave through without the user reading them.
const DESTRUCTIVE = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, why: 'recursive or forced delete' },
  { re: /\bdel\s+\/[sfq]/i, why: 'forced delete' },
  { re: /\brd\s+\/s/i, why: 'recursive directory delete' },
  { re: /remove-item[^\n]*-recurse/i, why: 'recursive delete' },
  { re: /\bformat\b|\bdiskpart\b|\bmkfs\b/i, why: 'disk format' },
  { re: /\bshutdown\b|\brestart-computer\b/i, why: 'power state change' },
  { re: /\breg\s+delete\b|remove-itemproperty/i, why: 'registry delete' },
  { re: /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-[a-z]*f)/i, why: 'destructive git operation' },
  { re: /(curl|wget|irm|iwr)[^\n]*\|\s*(sh|bash|iex|powershell)/i, why: 'pipe-to-shell' },
  { re: /\btakeown\b|\bicacls\b[^\n]*\/grant/i, why: 'permission change' },
];

class ToolContext {
  constructor({ workspace, extraDirs = [], shell = null, approvalMode = 'ask', onEvent = () => {} }) {
    this.workspace = workspace ? path.resolve(workspace) : process.cwd();
    this.extraDirs = extraDirs.map((d) => path.resolve(d));
    this.shell = shell;
    this.approvalMode = approvalMode;
    this.onEvent = onEvent;
    this.running = new Set();
  }

  roots() { return [this.workspace, ...this.extraDirs]; }

  // Resolve a model-supplied path and refuse anything outside the roots.
  resolve(p) {
    if (!p || typeof p !== 'string') throw new Error('path is required');
    const abs = path.resolve(this.workspace, p);
    // Resolve symlinks where the target exists so a link cannot escape.
    let real = abs;
    try { real = fs.realpathSync(abs); } catch (_) { real = abs; }
    const ok = this.roots().some((root) => {
      let rr = root;
      try { rr = fs.realpathSync(root); } catch (_) { rr = root; }
      return real === rr || real.startsWith(rr + path.sep);
    });
    if (!ok) {
      throw new Error('path is outside the workspace: ' + abs + '. Workspace roots: ' + this.roots().join(', '));
    }
    return abs;
  }
}

const TOOLS = {
  shell: {
    risk: 'danger',
    description: 'Run a command in the workspace shell (PowerShell on Windows, bash elsewhere) and return its combined stdout and stderr. Use it for builds, tests, git, and anything the file tools cannot express. One command per call; it is not a persistent shell, so a cd does not carry over to the next call.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        cwd: { type: 'string', description: 'Working directory, relative to the workspace. Defaults to the workspace root.' },
        timeout_ms: { type: 'number', description: 'Kill the command after this many milliseconds. Default 120000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    classify(input) {
      const cmd = String(input.command || '');
      for (const d of DESTRUCTIVE) if (d.re.test(cmd)) return { risk: 'destructive', why: d.why };
      const clean = !SHELL_OPERATORS.test(cmd);
      if (clean && READ_ONLY_COMMANDS.some((re) => re.test(cmd.trim()))) return { risk: 'safe', why: 'read-only command' };
      return { risk: 'danger', why: 'runs a command' };
    },
    preview(input) { return input.command; },
    async run(ctx, input) {
      const cwd = input.cwd ? ctx.resolve(input.cwd) : ctx.workspace;
      const timeout = Math.min(Math.max(Number(input.timeout_ms) || 120000, 1000), 15 * 60 * 1000);
      const isWin = process.platform === 'win32';
      const shell = ctx.shell || (isWin ? 'powershell.exe' : '/bin/bash');
      const args = isWin && /powershell|pwsh/i.test(shell)
        ? ['-NoProfile', '-NonInteractive', '-Command', input.command]
        : ['-lc', input.command];
      return await execCapture(shell, args, { cwd, timeout }, ctx);
    },
  },

  read_file: {
    risk: 'safe',
    description: 'Read a text file from the workspace. Returns the contents with 1-based line numbers so you can cite and edit precise lines.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        offset: { type: 'number', description: 'First line to return (1-based).' },
        limit: { type: 'number', description: 'How many lines to return. Default 2000.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    preview(input) { return 'read ' + input.path; },
    async run(ctx, input) {
      const p = ctx.resolve(input.path);
      const st = fs.statSync(p);
      if (st.isDirectory()) throw new Error(input.path + ' is a directory; use list_dir');
      if (st.size > MAX_FILE) {
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(MAX_FILE);
        fs.readSync(fd, buf, 0, MAX_FILE, 0);
        fs.closeSync(fd);
        return { output: numberLines(buf.toString('utf8'), 1) + '\n[truncated: file is ' + st.size + ' bytes]' };
      }
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      const start = Math.max(1, Number(input.offset) || 1);
      const limit = Math.min(Number(input.limit) || 2000, 4000);
      const slice = lines.slice(start - 1, start - 1 + limit);
      const more = lines.length > start - 1 + slice.length;
      return {
        output: numberLines(slice.join('\n'), start)
          + (more ? '\n[... ' + (lines.length - (start - 1 + slice.length)) + ' more lines]' : ''),
      };
    },
  },

  write_file: {
    risk: 'edit',
    description: 'Create a file or replace its entire contents. For a change to part of an existing file, prefer edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    preview(input) { return input.path + ' (' + String(input.content || '').length + ' bytes)'; },
    async run(ctx, input) {
      const p = ctx.resolve(input.path);
      const existed = fs.existsSync(p);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const content = input.content === undefined || input.content === null ? '' : String(input.content);
      fs.writeFileSync(p, content);
      return { output: (existed ? 'Overwrote ' : 'Created ') + p + ' (' + Buffer.byteLength(content) + ' bytes)' };
    },
  },

  edit_file: {
    risk: 'edit',
    description: 'Replace an exact string in a file. The old_string must appear exactly once unless replace_all is true, which keeps edits unambiguous.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    preview(input) { return 'edit ' + input.path; },
    async run(ctx, input) {
      const p = ctx.resolve(input.path);
      const before = fs.readFileSync(p, 'utf8');
      const oldStr = String(input.old_string);
      if (!oldStr) throw new Error('old_string cannot be empty');
      const count = before.split(oldStr).length - 1;
      if (count === 0) throw new Error('old_string not found in ' + input.path);
      if (count > 1 && !input.replace_all) {
        throw new Error('old_string appears ' + count + ' times in ' + input.path
          + '; pass replace_all or include more surrounding context');
      }
      const after = input.replace_all
        ? before.split(oldStr).join(String(input.new_string))
        : before.replace(oldStr, String(input.new_string));
      fs.writeFileSync(p, after);
      return { output: 'Edited ' + p + ' (' + (input.replace_all ? count : 1) + ' replacements)' };
    },
  },

  list_dir: {
    risk: 'safe',
    description: 'List the entries of a directory in the workspace, marking directories and showing file sizes.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Defaults to the workspace root.' } },
      additionalProperties: false,
    },
    preview(input) { return 'ls ' + (input.path || '.'); },
    async run(ctx, input) {
      const p = ctx.resolve(input.path || '.');
      const entries = fs.readdirSync(p, { withFileTypes: true }).slice(0, 1000);
      const rows = entries.map((e) => {
        if (e.isDirectory()) return e.name + '/';
        try { return e.name + '  (' + fs.statSync(path.join(p, e.name)).size + ' B)'; } catch (_) { return e.name; }
      });
      return { output: p + '\n' + rows.join('\n') };
    },
  },

  glob: {
    risk: 'safe',
    description: 'Find files by glob pattern (for example src/**/*.ts), newest first. Use it to locate files by name when you do not know where they live.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory to search from. Defaults to the workspace root.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    preview(input) { return 'glob ' + input.pattern; },
    async run(ctx, input) {
      const root = ctx.resolve(input.path || '.');
      const re = globToRegExp(input.pattern);
      const hits = [];
      walk(root, root, (rel, abs, st) => {
        if (re.test(rel.replace(/\\/g, '/'))) hits.push({ rel, mtime: st.mtimeMs });
        return hits.length < 2000;
      });
      hits.sort((a, b) => b.mtime - a.mtime);
      return { output: hits.length ? hits.slice(0, 400).map((h) => h.rel).join('\n') : 'no matches' };
    },
  },

  grep: {
    risk: 'safe',
    description: 'Search file contents with a regular expression. Returns file:line:text for each match.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory or file to search. Defaults to the workspace root.' },
        glob: { type: 'string', description: 'Only search files matching this glob.' },
        ignore_case: { type: 'boolean' },
        max_results: { type: 'number' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    preview(input) { return 'grep ' + input.pattern; },
    async run(ctx, input) {
      const root = ctx.resolve(input.path || '.');
      const re = new RegExp(input.pattern, input.ignore_case ? 'i' : '');
      const fileFilter = input.glob ? globToRegExp(input.glob) : null;
      const cap = Math.min(Number(input.max_results) || 300, 1000);
      const out = [];
      const consider = (rel, abs, st) => {
        if (st.size > MAX_FILE) return true;
        if (fileFilter && !fileFilter.test(rel.replace(/\\/g, '/'))) return true;
        let text;
        try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { return true; }
        if (BINARY_SNIFF.test(text.slice(0, 4096))) return true;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push(rel + ':' + (i + 1) + ': ' + lines[i].slice(0, 400));
            if (out.length >= cap) return false;
          }
        }
        return true;
      };
      const st = fs.statSync(root);
      if (st.isFile()) consider(path.basename(root), root, st);
      else walk(root, root, consider);
      return { output: out.length ? out.join('\n') : 'no matches' };
    },
  },
};

// NUL or stray C0 control bytes in the first few KB means "not text".
const BINARY_SNIFF = /[\x00-\x08\x0E-\x1F]/;

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'target', '.next', '.cache', 'AppData',
]);

function walk(root, dir, visit) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return true; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      if (!walk(root, abs, visit)) return false;
    } else if (e.isFile()) {
      let st;
      try { st = fs.statSync(abs); } catch (_) { continue; }
      if (!visit(path.relative(root, abs), abs, st)) return false;
    }
  }
  return true;
}

function globToRegExp(pattern) {
  let re = '';
  const p = pattern.replace(/\\/g, '/');
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // ** crosses directory boundaries; **/ also matches zero directories.
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function numberLines(text, start) {
  return text.split('\n').map((l, i) => String(start + i).padStart(5) + '\t' + l).join('\n');
}

function execCapture(cmd, args, opts, ctx) {
  const { cwd, timeout } = opts;
  return new Promise((resolve) => {
    let out = '';
    let killed = false;
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: process.env });
    ctx.running.add(child);
    const push = (chunk) => {
      if (out.length < MAX_OUTPUT) out += chunk;
      ctx.onEvent({ type: 'tool:stream', text: chunk });
    };
    child.stdout.on('data', (d) => push(d.toString()));
    child.stderr.on('data', (d) => push(d.toString()));
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch (_) {} }, timeout);
    child.on('error', (err) => {
      clearTimeout(timer); ctx.running.delete(child);
      resolve({ output: 'failed to start command: ' + err.message, isError: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer); ctx.running.delete(child);
      const trailer = killed ? '\n[killed after timeout]' : (code === 0 ? '' : '\n[exit code ' + code + ']');
      const body = out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + '\n[output truncated]' : out;
      resolve({ output: (body.trim() || '(no output)') + trailer, isError: killed || code !== 0 });
    });
  });
}

/** OpenAI-style tool schemas for llama-server's /v1/chat/completions. */
function toolSchemas(names) {
  const list = names || Object.keys(TOOLS);
  return list.map((name) => ({
    type: 'function',
    function: { name, description: TOOLS[name].description, parameters: TOOLS[name].parameters },
  }));
}

/** Risk for one concrete call, after per-tool classification. */
function classify(name, input) {
  const tool = TOOLS[name];
  if (!tool) return { risk: 'unknown', why: 'unknown tool' };
  if (tool.classify) return tool.classify(input || {});
  return { risk: tool.risk, why: tool.risk === 'edit' ? 'writes a file' : 'reads only' };
}

/** Does `mode` permit a call of this risk without asking the user? */
function autoApproved(risk, mode) {
  if (risk === 'destructive') return false;     // always ask, in every mode
  if (mode === 'yolo') return true;
  if (risk === 'safe') return true;
  if (mode === 'acceptEdits') return risk === 'edit';
  return false;
}

async function runTool(ctx, name, input) {
  const tool = TOOLS[name];
  if (!tool) return { output: 'No such tool: ' + name, isError: true };
  try {
    const res = await tool.run(ctx, input || {});
    return { output: res.output, isError: !!res.isError };
  } catch (err) {
    return { output: 'Error: ' + err.message, isError: true };
  }
}

function preview(name, input) {
  const tool = TOOLS[name];
  if (!tool) return name;
  try { return tool.preview ? tool.preview(input || {}) : name; } catch (_) { return name; }
}

module.exports = { TOOLS, ToolContext, toolSchemas, classify, autoApproved, runTool, preview, globToRegExp };
