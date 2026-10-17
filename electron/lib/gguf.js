'use strict';
// Minimal GGUF metadata reader. We only need the header key/values -- never the
// tensor data -- so this streams the first few MB of the file and stops as soon
// as the metadata block is consumed.
const fs = require('fs');

const T = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5,
  FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
};

class Cursor {
  constructor(fd, chunk = 1 << 20) {
    this.fd = fd;
    this.chunk = chunk;
    this.buf = Buffer.alloc(0);
    this.pos = 0;      // read offset inside buf
    this.filePos = 0;  // next byte to pull from the file
    this.refill();
  }
  refill() {
    const next = Buffer.alloc(this.chunk);
    const n = fs.readSync(this.fd, next, 0, this.chunk, this.filePos);
    if (n <= 0) return false;
    this.filePos += n;
    this.buf = Buffer.concat([this.buf.subarray(this.pos), next.subarray(0, n)]);
    this.pos = 0;
    return true;
  }
  need(n) {
    while (this.buf.length - this.pos < n) {
      if (!this.refill()) throw new Error('unexpected end of GGUF header');
    }
  }
  u8() { this.need(1); return this.buf[this.pos++]; }
  i8() { this.need(1); return this.buf.readInt8(this.pos++); }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  f32() { this.need(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  u64() { this.need(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return Number(v); }
  i64() { this.need(8); const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return Number(v); }
  bool() { return this.u8() !== 0; }
  str() {
    const len = this.u64();
    if (len > 64 * 1024 * 1024) throw new Error('implausible GGUF string length');
    this.need(len);
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  bytes(n) { this.need(n); this.pos += n; }
}

function readScalar(c, type) {
  switch (type) {
    case T.UINT8: return c.u8();
    case T.INT8: return c.i8();
    case T.UINT16: return c.u16();
    case T.INT16: return c.i16();
    case T.UINT32: return c.u32();
    case T.INT32: return c.i32();
    case T.FLOAT32: return c.f32();
    case T.BOOL: return c.bool();
    case T.STRING: return c.str();
    case T.UINT64: return c.u64();
    case T.INT64: return c.i64();
    case T.FLOAT64: return c.f64();
    default: throw new Error('unknown GGUF value type ' + type);
  }
}

// Arrays in GGUF headers are usually the tokenizer vocab -- hundreds of
// thousands of strings we have no use for. Keep short arrays, count the rest.
const ARRAY_KEEP_MAX = 64;

function readArray(c, key) {
  const type = c.u32();
  const count = c.u64();
  const keep = count <= ARRAY_KEEP_MAX && type !== T.ARRAY;
  const out = keep ? [] : null;
  for (let i = 0; i < count; i++) {
    const v = type === T.ARRAY ? readArray(c, key) : readScalar(c, type);
    if (keep) out.push(v);
  }
  return keep ? out : { __elided: true, count, type };
}

const GGML_TYPE_NAMES = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0',
  9: 'Q8_1', 10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K',
  15: 'Q8_K', 16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S',
  20: 'IQ4_NL', 21: 'IQ3_S', 22: 'IQ2_S', 23: 'IQ4_XS', 24: 'I8', 25: 'I16',
  26: 'I32', 27: 'I64', 28: 'F64', 29: 'IQ1_M', 30: 'BF16', 34: 'TQ1_0', 35: 'TQ2_0',
};

const FILE_TYPE_NAMES = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S',
  15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS',
  20: 'IQ2_XS', 21: 'Q2_K_S', 22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S',
  25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M', 28: 'IQ2_S', 29: 'IQ2_M',
  30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16', 36: 'TQ1_0', 37: 'TQ2_0',
};

/**
 * Read GGUF header metadata.
 * Returns { ok, path, sizeBytes, version, tensorCount, arch, kv, tensorTypes, summary }
 * On a malformed/absent file it returns { ok: false, error } rather than throwing,
 * because this runs against whatever paths a user points at.
 */
function readGGUF(filePath, { withTensors = true } = {}) {
  let fd;
  try {
    const st = fs.statSync(filePath);
    fd = fs.openSync(filePath, 'r');
    const c = new Cursor(fd);
    const magic = Buffer.from([c.u8(), c.u8(), c.u8(), c.u8()]).toString('ascii');
    if (magic !== 'GGUF') throw new Error('not a GGUF file (magic=' + JSON.stringify(magic) + ')');
    const version = c.u32();
    if (version < 2 || version > 3) throw new Error('unsupported GGUF version ' + version);
    const tensorCount = c.u64();
    const kvCount = c.u64();
    if (kvCount > 100000) throw new Error('implausible metadata count');

    const kv = {};
    for (let i = 0; i < kvCount; i++) {
      const key = c.str();
      const type = c.u32();
      kv[key] = type === T.ARRAY ? readArray(c, key) : readScalar(c, type);
    }

    // Tensor descriptors tell us the real quant mix, which matters for MoE:
    // expert tensors are often quantised differently from attention tensors.
    const tensorTypes = {};
    let expertBytesApprox = 0;
    if (withTensors) {
      try {
        for (let i = 0; i < tensorCount; i++) {
          const name = c.str();
          const nDims = c.u32();
          const dims = [];
          for (let d = 0; d < nDims; d++) dims.push(c.u64());
          const ggmlType = c.u32();
          c.bytes(8); // offset
          const tn = GGML_TYPE_NAMES[ggmlType] || ('type' + ggmlType);
          tensorTypes[tn] = (tensorTypes[tn] || 0) + 1;
          if (/\.ffn_(gate|up|down)_exps\./.test(name) || /\.experts?\./.test(name)) {
            const elems = dims.reduce((a, b) => a * b, 1);
            expertBytesApprox += elems * bitsPerWeight(tn) / 8;
          }
        }
      } catch (e) {
        // Tensor descriptors are a bonus; metadata alone is still useful.
        tensorTypes.__partial = true;
      }
    }

    const arch = typeof kv['general.architecture'] === 'string' ? kv['general.architecture'] : 'unknown';
    const g = (suffix) => kv[arch + '.' + suffix];
    const expertCount = num(g('expert_count'));
    const summary = {
      arch,
      name: str(kv['general.name']) || require('path').basename(filePath),
      quant: FILE_TYPE_NAMES[num(kv['general.file_type'])] || dominantTensorType(tensorTypes) || 'unknown',
      paramsB: num(kv['general.parameter_count']) ? num(kv['general.parameter_count']) / 1e9 : null,
      contextLength: num(g('context_length')),
      blockCount: num(g('block_count')),
      embeddingLength: num(g('embedding_length')),
      headCount: num(g('attention.head_count')),
      headCountKV: num(g('attention.head_count_kv')) ?? num(g('attention.head_count')),
      keyLength: num(g('attention.key_length')),
      valueLength: num(g('attention.value_length')),
      expertCount: expertCount ?? 0,
      expertUsedCount: num(g('expert_used_count')) ?? 0,
      isMoE: !!(expertCount && expertCount > 1),
      expertBytesApprox: expertBytesApprox || null,
      sizeBytes: st.size,
    };
    return { ok: true, path: filePath, sizeBytes: st.size, version, tensorCount, arch, kv, tensorTypes, summary };
  } catch (err) {
    return { ok: false, path: filePath, error: err.message };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* already gone */ } }
  }
}

function bitsPerWeight(typeName) {
  const table = {
    F32: 32, F16: 16, BF16: 16, Q8_0: 8.5, Q8_1: 9, Q6_K: 6.5625, Q5_K: 5.5,
    Q5_0: 5.5, Q5_1: 6, Q4_K: 4.5, Q4_0: 4.5, Q4_1: 5, Q3_K: 3.4375,
    Q2_K: 2.625, IQ4_XS: 4.25, IQ4_NL: 4.5, IQ3_S: 3.44, IQ3_XXS: 3.06,
    IQ2_S: 2.5, IQ2_XS: 2.31, IQ2_XXS: 2.06, IQ1_S: 1.56, IQ1_M: 1.75,
  };
  return table[typeName] || 4.5;
}

function dominantTensorType(types) {
  let best = null, bestN = 0;
  for (const [k, v] of Object.entries(types)) {
    if (k.startsWith('__')) continue;
    if (v > bestN) { best = k; bestN = v; }
  }
  return best;
}

function num(v) { return typeof v === 'number' ? v : undefined; }
function str(v) { return typeof v === 'string' ? v : undefined; }

module.exports = { readGGUF, bitsPerWeight };
