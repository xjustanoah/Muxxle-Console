const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('nexterm-electron');
}, { once: true });

contextBridge.exposeInMainWorld('nextermDesktop', Object.freeze({
  setWindowTheme: theme => ipcRenderer.invoke('window:set-theme', theme),
  dragWindow: (action, point) => {
    if (['start', 'move', 'end'].includes(action)) ipcRenderer.send('window:drag', action, point);
  }
}));
