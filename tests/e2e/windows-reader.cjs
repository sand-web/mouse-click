// Dedicated test reader: never import the production entry or register startup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
assert.ok(process.platform === 'win32' && process.arch === 'x64', 'reader requires Windows x64');
assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'reader requires a disposable GitHub-hosted runner');
const data = process.env.MOUSE_CLICK_READER_DATA;
assert.ok(data && path.isAbsolute(data), 'reader requires an isolated absolute user-data path');
fs.mkdirSync(data, { recursive: true });
const { app, BrowserWindow, screen } = require('electron');
app.setPath('userData', data);
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea;
  assert.ok(area.width >= 800 && area.height >= 600, 'ENVIRONMENT_DESKTOP_TOO_SMALL: reader needs a usable desktop');
  const window = new BrowserWindow({
    x: area.x + 40, y: area.y + 40,
    width: Math.min(1000, area.width - 80), height: Math.min(760, area.height - 80),
    title: 'Mouse Click Windows Reading Fixture',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.loadFile(path.join(__dirname, 'windows-reader.html'));
}).catch((error) => { console.error(error.stack); app.exit(1); });
app.on('window-all-closed', () => app.quit());
