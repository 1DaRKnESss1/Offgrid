// Вузький міст між панеллю і головним процесом. Панель не має доступу ні до Node, ні до диска.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('offgrid', {
  ask: (text) => ipcRenderer.send('offgrid:ask', String(text)),
  listen: () => ipcRenderer.send('offgrid:listen'),
  setSpeak: (value) => ipcRenderer.send('offgrid:set-speak', value === true),
  cancel: () => ipcRenderer.send('offgrid:cancel'),
  answerConfirm: (id, allow) => ipcRenderer.send('offgrid:confirm', String(id), allow === true),
  newChat: () => ipcRenderer.send('offgrid:new-chat'),
  hide: () => ipcRenderer.send('offgrid:hide'),
  ready: () => ipcRenderer.invoke('offgrid:ready'),
  settings: (action, payload) => ipcRenderer.invoke('offgrid:settings', String(action), payload),
  log: () => ipcRenderer.invoke('offgrid:log'),
  captureHotkey: (on) => ipcRenderer.send('offgrid:capture-hotkey', on === true),
  onEvent: (handler) => {
    ipcRenderer.on('offgrid:event', (_e, event) => handler(event));
  },
});
