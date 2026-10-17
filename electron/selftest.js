'use strict';
/* Headless self-test for everything that does not need Electron or Windows.
 *
 * Run with `npm run selftest`. It builds a synthetic MoE GGUF, checks the
 * planner's offload maths, exercises the tool sandbox, and runs the real agent
 * loop against a mock OpenAI-compatible server that emits a tool call -- so the
 * stream parser, the tool dispatch, and the approval gate are all covered
 * without a model, a GPU, or a Windows box. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const gguf = require('./lib/gguf');
const planner = require('./lib/planner');
const tools = require('./lib/tools');
const local = require('./lib/backends/local');
const { LocalAgent } = require('./lib/agent');
const cli = require('./lib/cli-agent');
const { buildFixtureGGUF: buildGGUF } = require('./lib/fixture-gguf');
const { SessionStore } = require('./lib/sessions');
const comfy = require('./lib/comfy');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (err) { failures.push({ name, err }); console.log('  FAIL ' + name + '\n       ' + err.message); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batcomputer-test-'));

/* --------------------------- mock llama-server ---------------------------- */

function startMockServer({ script }) {
  let step = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
    if (req.url === '/props') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"model_path":"mock"}'); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }

    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const chunks = script(step++, payload);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests: () => step }));
  });
}

const textChunk = (text, finish = null) => ({
  choices: [{ delta: text ? { content: text } : {}, finish_reason: finish }],
});

/* --------------------------------- tests --------------------------------- */

