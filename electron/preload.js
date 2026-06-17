const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glass', {
  getUser: () => ipcRenderer.invoke('auth:get-user'),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  goDashboard: () => ipcRenderer.invoke('nav:go-dashboard'),
});

contextBridge.exposeInMainWorld('muse', {
  getStatus: () => ipcRenderer.invoke('muse:get-status'),
  connect: () => ipcRenderer.invoke('muse:connect-auto'),
  disconnect: () => ipcRenderer.invoke('muse:disconnect'),
  onStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('muse:status', handler);
    return () => ipcRenderer.removeListener('muse:status', handler);
  },
  onEeg: (callback) => {
    const handler = (_event, eeg) => callback(eeg);
    ipcRenderer.on('muse:eeg', handler);
    return () => ipcRenderer.removeListener('muse:eeg', handler);
  },
});
