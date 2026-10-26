// Modules to control application life and create native browser window
const {
  app,
  BrowserWindow,
  Tray,
  nativeImage,
  Menu,
  shell,
  ipcMain,
  net,
  dialog,
} = require('electron');
const { globalShortcut } = require('electron/main');
const path = require('path');
const { createApertureSettings } = require('./aperture-settings');

const isDev = process.env.IS_DEV === 'true';

let highlightWindow = null;
let settingsWindow = null;
let apertureSettings = null;
let radiusState = null;
let interactionMode = 'reading';
let cursorTrackingTimer = null;
let trayMenu = null;
// gray mask
app.disableHardwareAcceleration();

if (app.isPackaged) {
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true,
  });
}

const MacOS = 'darwin';
const Windows = 'win32';

const hideTaskBar = () => {
  switch (process.platform) {
    case MacOS:
      app.dock.hide();

    default:
  }
};

function stopCursorTracking() {
  if (cursorTrackingTimer !== null) clearInterval(cursorTrackingTimer);
  cursorTrackingTimer = null;
}

function startCursorTracking(window) {
  stopCursorTracking();
  const publishPosition = () => {
    if (interactionMode !== 'reading' || highlightWindow !== window || window.isDestroyed()) return;
    if (window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
    const { screen } = require('electron');
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    window.webContents.send('mouse-click:cursor-position', { x: cursor.x - bounds.x, y: cursor.y - bounds.y });
  };
  // Reading windows do not receive mouse input. Track the real pointer without
  // taking focus or depending on Chromium's forwarded mouse events.
  cursorTrackingTimer = setInterval(publishPosition, 33);
  window.webContents.on('did-finish-load', publishPosition);
}

function applyInteractionMode() {
  if (!highlightWindow || highlightWindow.isDestroyed()) return;
  const reading = interactionMode === 'reading';
  // Retire the drawing window's existing key-window status before making it
  // non-focusable; blur() alone is ineffective on the older macOS runtime.
  if (reading && highlightWindow.isFocused()) highlightWindow.hide();
  highlightWindow.setIgnoreMouseEvents(reading);
  highlightWindow.setFocusable(!reading);
  highlightWindow.webContents.send('mouse-click:interaction-mode', interactionMode);
  if (reading) {
    highlightWindow.showInactive();
  }
  else {
    highlightWindow.show();
    highlightWindow.focus();
  }
}

function setInteractionMode(mode) {
  interactionMode = mode;
  for (const menu of [Menu.getApplicationMenu(), trayMenu]) {
    if (!menu) continue;
    menu.getMenuItemById('reading-mode').checked = mode === 'reading';
    menu.getMenuItemById('drawing-mode').checked = mode === 'drawing';
  }
  if (!highlightWindow) createHighlightWindow();
  else applyInteractionMode();
}

app.on('before-quit', stopCursorTracking);

function createHighlightWindow() {
  hideTaskBar();

  if (highlightWindow) {
    return;
  }

  const { screen } = require('electron');
  const cursor = screen.getCursorScreenPoint();
  const distScreen = screen.getDisplayNearestPoint(cursor);
  const {
    bounds: { x, y },
  } = distScreen;
  // Create the browser window.
  highlightWindow = new BrowserWindow({
    // resizable: false,
    // fullscreen: true,
    offscreen: true,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    show: false,
    focusable: interactionMode !== 'reading',
    webPreferences: {
      preload: __dirname + '/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        '--mouse-click-window=highlight',
        `--mouse-click-initial-radius=${apertureSettings.get()}`,
        `--mouse-click-interaction-mode=${interactionMode}`,
      ],
    },
    allowRunningInsecureContent: true,
  });
  highlightWindow.setPosition(x, y);
  highlightWindow.maximize();
  highlightWindow.resizable = false;
  highlightWindow.setAlwaysOnTop(true, 'screen-saver');
  applyInteractionMode();
  const window = highlightWindow;
  startCursorTracking(window);
  // and load the index.html of the app.
  highlightWindow.loadURL(
    isDev
      ? 'http://localhost:3000'
      : `file://${path.join(__dirname, '../dist/index.html')}`
  );

  // Open the DevTools.
  // if (isDev) {
  //   highlightWindow.webContents.openDevTools();
  // }

  window.on('closed', () => {
    if (highlightWindow === window) {
      stopCursorTracking();
      highlightWindow = null;
    }
  });
}

