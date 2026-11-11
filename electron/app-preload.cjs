const { contextBridge, ipcRenderer } = require('electron');

// Keep the bridge and CSS class compatible with independently deployed web versions.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('nexterm-electron');
}, { once: true });

contextBridge.exposeInMainWorld('nextermDesktop', Object.freeze({
  setWindowTheme: theme => ipcRenderer.invoke('window:set-theme', theme)
}));
