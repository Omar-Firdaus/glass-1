const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glass', {
  getUser: () => ipcRenderer.invoke('auth:get-user'),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  goApp: () => ipcRenderer.invoke('nav:go-app'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  museGetState: () => ipcRenderer.invoke('muse:get-state'),
  museScan: () => ipcRenderer.invoke('muse:scan'),
  museConnect: (device) => ipcRenderer.invoke('muse:connect', device),
  museConnectAuto: () => ipcRenderer.invoke('muse:connect-auto'),
  museDisconnect: () => ipcRenderer.invoke('muse:disconnect'),
  museCalibrate: () => ipcRenderer.invoke('muse:calibrate'),
  onMuseEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('muse:event', listener);
    return () => ipcRenderer.removeListener('muse:event', listener);
  },
  analyzeVision: (imageDataUrl, prompt) =>
    ipcRenderer.invoke('vision:analyze', { imageDataUrl, prompt }),
  speakTts: (text) => ipcRenderer.invoke('tts:speak', { text }),
});
