'use strict';
// The agent loop for local models: ask the model, run the tools it asks for,
// feed the results back, repeat until it stops calling tools. Approval is a
// callback so the UI owns the decision; this file never auto-approves anything
// the mode did not already permit.
const path = require('path');
const os = require('os');
const { chatStream } = require('./backends/local');
const tools = require('./tools');

const MAX_TURNS = 40;

function systemPrompt({ workspace, shell, modelName, approvalMode, extraDirs }) {
  const lines = [
    'You are the local coding agent inside Laguna Deck, running on ' + os.type() + ' as ' + (modelName || 'a local model') + '.',
    '',
    'Environment:',
    '- Working directory: ' + workspace,
    extraDirs && extraDirs.length ? '- Also readable/writable: ' + extraDirs.join(', ') : null,
    '- Shell for the shell tool: ' + shell,
    '- File paths you pass to tools may be relative to the working directory. Paths outside it are refused.',
    '',
    'How to work:',
    '- Look before you edit: read the file, or grep for the symbol, rather than guessing at contents.',
    '- Prefer edit_file over write_file on existing files, so you do not discard code you did not read.',
    '- One shell command per call. The shell is not persistent, so chain with the command itself (cd x; cmd) rather than expecting a previous cd to hold.',
    '- Tool output is truncated at 60k characters. Narrow the command or the search instead of re-running something that floods.',
    approvalMode === 'ask'
      ? '- The user approves tool calls that write or run commands. A denial is a decision: adapt rather than retrying the same call.'
      : '- Edits apply without a prompt in this mode, so keep changes to what was asked.',
    '',
    'When you answer: lead with the outcome, then the detail that would change what the user does next. Say plainly when something failed or you could not verify it.',
  ];
  return lines.filter(Boolean).join('\n');
}

class LocalAgent {
  constructor({ getStatus, onEvent, requestApproval, getConfig }) {
    this.getStatus = getStatus;         // () => llama server status
    this.onEvent = onEvent || (() => {});
    this.requestApproval = requestApproval;
    this.getConfig = getConfig;
    this.messages = [];
    this.systemText = null;
    this.running = false;
    this.controller = null;
    this.sessionAllow = new Set();      // tool names the user approved for the session
    this.turnStats = null;
  }

  reset() {
    this.messages = [];
    this.systemText = null;
    this.sessionAllow.clear();
    this.onEvent({ type: 'agent:reset' });
  }

  abort() {
    if (this.controller) this.controller.abort();
    this.running = false;
    this.onEvent({ type: 'agent:aborted' });
  }

  ensureSystem(ctx, modelName, approvalMode) {
    const text = systemPrompt({
      workspace: ctx.workspace,
      shell: ctx.shell || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'),
      modelName,
      approvalMode,
      extraDirs: ctx.extraDirs,
    });
    if (this.systemText !== text) {
      this.systemText = text;
      if (this.messages.length && this.messages[0].role === 'system') this.messages[0].content = text;
      else this.messages.unshift({ role: 'system', content: text });
    }
  }

