'use strict';
// Streaming chat against llama-server's OpenAI-compatible endpoint, including
// tool calls. Small local models are inconsistent about emitting structured
// tool_calls even with --jinja, so there is a text fallback that recovers the
// common shapes they fall back to instead.

/**
 * @returns {Promise<{content,reasoning,toolCalls,finishReason,usage,timings,raw}>}
 */
async function chatStream({ baseUrl, messages, tools, sampling = {}, signal, onDelta, onReasoning }) {
  const body = {
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: sampling.temperature ?? 0.7,
    top_p: sampling.top_p ?? 0.95,
    max_tokens: sampling.max_tokens ?? 2048,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (sampling.repeat_penalty) body.repeat_penalty = sampling.repeat_penalty;
  if (sampling.seed !== undefined && sampling.seed !== null) body.seed = sampling.seed;

  const res = await fetch(baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('llama-server returned ' + res.status + ': ' + text.slice(0, 500));
  }

  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  let timings = null;
  const calls = new Map(); // index -> { id, name, args }

  for await (const event of sseLines(res.body)) {
    if (event === '[DONE]') break;
    let chunk;
    try { chunk = JSON.parse(event); } catch (_) { continue; }
    if (chunk.usage) usage = chunk.usage;
    if (chunk.timings) timings = chunk.timings;
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || {};
    if (typeof d.content === 'string' && d.content) {
      content += d.content;
      if (onDelta) onDelta(d.content);
    }
    // llama-server surfaces chain-of-thought separately for models whose
    // template has a reasoning channel.
    const r = d.reasoning_content || d.reasoning;
    if (typeof r === 'string' && r) {
      reasoning += r;
      if (onReasoning) onReasoning(r);
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? calls.size;
        const cur = calls.get(idx) || { id: null, name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function && tc.function.name) cur.name += tc.function.name;
        if (tc.function && typeof tc.function.arguments === 'string') cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
    }
  }

  let toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, c], i) => ({
      id: c.id || 'call_' + Date.now() + '_' + i,
      name: c.name,
      arguments: parseArgs(c.args),
      rawArguments: c.args,
    }))
    .filter((c) => c.name);

  if (!toolCalls.length) {
    const recovered = recoverTextToolCalls(content);
    if (recovered.calls.length) {
      toolCalls = recovered.calls;
      content = recovered.cleaned;
    }
  }

  return { content, reasoning, toolCalls, finishReason, usage, timings };
}

function parseArgs(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { /* fall through */ }
  // Some templates double-encode the argument object as a JSON string.
  try {
    const once = JSON.parse(JSON.stringify(raw));
    if (typeof once === 'string') return JSON.parse(once);
  } catch (_) { /* fall through */ }
  const repaired = raw.trim().replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(repaired); } catch (_) { return { __unparsed: raw }; }
}

// Shapes small models emit when the template fails to produce real tool_calls:
//   <tool_call>{"name": "...", "arguments": {...}}</tool_call>
//   ```json {"name": "...", "arguments": {...}} ```
//   [TOOL_CALL] {...}
const TEXT_CALL_PATTERNS = [
  /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g,
  /<\|tool_call\|>\s*([\s\S]*?)\s*(?:<\|\/tool_call\|>|$)/g,
  /\[TOOL_CALLS?\]\s*([\s\S]*?)(?:\n\n|$)/g,
  /```(?:json|tool_call)\s*([\s\S]*?)```/g,
];

function recoverTextToolCalls(text) {
  if (!text || text.indexOf('{') === -1) return { calls: [], cleaned: text };
  const calls = [];
  let cleaned = text;
  for (const re of TEXT_CALL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      for (const obj of jsonObjects(m[1])) {
        const name = obj.name || obj.tool || obj.function;
        const args = obj.arguments || obj.parameters || obj.args || {};
        if (typeof name === 'string' && name) {
          calls.push({
            id: 'call_text_' + calls.length + '_' + Date.now(),
            name,
            arguments: typeof args === 'string' ? parseArgs(args) : args,
            rawArguments: JSON.stringify(args),
            recovered: true,
          });
          cleaned = cleaned.replace(m[0], '');
        }
      }
    }
    if (calls.length) break;
  }
  return { calls, cleaned: cleaned.trim() };
}

// Pull top-level JSON objects out of a blob, brace-matching so nested objects
// (a write_file body, for instance) survive intact.
function jsonObjects(blob) {
  const out = [];
  const s = String(blob || '');
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(s.slice(start, i + 1))); } catch (_) { /* not valid, skip */ }
        start = -1;
      }
    }
  }
  return out;
}

/** Iterate `data:` payloads from an SSE body stream. */
async function* sseLines(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  const tail = buf.trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trim();
}

/** Non-streaming single-shot completion, used for title generation. */
async function chatOnce({ baseUrl, messages, sampling = {}, signal }) {
  const res = await fetch(baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages,
      temperature: sampling.temperature ?? 0.3,
      max_tokens: sampling.max_tokens ?? 64,
    }),
    signal,
  });
  if (!res.ok) throw new Error('llama-server returned ' + res.status);
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

module.exports = { chatStream, chatOnce, recoverTextToolCalls, jsonObjects };
