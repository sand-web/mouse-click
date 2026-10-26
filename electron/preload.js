const { contextBridge, ipcRenderer } = require('electron');

const radiusArgument = process.argv.find((value) => value.startsWith('--mouse-click-initial-radius='));
const initialRadius = Number(radiusArgument && radiusArgument.split('=')[1]);
const isHighlight = process.argv.includes('--mouse-click-window=highlight');

contextBridge.exposeInMainWorld('mouseClick', {
  initialRadius: Number.isFinite(initialRadius) && initialRadius >= 20 && initialRadius <= 300 ? initialRadius : 100,
  getRadius: () => ipcRenderer.invoke('mouse-click:get-radius'),
  setRadius: (value) => ipcRenderer.invoke('mouse-click:set-radius', value),
  adjustRadius: (delta) => ipcRenderer.invoke('mouse-click:adjust-radius', delta),
  onRadiusChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('mouse-click:radius-changed', listener);
    return () => ipcRenderer.removeListener('mouse-click:radius-changed', listener);
  },
  showHighlight: () => ipcRenderer.invoke('mouse-click:show-highlight'),
  hideHighlight: () => ipcRenderer.invoke('mouse-click:hide-highlight'),
});

if (isHighlight) {
  window.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') ipcRenderer.send('close-window');
  });
}