async function main() {
  console.log('\nbatcomputer self-test\n');

  console.log('syntax');
  await test('every source file parses', () => {
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
        else if (e.name.endsWith('.js')) files.push(p);
      }
    };
    walk(path.join(__dirname, '..', 'electron'));
    walk(path.join(__dirname, '..', 'renderer'));
    for (const f of files) execFileSync(process.execPath, ['--check', f]);
    assert.ok(files.length >= 9, 'expected at least 9 source files, found ' + files.length);
  });

  console.log('\ngguf reader');
  const modelFile = buildGGUF(path.join(tmp, 'fixture-moe.gguf'));
  let summary;
  await test('reads MoE metadata from a real header', () => {
    const r = gguf.readGGUF(modelFile);
    assert.ok(r.ok, r.error);
    summary = r.summary;
    assert.strictEqual(summary.arch, 'llamoe');
    assert.strictEqual(summary.blockCount, 24);
    assert.strictEqual(summary.expertCount, 64);
    assert.strictEqual(summary.expertUsedCount, 8);
    assert.strictEqual(summary.isMoE, true);
    assert.strictEqual(summary.quant, 'Q4_K_M');
    assert.ok(summary.expertBytesApprox > 0, 'expert bytes should be measured from tensor descriptors');
    assert.ok(summary.sizeBytes > 1 << 20);
  });
  await test('elides the tokenizer vocab instead of loading it', () => {
    const r = gguf.readGGUF(modelFile);
    assert.deepStrictEqual(r.kv['tokenizer.ggml.tokens'], ['a', 'b', 'c']);
  });
  await test('reports a bad file instead of throwing', () => {
    const bad = path.join(tmp, 'not-a-model.gguf');
    fs.writeFileSync(bad, 'hello');
    const r = gguf.readGGUF(bad);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /GGUF|end of/i);
  });

  console.log('\nplanner');
  const hw = { platform: 'win32', cores: 16, totalRamGB: 64, suggestedGpuBudgetGB: 48, bandwidth: { gbPerSec: 256, basis: 'test' } };
  await test('default profile respects the model context ceiling', () => {
    const p = planner.defaultProfile(modelFile, summary, hw);
    assert.strictEqual(p.ctx, 32768);
    assert.strictEqual(p.cacheTypeK, 'q8_0');
    assert.strictEqual(p.jinja, true);
  });
  await test('KV cache maths tracks context and quantisation', () => {
    const base = { ...planner.defaultProfile(modelFile, summary, hw), ctx: 8192, cacheTypeK: 'f16', cacheTypeV: 'f16' };
    const f16 = planner.kvCacheBytes(summary, base);
    const q8 = planner.kvCacheBytes(summary, { ...base, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' });
    const expected = 24 * 8192 * 4 * (128 * 2 + 128 * 2);
    assert.strictEqual(f16, expected);
    assert.ok(q8 < f16 * 0.6 && q8 > f16 * 0.45, 'q8_0 should roughly halve the cache, got ' + q8 + ' vs ' + f16);
  });
  // A 30 GiB MoE where 85% of the bytes are experts: the realistic shape.
  const bigMoE = { ...summary, sizeBytes: 30 * planner.GB, expertBytesApprox: 25.5 * planner.GB };
  await test('an over-budget plan recommends an n-cpu-moe value that fits', () => {
    const profile = { ...planner.defaultProfile(modelFile, summary, hw), ctx: 32768 };
    const tight = planner.plan({ summary: bigMoE, profile, hw, budgetGB: 20 });
    assert.strictEqual(tight.fits, false);
    const fix = tight.advice.find((a) => a.apply && a.apply.cpuMoe);
    assert.ok(fix, 'expected an --n-cpu-moe suggestion');
    const after = planner.plan({ summary: bigMoE, profile: { ...profile, ...fix.apply }, hw, budgetGB: 20 });
    assert.strictEqual(after.fits, true, 'applying the suggestion should fit, still over by ' + after.overflow);
  });
  await test('says so when even full expert offload cannot fit', () => {
    const profile = { ...planner.defaultProfile(modelFile, summary, hw), ctx: 32768 };
    const hopeless = planner.plan({ summary: bigMoE, profile, hw, budgetGB: 3 });
    assert.strictEqual(hopeless.fits, false);
    const fix = hopeless.advice.find((a) => a.level === 'fix');
    assert.match(fix.text, /only frees|short/, 'should admit offloading is not enough: ' + fix.text);
    assert.ok(!hopeless.advice.some((a) => a.apply && a.apply.cpuMoe), 'should not suggest a cpuMoe value that cannot work');
  });
  await test('dense models get layer advice, not expert advice', () => {
    const dense = { ...summary, isMoE: false, expertCount: 0, expertUsedCount: 0, expertBytesApprox: 0, sizeBytes: 20 * planner.GB };
    const p = planner.plan({ summary: dense, profile: planner.defaultProfile(modelFile, dense, hw), hw, budgetGB: 8 });
    const fix = p.advice.find((a) => a.level === 'fix');
    assert.match(fix.text, /dense model/);
  });
  await test('throughput estimate uses active bytes, not the whole file', () => {
    const profile = planner.defaultProfile(modelFile, summary, hw);
    const big = { ...summary, sizeBytes: 40 * planner.GB, expertBytesApprox: 36 * planner.GB };
    const p = planner.plan({ summary: big, profile, hw, budgetGB: 48 });
    assert.ok(p.activeBytesPerToken < big.sizeBytes / 4, 'MoE should read a fraction of the weights per token');
    assert.ok(p.estTokPerSec > 0);
  });
  await test('command line carries the offload flags', () => {
    const args = planner.buildArgs({ ...planner.defaultProfile(modelFile, summary, hw), cpuMoe: 7, flashAttn: 'on' });
    const joined = args.join(' ');
    assert.match(joined, /--n-cpu-moe 7/);
    assert.match(joined, /--cache-type-k q8_0/);
    assert.match(joined, /--flash-attn on/);
    assert.match(joined, /--jinja/);
  });
  await test('ROCm backend sets the hipBLASLt env var', () => {
    const env = planner.buildEnv({ backend: 'rocm' });
    assert.strictEqual(env.ROCBLAS_USE_HIPBLASLT, '1');
    assert.deepStrictEqual(planner.buildEnv({ backend: 'vulkan' }), {});
  });

  console.log('\ntools');
  const work = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src', 'a.js'), 'const x = 1;\nconst y = 2;\n');
  const ctx = new tools.ToolContext({ workspace: work });

  await test('refuses paths outside the workspace', async () => {
    const r = await tools.runTool(ctx, 'read_file', { path: '../../etc/passwd' });
    assert.ok(r.isError);
    assert.match(r.output, /outside the workspace/);
  });
  await test('read_file numbers lines', async () => {
    const r = await tools.runTool(ctx, 'read_file', { path: 'src/a.js' });
    assert.match(r.output, /1\tconst x = 1;/);
  });
  await test('edit_file refuses an ambiguous match', async () => {
    const r = await tools.runTool(ctx, 'edit_file', { path: 'src/a.js', old_string: 'const', new_string: 'let' });
    assert.ok(r.isError);
    assert.match(r.output, /appears 2 times/);
  });
  await test('edit_file applies a unique match', async () => {
    const r = await tools.runTool(ctx, 'edit_file', { path: 'src/a.js', old_string: 'const y = 2;', new_string: 'const y = 3;' });
    assert.ok(!r.isError, r.output);
    assert.match(fs.readFileSync(path.join(work, 'src', 'a.js'), 'utf8'), /const y = 3;/);
  });
  await test('glob and grep find the file', async () => {
    const g = await tools.runTool(ctx, 'glob', { pattern: '**/*.js' });
    assert.match(g.output, /a\.js/);
    const gr = await tools.runTool(ctx, 'grep', { pattern: 'const y' });
    assert.match(gr.output, /a\.js:2/);
  });
  await test('risk classification separates reads, writes and destruction', () => {
    assert.strictEqual(tools.classify('shell', { command: 'git log --oneline' }).risk, 'safe');
    assert.strictEqual(tools.classify('shell', { command: 'npm run build' }).risk, 'danger');
    assert.strictEqual(tools.classify('shell', { command: 'Remove-Item -Recurse -Force .' }).risk, 'destructive');
    assert.strictEqual(tools.classify('write_file', {}).risk, 'edit');
    // A read-only command with a shell operator is no longer read-only.
    assert.strictEqual(tools.classify('shell', { command: 'git log | rm -f x' }).risk, 'destructive');
    assert.strictEqual(tools.classify('shell', { command: 'ls > out.txt' }).risk, 'danger');
  });
  await test('no approval mode auto-approves a destructive command', () => {
    for (const mode of ['ask', 'acceptEdits', 'yolo']) {
      assert.strictEqual(tools.autoApproved('destructive', mode), false, mode + ' must still ask');
    }
    assert.strictEqual(tools.autoApproved('edit', 'ask'), false);
    assert.strictEqual(tools.autoApproved('edit', 'acceptEdits'), true);
    assert.strictEqual(tools.autoApproved('danger', 'yolo'), true);
  });
  await test('shell tool actually runs a command', async () => {
    const cmd = process.platform === 'win32' ? 'echo hello' : 'echo hello';
    const r = await tools.runTool(ctx, 'shell', { command: cmd });
    assert.match(r.output, /hello/);
  });

  console.log('\nstream parsing');
  await test('recovers a tool call emitted as plain text', () => {
    const { calls, cleaned } = local.recoverTextToolCalls(
      'Let me look.\n<tool_call>{"name": "list_dir", "arguments": {"path": "src"}}</tool_call>');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'list_dir');
    assert.deepStrictEqual(calls[0].arguments, { path: 'src' });
    assert.ok(!cleaned.includes('tool_call'));
  });
  await test('brace matching survives nested objects', () => {
    const objs = local.jsonObjects('{"name":"write_file","arguments":{"path":"a","content":"{ \\"k\\": 1 }"}}');
    assert.strictEqual(objs.length, 1);
    assert.strictEqual(objs[0].arguments.path, 'a');
  });
  await test('assembles streamed tool_call deltas', async () => {
    const mock = await startMockServer({
      script: () => [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_', arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'dir', arguments: 'th":"src"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ],
    });
    const r = await local.chatStream({ baseUrl: 'http://127.0.0.1:' + mock.port, messages: [{ role: 'user', content: 'x' }] });
    mock.server.close();
    assert.strictEqual(r.toolCalls.length, 1);
    assert.strictEqual(r.toolCalls[0].name, 'list_dir');
    assert.deepStrictEqual(r.toolCalls[0].arguments, { path: 'src' });
  });

  console.log('\nagent loop');
  await test('runs a tool call and returns the model answer', async () => {
    const mock = await startMockServer({
      script: (step, payload) => {
        if (step === 0) {
          assert.ok(Array.isArray(payload.tools) && payload.tools.length, 'tools should be advertised');
          return [
            textChunk('Checking the folder.'),
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'list_dir', arguments: '{"path":"src"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ];
        }
        const toolMsg = payload.messages.find((m) => m.role === 'tool');
        assert.ok(toolMsg, 'the tool result should be fed back');
        assert.match(toolMsg.content, /a\.js/, 'tool result should carry the listing');
        return [textChunk('There is one file, a.js.'), textChunk('', 'stop')];
      },
    });

    const events = [];
    const approvals = [];
    const agent = new LocalAgent({
      getStatus: () => ({ state: 'ready', baseUrl: 'http://127.0.0.1:' + mock.port }),
      onEvent: (e) => events.push(e),
      requestApproval: async (req) => { approvals.push(req); return 'allow'; },
      getConfig: () => ({ ctx: 8192, sampling: { max_tokens: 512 } }),
    });
    const res = await agent.send({
      text: 'what is in src?', toolCtx: ctx, modelName: 'mock', sampling: {}, approvalMode: 'ask',
    });
    mock.server.close();

    assert.ok(res.ok);
    assert.match(res.text, /a\.js/);
    assert.strictEqual(approvals.length, 0, 'list_dir is read-only and should not prompt');
    assert.ok(events.some((e) => e.type === 'agent:tool_call' && e.name === 'list_dir'));
    assert.ok(events.some((e) => e.type === 'agent:tool_result' && /a\.js/.test(e.output)));
    assert.ok(events.some((e) => e.type === 'agent:done'));
  });

  await test('a denied call is reported back to the model, not executed', async () => {
    const target = path.join(work, 'should-not-exist.txt');
    const mock = await startMockServer({
      script: (step, payload) => {
        if (step === 0) {
          return [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'should-not-exist.txt', content: 'x' }) } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ];
        }
        const toolMsg = payload.messages.find((m) => m.role === 'tool');
        assert.match(toolMsg.content, /denied/i);
        return [textChunk('Understood, I will leave it alone.'), textChunk('', 'stop')];
      },
    });
    const agent = new LocalAgent({
      getStatus: () => ({ state: 'ready', baseUrl: 'http://127.0.0.1:' + mock.port }),
      onEvent: () => {},
      requestApproval: async () => 'deny',
      getConfig: () => ({ ctx: 8192, sampling: { max_tokens: 512 } }),
    });
    const res = await agent.send({ text: 'write a file', toolCtx: ctx, approvalMode: 'ask' });
    mock.server.close();
    assert.ok(res.ok);
    assert.strictEqual(fs.existsSync(target), false, 'the denied write must not have happened');
  });

  await test('acceptEdits writes without prompting, and the prompt fires for shell', async () => {
    let asked = 0;
    const mock = await startMockServer({
      script: (step) => {
        if (step === 0) {
          return [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'w1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'generated.txt', content: 'ok' }) } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ];
        }
        return [textChunk('Written.'), textChunk('', 'stop')];
      },
    });
    const agent = new LocalAgent({
      getStatus: () => ({ state: 'ready', baseUrl: 'http://127.0.0.1:' + mock.port }),
      onEvent: () => {},
      requestApproval: async () => { asked++; return 'allow'; },
      getConfig: () => ({ ctx: 8192, sampling: { max_tokens: 512 } }),
    });
    await agent.send({ text: 'write it', toolCtx: ctx, approvalMode: 'acceptEdits' });
    mock.server.close();
    assert.strictEqual(asked, 0, 'acceptEdits should not prompt for a write');
    assert.strictEqual(fs.readFileSync(path.join(work, 'generated.txt'), 'utf8'), 'ok');
  });

  await test('history trimming keeps the transcript inside the context window', async () => {
    const agent = new LocalAgent({
      getStatus: () => ({ state: 'ready', baseUrl: 'http://127.0.0.1:1' }),
      onEvent: () => {},
      requestApproval: async () => 'allow',
      getConfig: () => ({ ctx: 1024, sampling: { max_tokens: 256 } }),
    });
    agent.messages = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 12; i++) {
      agent.messages.push({ role: 'assistant', content: 'turn ' + i });
      agent.messages.push({ role: 'tool', tool_call_id: 't' + i, name: 'shell', content: 'x'.repeat(4000) });
    }
    const before = agent.messages.reduce((n, m) => n + m.content.length, 0);
    agent.trimHistory();
    const after = agent.messages.reduce((n, m) => n + m.content.length, 0);
    assert.ok(after < before / 2, 'trimming should cut the transcript substantially: ' + before + ' -> ' + after);
    assert.strictEqual(agent.messages[0].role, 'system', 'the system message must survive');
  });

  console.log('\ncli drivers');
  await test('claude stream-json events become deck events', () => {
    const events = [];
    const session = new cli.ClaudeSession({ bin: 'claude', cwd: work, onEvent: (e) => events.push(e) });
    session.handle({ type: 'system', subtype: 'init', session_id: 'abc', model: 'claude-opus-5', tools: ['Bash'], cwd: work });
    session.handle({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi ' } } });
    session.handle({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } });
    session.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.js' }] } });
    session.handle({ type: 'result', subtype: 'success', result: 'done', duration_ms: 1200, num_turns: 2, total_cost_usd: 0.012 });

    assert.ok(events.some((e) => e.type === 'cli:init' && e.sessionId === 'abc'));
    assert.ok(events.some((e) => e.type === 'cli:delta' && e.text === 'hi '));
    const asst = events.find((e) => e.type === 'cli:assistant');
    assert.strictEqual(asst.toolCalls[0].name, 'Bash');
    assert.ok(events.some((e) => e.type === 'cli:tool_results' && e.results[0].output === 'a.js'));
    const result = events.find((e) => e.type === 'cli:result');
    assert.strictEqual(result.costUsd, 0.012);
    assert.strictEqual(session.busy, false);
  });
  await test('claude launch args stay in print/stream-json mode', () => {
    const session = new cli.ClaudeSession({ bin: 'claude', cwd: work, permissionMode: 'acceptEdits', model: 'sonnet' });
    const a = session.args().join(' ');
    assert.match(a, /-p/);
    assert.match(a, /--input-format stream-json/);
    assert.match(a, /--output-format stream-json/);
    assert.match(a, /--verbose/);
    assert.match(a, /--permission-mode acceptEdits/);
    assert.match(a, /--model sonnet/);
    assert.match(a, /--session-id [0-9a-f-]{36}/);
  });
  await test('copilot args honour deny rules and resume after the first turn', () => {
    const session = new cli.CopilotSession({
      bin: 'copilot', cwd: work, allowAllTools: true, denyTools: ['shell(rm)'], model: 'gpt-5.4',
    });
    const first = session.args('do a thing', { resume: false }).join(' ');
    assert.match(first, /-p do a thing/);
    assert.match(first, /--output-format json/);
    assert.match(first, /--no-ask-user/);
    assert.match(first, /--allow-all-tools/);
    assert.match(first, /--deny-tool shell\(rm\)/);
    const second = session.args('next', { resume: true }).join(' ');
    assert.match(second, /--continue/);
  });
  await test('copilot json lines become deck events', () => {
    const events = [];
    const session = new cli.CopilotSession({ bin: 'copilot', cwd: work, onEvent: (e) => events.push(e) });
    session.line(JSON.stringify({ type: 'workflow.result', data: { run: { runId: 'r1', status: 'completed', result: 'all done' } } }));
    session.line('plain progress text');
    const res = events.find((e) => e.type === 'cli:result');
    assert.strictEqual(res.text, 'all done');
    assert.ok(events.some((e) => e.type === 'cli:delta' && /plain progress/.test(e.text)));
  });

  console.log('\nsessions');
  await test('a session records a transcript and names itself from the first turn', () => {
    const store = new SessionStore(path.join(tmp, 'store'));
    const s = store.create({ driver: { kind: 'local', modelId: 'm1' } });
    assert.strictEqual(s.title, 'New session');
    store.append(s.id, { role: 'user', text: 'Explain the retry logic in worker.ts' });
    store.append(s.id, { role: 'assistant', text: 'It retries three times.' });
    store.append(s.id, { role: 'tool', id: 't1', name: 'read_file', preview: 'read worker.ts' });
    const loaded = store.load(s.id);
    assert.match(loaded.title, /^Explain the retry logic/);
    assert.strictEqual(loaded.entries.length, 3);
    const row = store.list().find((x) => x.id === s.id);
    assert.strictEqual(row.messageCount, 2, 'tool entries are not messages');
    assert.strictEqual(row.toolCount, 1);
  });
  await test('model-facing history survives a restart', () => {
    const dir = path.join(tmp, 'store2');
    const store = new SessionStore(dir);
    const s = store.create({});
    store.setAgentMessages(s.id, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
    store.flushAll();
    const reopened = new SessionStore(dir);          // fresh process would do this
    const again = reopened.load(s.id);
    assert.strictEqual(again.agent.length, 2);
    assert.strictEqual(again.agent[1].content, 'hi');
  });
  await test('deleting a session removes it from disk', () => {
    const store = new SessionStore(path.join(tmp, 'store3'));
    const s = store.create({});
    store.flushAll();
    assert.strictEqual(store.list().length, 1);
    store.remove(s.id);
    assert.strictEqual(store.list().length, 0);
    assert.strictEqual(store.load(s.id), null);
  });

  console.log('\ncomfyui');
  await test('detect reports a usable setup path when nothing is installed', () => {
    const d = comfy.detect(path.join(tmp, 'definitely-not-comfy'));
    assert.strictEqual(d.installed, false);
    assert.ok(d.suggestedDir, 'should propose somewhere to install');
    assert.ok('git' in d && 'systemPython' in d, 'should report the prerequisites it checked');
  });
  await test('detect accepts a real-looking install', () => {
    const dir = path.join(tmp, 'ComfyUI');
    fs.mkdirSync(path.join(dir, 'comfy'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'models', 'checkpoints'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'main.py'), '# comfy');
    fs.writeFileSync(path.join(dir, 'models', 'checkpoints', 'a.safetensors'), 'x');
    const d = comfy.detect(dir);
    assert.strictEqual(d.installed, true);
    assert.strictEqual(d.dir, dir);
    assert.strictEqual(d.models.checkpoints, 1);
  });
  await test('every torch flavor is installable as described', () => {
    for (const [key, f] of Object.entries(comfy.TORCH_FLAVORS)) {
      assert.ok(f.label && f.note, key + ' needs a label and a note');
      assert.ok(Array.isArray(f.packages) && f.packages.length, key + ' needs packages');
      assert.ok(Array.isArray(f.launchArgs), key + ' needs launch args');
    }
    assert.ok(comfy.TORCH_FLAVORS.directml.launchArgs.includes('--directml'));
  });

  console.log('\nconfig');
  await test('deep merge preserves untouched keys and replaces arrays', () => {
    const { deepMerge, DEFAULTS } = require('./lib/config');
    const merged = deepMerge(structuredClone(DEFAULTS), { cli: { copilot: { denyTools: ['shell(rm)'] } }, sampling: { temperature: 0.2 } });
    assert.strictEqual(merged.cli.claude.permissionMode, 'acceptEdits', 'untouched nested defaults should survive');
    assert.deepStrictEqual(merged.cli.copilot.denyTools, ['shell(rm)']);
    assert.strictEqual(merged.sampling.top_p, 0.95);
    assert.strictEqual(merged.sampling.temperature, 0.2);
  });

  console.log('');
  if (failures.length) {
    console.log(failures.length + ' failed, ' + passed + ' passed\n');
    for (const f of failures) console.log('FAIL ' + f.name + '\n' + (f.err.stack || f.err.message) + '\n');
    process.exitCode = 1;
  } else {
    console.log('all ' + passed + ' checks passed\n');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
