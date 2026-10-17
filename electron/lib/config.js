'use strict';
// Config lives in one JSON file under userData. Written atomically because a
// half-written config on a crash would lose every model profile the user set up.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 1,
  workspace: null,              // default working directory for agents and tools
  gpuBudgetGB: null,            // null = use the hardware probe's suggestion
  llamaServerPath: null,        // path to llama-server.exe
  llamaBackend: 'vulkan',       // vulkan | rocm | cpu
  modelsDir: null,
  models: [],                   // [{ id, name, modelPath, profile, meta, isPrimary }]
  activeModelId: null,
  driver: 'local',              // local | claude-code | copilot | comfy
  approvalMode: 'ask',          // ask | acceptEdits | yolo
  activeSessionId: null,
  comfy: {
    dir: null,                  // null = autodetect
    python: null,               // null = the install's own venv, else system
    port: 8188,
    flavor: 'directml',         // see comfy.TORCH_FLAVORS
    extraArgs: [],
  },
  shell: null,                  // null = powershell on win32, bash elsewhere
  cli: {
    claude: {
      bin: null,                // null = resolve "claude" on PATH
      model: null,              // null = CLI default
      effort: null,
      permissionMode: 'acceptEdits',
      extraArgs: [],
    },
    copilot: {
      bin: null,                // null = resolve "copilot" on PATH
      model: null,
      allowAllTools: false,
      allowTools: [],
      denyTools: ['shell(rm)', 'shell(rmdir)', 'shell(del)', 'shell(format)'],
      extraArgs: [],
    },
  },
  sampling: {
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: 2048,
  },
  ui: { theme: 'dark', showPlanner: true },
};

class Config {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.data = this.load();
  }
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return deepMerge(structuredClone(DEFAULTS), raw);
    } catch (_) {
      return structuredClone(DEFAULTS);
    }
  }
  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.data;
  }
  get() { return this.data; }
  patch(partial) {
    this.data = deepMerge(this.data, partial);
    return this.save();
  }
  upsertModel(model) {
    const i = this.data.models.findIndex((m) => m.id === model.id);
    if (i >= 0) this.data.models[i] = deepMerge(this.data.models[i], model);
    else this.data.models.push(model);
    return this.save();
  }
  removeModel(id) {
    this.data.models = this.data.models.filter((m) => m.id !== id);
    if (this.data.activeModelId === id) this.data.activeModelId = null;
    return this.save();
  }
  model(id) { return this.data.models.find((m) => m.id === id) || null; }
}

function deepMerge(base, over) {
  if (Array.isArray(over)) return over.slice();
  if (over === null || over === undefined) return base;
  if (typeof over !== 'object') return over;
  const out = Array.isArray(base) ? base.slice() : { ...(base || {}) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(out[k] || {}, v) : (Array.isArray(v) ? v.slice() : v);
  }
  return out;
}

module.exports = { Config, DEFAULTS, deepMerge };
