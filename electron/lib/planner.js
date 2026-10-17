'use strict';
// Turns (GGUF metadata + hardware) into a launch plan: does this model fit in
// the GPU budget, what should be pushed back to the CPU if it doesn't, and what
// throughput does the memory bus allow. Everything here is an estimate shown to
// the user, never a silent decision.
const GB = 1024 ** 3;

const KV_BYTES_PER_ELEM = {
  f32: 4, f16: 2, bf16: 2, q8_0: 1.0625, q5_1: 0.75, q5_0: 0.6875, q4_1: 0.5625, q4_0: 0.5,
};

function defaultProfile(modelPath, summary, hw) {
  const ctxCeiling = summary && summary.contextLength ? Math.min(summary.contextLength, 32768) : 8192;
  return {
    modelPath,
    name: (summary && summary.name) || 'model',
    backend: hw && hw.platform === 'win32' ? 'vulkan' : 'cpu',
    ctx: ctxCeiling,
    gpuLayers: 99,
    cpuMoe: 0,
    cpuMoeAll: false,
    cacheTypeK: 'q8_0',
    cacheTypeV: 'q8_0',
    flashAttn: 'on',
    batch: 2048,
    ubatch: 512,
    threads: hw && hw.cores ? Math.max(2, hw.cores - 2) : null,
    parallel: 1,
    contBatching: true,
    noMmap: false,
    mlock: false,
    jinja: true,
    draftModelPath: null,
    draftMax: 16,
    draftMin: 1,
    draftGpuLayers: 99,
    port: 8080,
    extraArgs: [],
    env: {},
  };
}

function headDim(s) {
  if (s.keyLength) return s.keyLength;
  if (s.embeddingLength && s.headCount) return Math.floor(s.embeddingLength / s.headCount);
  return 128;
}

function kvCacheBytes(summary, profile) {
  const s = summary || {};
  const layers = s.blockCount || 32;
  const kvHeads = s.headCountKV || s.headCount || 8;
  const dK = headDim(s);
  const dV = s.valueLength || dK;
  const bK = KV_BYTES_PER_ELEM[profile.cacheTypeK] ?? 2;
  const bV = KV_BYTES_PER_ELEM[profile.cacheTypeV] ?? 2;
  const slots = Math.max(1, profile.parallel || 1);
  // llama.cpp allocates one contiguous cache of ctx tokens shared across slots.
  const tokens = profile.ctx * (slots > 1 ? 1 : 1);
  return layers * tokens * kvHeads * (dK * bK + dV * bV);
}

// Compute buffers scale with the micro-batch and the widest tensor in a layer.
function computeOverheadBytes(summary, profile) {
  const s = summary || {};
  const embd = s.embeddingLength || 4096;
  const perToken = embd * 4 * 6; // activations in f32 across a handful of live tensors
  const batchPart = (profile.ubatch || 512) * perToken;
  return 400 * 1024 * 1024 + batchPart;
}

function activeBytesPerToken(summary, modelBytes) {
  const s = summary || {};
  if (!s.isMoE || !s.expertCount || !s.expertUsedCount) return modelBytes;
  const expertBytes = s.expertBytesApprox || modelBytes * 0.85;
  const dense = Math.max(0, modelBytes - expertBytes);
  return dense + expertBytes * (s.expertUsedCount / s.expertCount);
}

/**
 * Full fit + throughput analysis.
 * budgetGB is what the user allows the GPU to hold (on a unified-memory box this
 * is the driver's graphics carve-out, not a physical card size).
 */
