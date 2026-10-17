'use strict';
// Hardware probe. Target box is a Windows unified-memory mini PC (Ryzen AI Max
// class): system RAM is also graphics memory, so "how much can the GPU have"
// is a BIOS/driver setting rather than a fixed card size. We report what we can
// see and let the user correct it -- a wrong guess here produces bad offload
// advice, so every number is editable in the UI.
const os = require('os');
const { execFile } = require('child_process');

const GB = 1024 ** 3;

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

async function probeWindows() {
  const ps = [
    '-NoProfile', '-NonInteractive', '-Command',
    [
      '$cs = Get-CimInstance Win32_ComputerSystem;',
      '$os = Get-CimInstance Win32_OperatingSystem;',
      '$gpu = Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion;',
      '$mem = Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity,Speed,ConfiguredClockSpeed;',
      '$cpu = Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors;',
      'ConvertTo-Json -Depth 4 -Compress @{cs=@{TotalPhysicalMemory=$cs.TotalPhysicalMemory};',
      'os=@{Caption=$os.Caption;Version=$os.Version;FreePhysicalMemory=$os.FreePhysicalMemory};',
      'gpu=@($gpu); mem=@($mem); cpu=@($cpu)}',
    ].join(' '),
  ];
  const out = await run('powershell.exe', ps, 15000);
  if (!out) return null;
  try {
    const j = JSON.parse(out);
    const gpus = (Array.isArray(j.gpu) ? j.gpu : [j.gpu]).filter(Boolean).map((g) => ({
      name: g.Name,
      // AdapterRAM is a 32-bit field, so it saturates at 4 GiB and is simply
      // wrong for a big iGPU carve-out. Treat it as a hint, never as truth.
      vramBytesReported: typeof g.AdapterRAM === 'number' ? g.AdapterRAM : null,
      driver: g.DriverVersion,
    }));
    const dimms = (Array.isArray(j.mem) ? j.mem : [j.mem]).filter(Boolean).map((m) => ({
      capacityBytes: Number(m.Capacity) || 0,
      speedMTs: m.ConfiguredClockSpeed || m.Speed || null,
    }));
    const cpu = (Array.isArray(j.cpu) ? j.cpu : [j.cpu]).filter(Boolean)[0] || {};
    return {
      platform: 'win32',
      os: j.os && j.os.Caption ? j.os.Caption + ' ' + j.os.Version : os.release(),
      cpuName: cpu.Name || os.cpus()[0].model,
      cores: cpu.NumberOfCores || null,
      threads: cpu.NumberOfLogicalProcessors || os.cpus().length,
      totalRamBytes: Number(j.cs && j.cs.TotalPhysicalMemory) || os.totalmem(),
      freeRamBytes: j.os && j.os.FreePhysicalMemory ? Number(j.os.FreePhysicalMemory) * 1024 : os.freemem(),
      gpus,
      dimms,
    };
  } catch (_) {
    return null;
  }
}

async function probePosix() {
  let gpus = [];
  const lspci = await run('sh', ['-c', 'lspci 2>/dev/null | grep -iE "vga|3d|display"']);
  if (lspci) {
    gpus = lspci.trim().split('\n').filter(Boolean).map((l) => ({
      name: l.replace(/^\S+\s+/, ''), vramBytesReported: null, driver: null,
    }));
  }
  return {
    platform: process.platform,
    os: os.type() + ' ' + os.release(),
    cpuName: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
    cores: null,
    threads: os.cpus().length,
    totalRamBytes: os.totalmem(),
    freeRamBytes: os.freemem(),
    gpus,
    dimms: [],
  };
}

// Memory bandwidth is the binding constraint on these boxes, and nothing in
// WMI reports it directly. Derive it from DIMM/LPDDR clock and bus width where
// we recognise the part, otherwise leave it null and show "unknown".
const KNOWN_PLATFORMS = [
  { match: /ryzen\s+ai\s+max\+?\s*(395|390|385)/i, busBits: 256, label: 'Strix Halo (256-bit LPDDR5X)' },
  { match: /ryzen\s+ai\s+9\s+hx/i, busBits: 128, label: 'Strix Point (128-bit LPDDR5X)' },
  { match: /ultra\s+(7|9)\s+2\d\dv/i, busBits: 128, label: 'Lunar Lake (128-bit LPDDR5X)' },
];

function estimateBandwidth(hw) {
  const plat = KNOWN_PLATFORMS.find((p) => p.match.test(hw.cpuName || ''));
  const mts = hw.dimms.map((d) => d.speedMTs).filter(Boolean).sort((a, b) => b - a)[0] || null;
  if (!plat) return { gbPerSec: null, basis: mts ? mts + ' MT/s, unknown bus width' : 'unknown' };
  const effectiveMts = mts || (plat.busBits === 256 ? 8000 : 7500);
  const gbPerSec = (effectiveMts * plat.busBits) / 8 / 1000;
  return {
    gbPerSec: Math.round(gbPerSec),
    basis: plat.label + ' @ ' + effectiveMts + ' MT/s' + (mts ? '' : ' (assumed)'),
  };
}

async function probe() {
  const hw = (process.platform === 'win32' ? await probeWindows() : null) || await probePosix();
  hw.bandwidth = estimateBandwidth(hw);
  hw.totalRamGB = +(hw.totalRamBytes / GB).toFixed(1);
  hw.freeRamGB = +(hw.freeRamBytes / GB).toFixed(1);
  hw.unified = hw.gpus.some((g) => /radeon\s*(8\d\d\ds|graphics)|ryzen|arc.*graphics|iris|vega/i.test(g.name || ''))
    || hw.gpus.length === 0;
  // Default GPU budget: on a unified box the practical ceiling is roughly total
  // RAM minus what Windows and your apps need. 12 GiB of headroom is the floor
  // that keeps the desktop responsive while a model is resident.
  hw.suggestedGpuBudgetGB = Math.max(4, Math.floor(hw.totalRamGB - Math.max(12, hw.totalRamGB * 0.18)));
  return hw;
}

module.exports = { probe, estimateBandwidth, GB };
