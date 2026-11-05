const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nextermLauncher', Object.freeze({
  getSettings: () => ipcRenderer.invoke('launcher:get-settings'),
  useLocalVault: () => ipcRenderer.invoke('launcher:local'),
  connectServer: serverUrl => ipcRenderer.invoke('launcher:remote', serverUrl),
  onStatus: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('launcher:status', listener);
    return () => ipcRenderer.removeListener('launcher:status', listener);
  },
  onError: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('launcher:error', listener);
    return () => ipcRenderer.removeListener('launcher:error', listener);
  }
}));
