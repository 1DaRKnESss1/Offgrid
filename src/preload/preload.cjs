// Вузький міст між панеллю і головним процесом. Панель не має доступу ні до Node, ні до диска.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('offgrid', {
  ask: (text) => ipcRenderer.invoke('offgrid:ask', String(text)),
  cancel: () => ipcRenderer.send('offgrid:cancel'),
  answerConfirm: (id, allow) => ipcRenderer.send('offgrid:confirm', String(id), allow === true),
  newChat: () => ipcRenderer.send('offgrid:new-chat'),
  hide: () => ipcRenderer.send('offgrid:hide'),
  ready: () => ipcRenderer.invoke('offgrid:ready'),
  onEvent: (handler) => {
    ipcRenderer.on('offgrid:event', (_e, event) => handler(event));
  },
});
