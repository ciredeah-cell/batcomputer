'use strict';
// Builds a small, valid GGUF file with MoE metadata. Used by the self-test and
// by the smoke check so both can exercise the model-library and planner paths
// without a multi-gigabyte download.
const fs = require('fs');

function buildFixtureGGUF(file, opts = {}) {
  const {
    layers = 24, experts = 64, used = 8, embd = 2048,
    heads = 16, kvHeads = 4, name = 'Laguna XS (fixture)', padBytes = 1 << 20,
  } = opts;

  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (s) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
  const kvStr = (k, v) => Buffer.concat([str(k), u32(8), str(v)]);
  const kvU32 = (k, v) => Buffer.concat([str(k), u32(4), u32(v)]);
  const kvU64 = (k, v) => Buffer.concat([str(k), u32(10), u64(v)]);
  const kvArr = (k, values) => Buffer.concat([str(k), u32(9), u32(8), u64(values.length), ...values.map(str)]);

  const kvs = [
    kvStr('general.architecture', 'llamoe'),
    kvStr('general.name', name),
    kvU32('general.file_type', 15),
    kvU64('general.parameter_count', 21_000_000_000),
    kvU32('llamoe.block_count', layers),
    kvU32('llamoe.context_length', 32768),
    kvU32('llamoe.embedding_length', embd),
    kvU32('llamoe.attention.head_count', heads),
    kvU32('llamoe.attention.head_count_kv', kvHeads),
    kvU32('llamoe.attention.key_length', 128),
    kvU32('llamoe.expert_count', experts),
    kvU32('llamoe.expert_used_count', used),
    kvArr('tokenizer.ggml.tokens', ['a', 'b', 'c']),
  ];

  // One expert tensor and one attention tensor per layer, so the reader sees a
  // realistic quant mix and can measure expert bytes.
  const tensors = [];
  for (let l = 0; l < layers; l++) {
    tensors.push({ name: 'blk.' + l + '.ffn_gate_exps.weight', dims: [embd, 256, experts], type: 12 });
    tensors.push({ name: 'blk.' + l + '.attn_q.weight', dims: [embd, embd], type: 14 });
  }
  const tensorBufs = tensors.map((t) => Buffer.concat([
    str(t.name), u32(t.dims.length), ...t.dims.map(u64), u32(t.type), u64(0),
  ]));

  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('GGUF', 'ascii'), u32(3), u64(tensors.length), u64(kvs.length),
    ...kvs, ...tensorBufs,
    Buffer.alloc(padBytes),   // stand-in for tensor data
  ]));
  return file;
}

module.exports = { buildFixtureGGUF };