  /** Run one user turn to completion (model + tools until it stops calling them). */
  async send({ text, toolCtx, modelName, sampling, approvalMode, enabledTools }) {
    if (this.running) throw new Error('the agent is already working on a turn');
    const status = this.getStatus();
    if (!status || status.state !== 'ready') {
      throw new Error('no model is loaded (state: ' + (status ? status.state : 'unknown') + ')');
    }
    this.running = true;
    this.controller = new AbortController();
    const startedAt = Date.now();
    this.turnStats = { toolCalls: 0, promptTokens: 0, completionTokens: 0, tokensPerSec: null };

    try {
      this.ensureSystem(toolCtx, modelName, approvalMode);
      if (text) {
        this.messages.push({ role: 'user', content: text });
        this.onEvent({ type: 'agent:user', text });
      }
      const schemas = tools.toolSchemas(enabledTools);

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        this.trimHistory();
        this.onEvent({ type: 'agent:thinking', turn });

        const reply = await chatStream({
          baseUrl: status.baseUrl,
          messages: this.messages,
          tools: schemas,
          sampling,
          signal: this.controller.signal,
          onDelta: (d) => this.onEvent({ type: 'agent:delta', text: d }),
          onReasoning: (d) => this.onEvent({ type: 'agent:reasoning', text: d }),
        });

        if (reply.usage) {
          this.turnStats.promptTokens += reply.usage.prompt_tokens || 0;
          this.turnStats.completionTokens += reply.usage.completion_tokens || 0;
        }
        if (reply.timings && reply.timings.predicted_per_second) {
          this.turnStats.tokensPerSec = +reply.timings.predicted_per_second.toFixed(1);
        }

        const assistantMsg = { role: 'assistant', content: reply.content || '' };
        if (reply.toolCalls.length) {
          assistantMsg.tool_calls = reply.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
          }));
        }
        this.messages.push(assistantMsg);
        this.onEvent({
          type: 'agent:assistant',
          text: reply.content || '',
          reasoning: reply.reasoning || '',
          toolCalls: reply.toolCalls.map((c) => ({ id: c.id, name: c.name, input: c.arguments })),
        });

        if (!reply.toolCalls.length) {
          const stats = { ...this.turnStats, elapsedMs: Date.now() - startedAt };
          this.onEvent({ type: 'agent:done', stats });
          return { ok: true, text: reply.content, stats };
        }

        // Tool calls run in order. Parallelising them would be faster but makes
        // approval prompts race each other, and an edit racing a read in the
        // same file is a real bug, not a theoretical one.
        for (const call of reply.toolCalls) {
          const result = await this.executeCall({ call, toolCtx, approvalMode });
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: result.output,
          });
        }
      }

      const stats = { ...this.turnStats, elapsedMs: Date.now() - startedAt, hitTurnLimit: true };
      this.onEvent({ type: 'agent:done', stats });
      return { ok: true, text: '(stopped after ' + MAX_TURNS + ' tool turns)', stats };
    } catch (err) {
      const aborted = err.name === 'AbortError';
      this.onEvent({ type: aborted ? 'agent:aborted' : 'agent:error', error: err.message });
      if (aborted) return { ok: false, aborted: true };
      throw err;
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  async executeCall({ call, toolCtx, approvalMode }) {
    this.turnStats.toolCalls++;
    const { risk, why } = tools.classify(call.name, call.arguments);
    const previewText = tools.preview(call.name, call.arguments);
    const callId = call.id;

    const sessionOk = this.sessionAllow.has(call.name) && risk !== 'destructive';
    const auto = sessionOk || tools.autoApproved(risk, approvalMode);

    this.onEvent({
      type: 'agent:tool_call',
      id: callId,
      name: call.name,
      input: call.arguments,
      preview: previewText,
      risk,
      why,
      autoApproved: auto,
      recovered: !!call.recovered,
    });

    if (!auto) {
      const decision = await this.requestApproval({
        id: callId, name: call.name, input: call.arguments, preview: previewText, risk, why,
      });
      if (decision === 'always') this.sessionAllow.add(call.name);
      if (decision === 'deny' || decision === 'abort') {
        const msg = decision === 'abort'
          ? 'The user cancelled this turn. Stop and wait for new instructions.'
          : 'The user denied this call. Do not retry it; either take a different approach or explain what you need.';
        this.onEvent({ type: 'agent:tool_result', id: callId, name: call.name, output: msg, denied: true });
        return { output: msg, isError: true };
      }
    }

    const t0 = Date.now();
    const res = await tools.runTool(toolCtx, call.name, call.arguments);
    this.onEvent({
      type: 'agent:tool_result',
      id: callId,
      name: call.name,
      output: res.output,
      isError: res.isError,
      ms: Date.now() - t0,
    });
    return res;
  }

  // Keep the transcript inside the loaded model's context window. Old tool
  // results are the first thing to go: they are the biggest and the least
  // likely to matter later.
  trimHistory() {
    const cfg = this.getConfig ? this.getConfig() : {};
    const ctxTokens = (cfg && cfg.ctx) || 8192;
    const reserve = (cfg && cfg.sampling && cfg.sampling.max_tokens) || 2048;
    const budgetChars = Math.max(2000, (ctxTokens - reserve) * 3.4);

    const size = () => this.messages.reduce((n, m) => n + (m.content ? String(m.content).length : 0) + 64, 0);
    if (size() <= budgetChars) return;

    for (let i = 1; i < this.messages.length - 4 && size() > budgetChars; i++) {
      const m = this.messages[i];
      if (m.role === 'tool' && m.content && m.content.length > 400 && !m.__trimmed) {
        m.content = m.content.slice(0, 400) + '\n[earlier tool output dropped to fit the context window]';
        m.__trimmed = true;
      }
    }
    // Still too big: drop whole exchanges from the front, keeping the system
    // message and the most recent turns.
    while (size() > budgetChars && this.messages.length > 5) {
      this.messages.splice(1, 1);
      if (this.messages[1] && (this.messages[1].role === 'tool' || this.messages[1].role === 'assistant')) {
        this.messages.splice(1, 1);
      }
    }
    this.onEvent({ type: 'agent:trimmed', messages: this.messages.length });
  }

  transcript() {
    return this.messages.filter((m) => m.role !== 'system');
  }
}

module.exports = { LocalAgent, systemPrompt };