function plan({ summary, profile, hw, budgetGB }) {
  const modelBytes = (summary && summary.sizeBytes) || 0;
  const kv = kvCacheBytes(summary, profile);
  const overhead = computeOverheadBytes(summary, profile);
  const budget = (budgetGB || (hw && hw.suggestedGpuBudgetGB) || 8) * GB;

  const expertBytes = (summary && summary.expertBytesApprox) || 0;
  const layers = (summary && summary.blockCount) || 32;
  const perLayerExperts = expertBytes && layers ? expertBytes / layers : 0;

  // What the profile has already asked to keep off the GPU.
  let offloadedExpertBytes = 0;
  if (profile.cpuMoeAll) offloadedExpertBytes = expertBytes;
  else if (profile.cpuMoe > 0) offloadedExpertBytes = Math.min(expertBytes, perLayerExperts * profile.cpuMoe);

  const gpuBytes = Math.max(0, modelBytes - offloadedExpertBytes) + kv + overhead;
  const fits = gpuBytes <= budget;
  const overflow = Math.max(0, gpuBytes - budget);

  const advice = [];
  let recommendedCpuMoe = profile.cpuMoe;
  if (!fits) {
    if (perLayerExperts > 0) {
      const needed = profile.cpuMoe + Math.ceil(overflow / perLayerExperts);
      recommendedCpuMoe = Math.min(layers, needed);
      if (needed <= layers) {
        advice.push({
          level: 'fix',
          text: 'Over budget by ' + fmtGB(overflow) + '. Set --n-cpu-moe to ' + recommendedCpuMoe +
            ' to keep that many layers’ experts in CPU memory (experts are the cheapest thing to move: '
            + fmtGB(perLayerExperts) + '/layer, and only ' + (summary.expertUsedCount || '?') + ' of '
            + (summary.expertCount || '?') + ' fire per token).',
          apply: { cpuMoe: recommendedCpuMoe },
        });
      } else {
        // Offloading every expert still leaves it over budget, so say that
        // plainly rather than recommend a number that cannot work.
        const freeable = perLayerExperts * (layers - profile.cpuMoe);
        advice.push({
          level: 'fix',
          text: 'Over budget by ' + fmtGB(overflow) + ', and moving every layer’s experts to CPU memory only frees '
            + fmtGB(freeable) + ' — about ' + fmtGB(overflow - freeable) + ' short. Raise the GPU budget, cut the '
            + 'context, or use a smaller quantisation.',
          apply: { cpuMoeAll: true },
        });
      }
    } else if (!summary || !summary.isMoE) {
      advice.push({
        level: 'fix',
        text: 'Over budget by ' + fmtGB(overflow) + '. This is a dense model, so there are no experts to peel off: '
          + 'lower -ngl to leave whole layers in CPU memory, cut the context, or use a smaller quantisation.',
      });
    }
    if (profile.cacheTypeK === 'f16') {
      advice.push({
        level: 'fix',
        text: 'KV cache is f16. q8_0 halves it (' + fmtGB(kv) + ' → ' + fmtGB(kv / 2) + ') for a barely measurable quality cost.',
        apply: { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' },
      });
    }
    if (profile.ctx > 8192) {
      const halved = kvCacheBytes(summary, { ...profile, ctx: Math.floor(profile.ctx / 2) });
      advice.push({
        level: 'option',
        text: 'Halving context to ' + Math.floor(profile.ctx / 2) + ' frees ' + fmtGB(kv - halved) + ' of KV cache.',
        apply: { ctx: Math.floor(profile.ctx / 2) },
      });
    }
    if (hw && hw.platform === 'win32') {
      advice.push({
        level: 'note',
        text: 'On this box the GPU budget is the driver carve-out: AMD Software → Performance → Tuning → Variable Graphics Memory. Raising it is better than spilling into shared memory, which collapses throughput.',
      });
    }
  }
  if (profile.cacheTypeK !== profile.cacheTypeV) {
    advice.push({ level: 'note', text: 'Mismatched K/V cache types work but are rarely worth the asymmetry.' });
  }
  if (profile.flashAttn === 'off' && profile.ctx > 4096) {
    advice.push({
      level: 'option',
      text: 'Flash attention off at ' + profile.ctx + ' context costs both memory and prompt-processing speed.',
      apply: { flashAttn: 'on' },
    });
  }
  if (summary && summary.isMoE && profile.ubatch < 512) {
    advice.push({ level: 'option', text: 'Micro-batch below 512 slows prompt processing on a wide memory bus with no memory saving worth having.', apply: { ubatch: 512 } });
  }

  const activeBytes = activeBytesPerToken(summary, modelBytes);
  const bw = hw && hw.bandwidth ? hw.bandwidth.gbPerSec : null;
  // Decode is a memory-bandwidth problem: one pass over the active weights per
  // token. ~70% of theoretical peak is what real kernels reach on these parts.
  const estTokPerSec = bw && activeBytes
    ? +((bw * 1e9 * 0.7) / activeBytes).toFixed(1)
    : null;
  // Anything served from CPU memory crosses the same bus twice (read + copy),
  // so offloaded bytes cost roughly double.
  const estTokPerSecOffloaded = bw && activeBytes && offloadedExpertBytes
    ? +((bw * 1e9 * 0.7) / (activeBytes + offloadedExpertBytes * (summary.expertUsedCount / Math.max(1, summary.expertCount)))).toFixed(1)
    : estTokPerSec;

  return {
    modelBytes, kvBytes: kv, overheadBytes: overhead,
    offloadedExpertBytes, gpuBytes, budgetBytes: budget, fits, overflow,
    perLayerExpertBytes: perLayerExperts,
    recommendedCpuMoe,
    activeBytesPerToken: activeBytes,
    estTokPerSec: offloadedExpertBytes ? estTokPerSecOffloaded : estTokPerSec,
    estTokPerSecResident: estTokPerSec,
    advice,
  };
}

function buildArgs(profile) {
  const a = ['-m', profile.modelPath, '--host', '127.0.0.1', '--port', String(profile.port || 8080)];
  a.push('-c', String(profile.ctx));
  a.push('-ngl', String(profile.gpuLayers));
  if (profile.cpuMoeAll) a.push('--cpu-moe');
  else if (profile.cpuMoe > 0) a.push('--n-cpu-moe', String(profile.cpuMoe));
  if (profile.cacheTypeK) a.push('--cache-type-k', profile.cacheTypeK);
  if (profile.cacheTypeV) a.push('--cache-type-v', profile.cacheTypeV);
  if (profile.flashAttn === 'on' || profile.flashAttn === 'off') a.push('--flash-attn', profile.flashAttn);
  if (profile.batch) a.push('-b', String(profile.batch));
  if (profile.ubatch) a.push('-ub', String(profile.ubatch));
  if (profile.threads) a.push('-t', String(profile.threads));
  if (profile.parallel && profile.parallel > 1) a.push('--parallel', String(profile.parallel));
  if (profile.contBatching) a.push('--cont-batching');
  if (profile.noMmap) a.push('--no-mmap');
  if (profile.mlock) a.push('--mlock');
  if (profile.jinja) a.push('--jinja');
  if (profile.draftModelPath) {
    a.push('-md', profile.draftModelPath);
    a.push('--draft-max', String(profile.draftMax || 16));
    a.push('--draft-min', String(profile.draftMin || 1));
    a.push('-ngld', String(profile.draftGpuLayers || 99));
  }
  if (Array.isArray(profile.extraArgs)) a.push(...profile.extraArgs.filter(Boolean));
  return a;
}

function buildEnv(profile) {
  const env = { ...(profile.env || {}) };
  if (profile.backend === 'rocm') {
    // hipBLASLt ships tuned kernels for gfx1151; this is the single biggest
    // prompt-processing win on Strix Halo under ROCm.
    if (!env.ROCBLAS_USE_HIPBLASLT) env.ROCBLAS_USE_HIPBLASLT = '1';
    if (!env.HSA_OVERRIDE_GFX_VERSION && profile.gfxOverride) env.HSA_OVERRIDE_GFX_VERSION = profile.gfxOverride;
  }
  return env;
}

function fmtGB(bytes) {
  if (!bytes) return '0 GiB';
  const gb = bytes / GB;
  return (gb < 1 ? (bytes / (1024 * 1024)).toFixed(0) + ' MiB' : gb.toFixed(2) + ' GiB');
}

module.exports = { defaultProfile, plan, buildArgs, buildEnv, kvCacheBytes, fmtGB, GB };
