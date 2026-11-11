const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('nexterm-electron');
}, { once: true });

contextBridge.exposeInMainWorld('muxxleConsoleLauncher', Object.freeze({
  getSettings: () => ipcRenderer.invoke('launcher:get-settings'),
  useLocalVault: () => ipcRenderer.invoke('launcher:local'),
  connectServer: serverUrl => ipcRenderer.invoke('launcher:remote', serverUrl),
  dragWindow: (action, point) => {
    if (['start', 'move', 'end'].includes(action)) ipcRenderer.send('window:drag', action, point);
  },
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
