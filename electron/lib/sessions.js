'use strict';
// Persisted conversations. Two things are stored per session and they are not
// the same: `entries` is what the UI draws (user turns, assistant turns, tool
// cards), and `agent` is the model-facing message array the local agent needs
// to continue the conversation. Keeping both means a restart can restore the
// transcript *and* resume reasoning, rather than showing scrollback the model
// has no memory of.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ENTRIES = 2000;

class SessionStore {
  constructor(dir) {
    this.dir = path.join(dir, 'sessions');
    fs.mkdirSync(this.dir, { recursive: true });
    this.cache = new Map();
    this.saveTimers = new Map();
  }

  file(id) { return path.join(this.dir, id + '.json'); }

  list() {
    let names;
    try { names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
    const out = [];
    for (const n of names) {
      const id = n.replace(/\.json$/, '');
      const s = this.load(id);
      if (!s) continue;
      out.push({
        id: s.id,
        title: s.title,
        driver: s.driver,
        messageCount: s.entries.filter((e) => e.role === 'user' || e.role === 'assistant').length,
        toolCount: s.entries.filter((e) => e.role === 'tool').length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        cliSessionId: s.cliSessionId || null,
      });
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const s = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
      s.entries = Array.isArray(s.entries) ? s.entries : [];
      s.agent = Array.isArray(s.agent) ? s.agent : [];
      this.cache.set(id, s);
      return s;
    } catch (_) { return null; }
  }

  create({ driver, title } = {}) {
    const now = new Date().toISOString();
    const s = {
      id: crypto.randomUUID(),
      title: title || 'New session',
      driver: driver || { kind: null, modelId: null },
      createdAt: now,
      updatedAt: now,
      entries: [],
      agent: [],
      cliSessionId: null,
    };
    this.cache.set(s.id, s);
    this.flush(s.id);
    return s;
  }

  remove(id) {
    this.cache.delete(id);
    const t = this.saveTimers.get(id);
    if (t) { clearTimeout(t); this.saveTimers.delete(id); }
    try { fs.unlinkSync(this.file(id)); } catch (_) { /* already gone */ }
    return true;
  }

  append(id, entry) {
    const s = this.load(id);
    if (!s) return null;
    // Claude Code reports its final answer twice -- once as an assistant
    // message, once in the result event that closes the turn. Recording both
    // would duplicate the reply in every restored transcript.
    if (entry.role === 'assistant' && entry.text) {
      const prev = [...s.entries].reverse().find((e) => e.role === 'assistant' && e.text);
      if (prev && prev.text.trim() === String(entry.text).trim()) return s;
    }
    s.entries.push({ at: new Date().toISOString(), ...entry });
    if (s.entries.length > MAX_ENTRIES) s.entries.splice(0, s.entries.length - MAX_ENTRIES);
    s.updatedAt = new Date().toISOString();
    // First real user turn names the session, the way a chat app does.
    if (s.title === 'New session' && entry.role === 'user' && entry.text) {
      s.title = entry.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    }
    this.save(id);
    return s;
  }

  /** Replace the model-facing history (the agent owns its own trimming). */
  setAgentMessages(id, messages) {
    const s = this.load(id);
    if (!s) return;
    s.agent = messages;
    s.updatedAt = new Date().toISOString();
    this.save(id);
  }

  patch(id, fields) {
    const s = this.load(id);
    if (!s) return null;
    Object.assign(s, fields, { updatedAt: new Date().toISOString() });
    this.save(id);
    return s;
  }

  // Writes are debounced: a streaming turn can append dozens of entries a
  // second and none of them individually need to hit the disk.
  save(id) {
    if (this.saveTimers.has(id)) return;
    const t = setTimeout(() => { this.saveTimers.delete(id); this.flush(id); }, 400);
    if (t.unref) t.unref();
    this.saveTimers.set(id, t);
  }

  flush(id) {
    const s = this.cache.get(id);
    if (!s) return;
    try {
      const tmp = this.file(id) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s));
      fs.renameSync(tmp, this.file(id));
    } catch (_) { /* a lost transcript must never take the app down */ }
  }

  flushAll() {
    for (const id of this.cache.keys()) {
      const t = this.saveTimers.get(id);
      if (t) { clearTimeout(t); this.saveTimers.delete(id); }
      this.flush(id);
    }
  }
}

module.exports = { SessionStore };
