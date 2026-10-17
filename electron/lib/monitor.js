'use strict';
// Live memory telemetry. On a unified-memory box the single most useful number
// is how much system RAM is gone, because that is also the graphics pool -- so
// this samples it continuously, attributes what the loaded model is holding,
// and keeps a short history so the UI can draw the curve rather than a number
// that jumps around.
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const GB = 1024 ** 3;
const HISTORY = 90;           // ~3 minutes at the default 2s interval

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 2 << 20 }, (err, stdout) => {
      // Keep the output even on a non-zero exit. PowerShell exits non-zero when
      // Get-Process is asked about a pid that has already gone -- which happens
      // routinely here, since we sample processes while they are shutting down
      // -- but it still prints valid JSON for the ones that are alive.
      const text = String(stdout || '');
      resolve(err && !text.trim() ? null : text);
    });
  });
}

/**
 * Resident set size for several processes at once, as { pid: bytes }.
 *
 * Batched deliberately: PowerShell costs a few hundred milliseconds to start,
 * and launching one per process per tick -- every two seconds, forever -- is a
 * measurable tax on the machine you are trying to measure.
 */
async function processRssMany(pids) {
  const out = {};
  const list = pids.filter(Boolean);
  if (!list.length) return out;

  if (process.platform === 'win32') {
    const text = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-Process -Id ' + list.join(',') + ' -ErrorAction SilentlyContinue |'
      + ' Select-Object Id,WorkingSet64 | ConvertTo-Json -Compress',
    ]);
    if (!text) return out;
    try {
      const parsed = JSON.parse(text);
      for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
        if (row && Number.isFinite(row.WorkingSet64)) out[row.Id] = row.WorkingSet64;
      }
    } catch (_) { /* a dead process mid-sample is normal */ }
    return out;
  }

  for (const pid of list) {
    try {
      const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
      const m = /VmRSS:\s+(\d+) kB/.exec(status);
      if (m) out[pid] = parseInt(m[1], 10) * 1024;
    } catch (_) { /* gone */ }
  }
  return out;
}

/** Convenience wrapper for a single process. */
async function processRss(pid) {
  const m = await processRssMany([pid]);
  return m[pid] === undefined ? null : m[pid];
}

/**
 * Dedicated GPU memory, where a tool exists to report it. Discrete cards have
 * nvidia-smi / rocm-smi; an iGPU usually has neither, and the honest answer
 * there is "it is system RAM", which the RAM gauge already shows.
 */
async function gpuMemory() {
  const nv = await run('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits']);
  if (nv) {
    const [used, total] = nv.trim().split('\n')[0].split(',').map((s) => parseInt(s, 10));
    if (Number.isFinite(used) && Number.isFinite(total)) {
      return { source: 'nvidia-smi', usedBytes: used * 1024 * 1024, totalBytes: total * 1024 * 1024 };
    }
  }
  const rocm = await run('rocm-smi', ['--showmeminfo', 'vram', '--json']);
  if (rocm) {
    try {
      const j = JSON.parse(rocm);
      const card = Object.values(j)[0] || {};
      const total = Number(card['VRAM Total Memory (B)']);
      const used = Number(card['VRAM Total Used Memory (B)']);
      if (Number.isFinite(total) && Number.isFinite(used)) {
        return { source: 'rocm-smi', usedBytes: used, totalBytes: total };
      }
    } catch (_) { /* fall through */ }
  }
  return null;
}

class Monitor {
  constructor({ onSample, intervalMs = 2000 }) {
    this.onSample = onSample || (() => {});
    this.intervalMs = intervalMs;
    this.timer = null;
    this.history = [];
    this.getPids = () => ({});
    this.gpu = null;
    this.gpuCheckedAt = 0;
  }

  /** The app tells the monitor which processes to attribute memory to. */
  trackPids(fn) { this.getPids = fn; }

  start() {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sample() {
    const total = os.totalmem();
    const free = os.freemem();
    const pids = this.getPids() || {};
    const rssByPid = await processRssMany(Object.values(pids));
    const procs = {};
    for (const [name, pid] of Object.entries(pids)) {
      if (pid && rssByPid[pid]) procs[name] = { pid, rssBytes: rssByPid[pid] };
    }

    // GPU tools are slow to shell out to; poll them a tenth as often.
    const now = Date.now();
    if (now - this.gpuCheckedAt > this.intervalMs * 10) {
      this.gpuCheckedAt = now;
      this.gpu = await gpuMemory();
    }

    const sample = {
      at: now,
      totalBytes: total,
      freeBytes: free,
      usedBytes: total - free,
      usedPct: +(((total - free) / total) * 100).toFixed(1),
      procs,
      gpu: this.gpu,
      loadAvg: process.platform === 'win32' ? null : os.loadavg()[0],
    };
    this.history.push({ at: sample.at, usedBytes: sample.usedBytes, modelBytes: sumProcs(procs) });
    if (this.history.length > HISTORY) this.history.shift();
    sample.history = this.history;
    this.onSample(sample);
    return sample;
  }
}

function sumProcs(procs) {
  return Object.values(procs).reduce((n, p) => n + (p.rssBytes || 0), 0);
}

module.exports = { Monitor, processRss, processRssMany, gpuMemory, GB };
