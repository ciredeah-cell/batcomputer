'use strict';
// The only bridge between the renderer and the main process. Every call is an
// explicit named channel -- the renderer gets no filesystem, no child_process,
// and no arbitrary ipcRenderer access.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload || {});

contextBridge.exposeInMainWorld('deck', {
  bootstrap: invoke('app:bootstrap'),

  config: {
    patch: invoke('config:patch'),
    reveal: invoke('config:reveal'),
  },

  pick: {
    directory: invoke('fs:pickDirectory'),
    file: invoke('fs:pickFile'),
  },

  hw: { refresh: invoke('hw:refresh') },

  models: {
    scan: invoke('models:scan'),
    add: invoke('models:add'),
    remove: invoke('models:remove'),
    update: invoke('models:update'),
    plan: invoke('models:plan'),
    inspect: invoke('models:inspect'),
  },

  llama: {
    start: invoke('llama:start'),
    stop: invoke('llama:stop'),
    swap: invoke('llama:swap'),
    status: invoke('llama:status'),
  },

  agent: {
    send: invoke('agent:send'),
    abort: invoke('agent:abort'),
    reset: invoke('agent:reset'),
    transcript: invoke('agent:transcript'),
    approve: invoke('agent:approve'),
  },

  cli: {
    detect: invoke('cli:detect'),
    start: invoke('cli:start'),
    send: invoke('cli:send'),
    interrupt: invoke('cli:interrupt'),
    stop: invoke('cli:stop'),
    status: invoke('cli:status'),
    openTerminal: invoke('cli:openTerminal'),
  },

  openPath: invoke('shell:openPath'),
  openExternal: invoke('shell:openExternal'),

  /** Subscribe to main-process events. Returns an unsubscribe function. */
  onEvent(handler) {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('deck:event', listener);
    return () => ipcRenderer.removeListener('deck:event', listener);
  },
});
