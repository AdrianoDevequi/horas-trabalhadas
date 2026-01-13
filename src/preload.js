const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onUpdateTime: (callback) => ipcRenderer.on('update-time', (_event, value) => callback(value)),
    getHistory: () => ipcRenderer.invoke('get-history'),
    getStartupStatus: () => ipcRenderer.invoke('get-startup-status'),
    toggleStartup: (enabled) => ipcRenderer.invoke('toggle-startup', enabled)
});