function hideHighlightWindow() {
  if (highlightWindow) highlightWindow.close();
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 760,
    resizable: false,
    show: false,
    title: 'Mouse Click · 光圈大小',
    backgroundColor: '#f6f7f4',
    webPreferences: {
      preload: __dirname + '/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        '--mouse-click-window=settings',
        `--mouse-click-initial-radius=${apertureSettings.get()}`,
      ],
    },
  });
  // The overlay uses screen-saver level 0; settings must remain usable above it.
  if (process.platform === MacOS) {
    settingsWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  } else {
    settingsWindow.setAlwaysOnTop(true, 'screen-saver');
  }
  settingsWindow.loadURL(
    isDev
      ? 'http://localhost:3000/settings.html'
      : `file://${path.join(__dirname, '../dist/settings.html')}`
  );
  settingsWindow.once('ready-to-show', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
    }
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function apertureMenuItems() {
  return [
    { id: 'aperture-settings', label: '光圈大小…', accelerator: 'CommandOrControl+,', click: createSettingsWindow },
    { id: 'highlight-show', label: '开启光圈', click: createHighlightWindow },
    { id: 'highlight-hide', label: '收起光圈', click: hideHighlightWindow },
    { type: 'separator' },
    { id: 'reading-mode', type: 'radio', label: '阅读模式（可翻页、点击）', checked: interactionMode === 'reading', click: () => setInteractionMode('reading') },
    { id: 'drawing-mode', type: 'radio', label: '绘画模式', checked: interactionMode === 'drawing', click: () => setInteractionMode('drawing') },
  ];
}

function createApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Mouse Click',
      submenu: [
        ...apertureMenuItems(),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: '退出 Mouse Click' },
      ],
    },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]));
}

function assertApplicationSender(event) {
  const trusted = [highlightWindow, settingsWindow].some(
    (window) => window && !window.isDestroyed() && window.webContents === event.sender
  );
  if (!trusted) throw new Error('此窗口不能修改光圈设置');
}

function publishRadius(method, value) {
  const result = apertureSettings[method](value);
  radiusState = {
    radius: result.radius,
    saved: result.saved,
    error: result.error
      ? result.error instanceof TypeError
        ? '输入无效，请输入有限数字。'
        : String(result.error.message)
      : null,
    revision: radiusState.revision + 1,
  };
  for (const window of [highlightWindow, settingsWindow]) {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('mouse-click:radius-changed', radiusState);
    }
  }
  return radiusState;
}

function registerApertureHandlers() {
  ipcMain.handle('mouse-click:get-interaction-mode', (event) => {
    assertApplicationSender(event);
    return interactionMode;
  });
  ipcMain.handle('mouse-click:get-radius', (event) => {
    assertApplicationSender(event);
    return radiusState;
  });
  ipcMain.handle('mouse-click:set-radius', (event, value) => {
    assertApplicationSender(event);
    return publishRadius('set', value);
  });
  ipcMain.handle('mouse-click:adjust-radius', (event, delta) => {
    assertApplicationSender(event);
    return publishRadius('adjust', delta);
  });
  ipcMain.handle('mouse-click:show-highlight', (event) => {
    assertApplicationSender(event);
    createHighlightWindow();
  });
  ipcMain.handle('mouse-click:hide-highlight', (event) => {
    assertApplicationSender(event);
    hideHighlightWindow();
  });
}

let tray = null;
function createTray() {
  if (tray) return;

  hideTaskBar();
  const iconPath = path.join(__dirname, './trayIcon.png');
  const trayIcon = nativeImage.createFromPath(iconPath);
  tray = new Tray(trayIcon.resize({ width: 16 }));
  trayMenu = Menu.buildFromTemplate([
    {
      label: '关于 Mouse Click',
      click: () =>
        shell.openExternal('https://github.com/Hazyzh/cursor-highlight'),
    },
    { type: 'separator' },
    ...apertureMenuItems(),
    { type: 'separator' },
    { label: 'Check Update', click: () => checkAppUpdate() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip('Mouse Click');
  tray.setContextMenu(trayMenu);
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  apertureSettings = createApertureSettings(path.join(app.getPath('userData'), 'aperture-settings.json'));
  radiusState = { radius: apertureSettings.get(), saved: null, error: null, revision: 0 };
  registerApertureHandlers();
  createApplicationMenu();
  const { wasOpenedAsHidden } = app.getLoginItemSettings();
  if (!wasOpenedAsHidden) {
    createHighlightWindow();
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (!highlightWindow) createHighlightWindow();
  });
  globalShortcut.register('Alt+x', () => {
    if (highlightWindow) {
      hideHighlightWindow();
    } else {
      createHighlightWindow();
    }
  });
  ipcMain.on('close-window', (event) => {
    if (highlightWindow && event.sender === highlightWindow.webContents) hideHighlightWindow();
  });

  // Keep the tray and shortcut available after hiding the last window.
  app.on('window-all-closed', function () {
    if (process.platform !== MacOS && process.platform !== Windows) app.quit();
  });

  createTray();
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

const checkAppUpdate = async () => {
  const request = net.request({
    method: 'GET',
    url: 'https://api.github.com/repos/Hazyzh/cursor-highlight/releases/latest',
    toJSON: true,
  });

  request.on('response', (response) => {
    response.on('data', (chunk) => {
      const resData = JSON.parse(chunk);
      const latestVersion = resData.tag_name;
      const appVersion = app.getVersion();
      const isLatest = latestVersion === `v${appVersion}`;
      if (!isLatest) {
        const message = `
          Cursor Highlight: a new version ${latestVersion} is available!
        `;
        dialog.showMessageBox({ message });
        shell.openExternal('https://github.com/Hazyzh/cursor-highlight/releases/latest');
      }
    });

    response.on('error', () => {
      dialog.showMessageBox({ message: 'Sorry, an unexpected error happened, check failed.' });
    });
  });

  request.end();
};
