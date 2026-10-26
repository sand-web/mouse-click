// Runs only in a separate local Electron test build, never in the installed app.
const { app, BrowserWindow, Menu } = require('electron');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const testData = process.env.MOUSE_CLICK_E2E_DATA;
assert.ok(testData && path.isAbsolute(testData), 'isolated test data path required');
if (process.platform === 'win32') {
  assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'Windows test packages only run in disposable GitHub-hosted CI');
}
const resultFile = process.env.MOUSE_CLICK_E2E_RESULT || path.join(testData, 'e2e-result.json');
assert.ok(path.isAbsolute(resultFile), 'absolute test report path required');
const reportDirectory = path.dirname(resultFile);
const reportPrefix = process.env.MOUSE_CLICK_E2E_RESULT ? path.basename(resultFile, path.extname(resultFile)) + '-' : '';
const expectedRadius = process.env.MOUSE_CLICK_E2E_EXPECT_RADIUS === undefined ? undefined : Number(process.env.MOUSE_CLICK_E2E_EXPECT_RADIUS);
const finalRadius = process.env.MOUSE_CLICK_E2E_FINAL_RADIUS === undefined ? undefined : Number(process.env.MOUSE_CLICK_E2E_FINAL_RADIUS);
for (const radius of [expectedRadius, finalRadius]) {
  assert.ok(radius === undefined || (Number.isFinite(radius) && radius >= 20 && radius <= 300), 'valid requested test radius');
}
const phase = process.env.MOUSE_CLICK_E2E_PHASE || (expectedRadius === undefined ? 'full' : 'resume');
fs.mkdirSync(reportDirectory, { recursive: true });
app.setPath('userData', testData);
require('../../electron/main.js');

const checks = [];
let stage = 'startup';
let intentionalExit = false;
function report(value) {
  fs.writeFileSync(resultFile, JSON.stringify({
    pid: process.pid, platform: process.platform, electron: process.versions.electron,
    phase, userData: app.getPath('userData'), appPath: app.getAppPath(), execPath: process.execPath,
    stage, checks, ...value,
  }, null, 2));
}
function exit(code) {
  intentionalExit = true;
  // This harness is only packaged for the disposable CI test process.
  if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: false });
  app.exit(code);
}
app.on('before-quit', () => {
  if (!intentionalExit) {
    report({ status: 'FAIL', error: 'Application unexpectedly quit before the test completed' });
  }
});
const deadline = setTimeout(() => {
  fs.mkdirSync(testData, { recursive: true });
  report({ status: 'FAIL', error: 'test-driver timeout' });
  console.error('E2E timeout at ' + stage);
  exit(1);
}, 90000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, accept, label) {
  stage = label;
  for (let n = 0; n < 150; n++) {
    const value = await read();
    if (accept(value)) return value;
    await sleep(30);
  }
  throw new Error('Timed out: ' + label);
}
function menu(id) {
  const item = Menu.getApplicationMenu().getMenuItemById(id);
  assert.ok(item, 'native menu item ' + id);
  item.click(item, BrowserWindow.getFocusedWindow());
}
const settingsWindow = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html'));
const overlayWindow = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
async function loaded(window) {
  await until(() => window.webContents.executeJavaScript('document.readyState'), (v) => v === 'complete', 'document load');
}
async function openSettings() {
  menu('aperture-settings');
  const window = await until(async () => settingsWindow(), Boolean, 'settings window');
  await loaded(window);
  await until(() => window.webContents.executeJavaScript('!!window.mouseClick && !document.querySelector("#radius").disabled'), Boolean, 'settings ready');
  return window;
}
async function observe(window) {
  return window.webContents.executeJavaScript(`(async()=>({
    state: await window.mouseClick.getRadius(),
    slider: Number(document.querySelector('#radius').value),
    number: Number(document.querySelector('#radiusNumber').value),
    text: document.querySelector('#radiusValue').textContent,
    previewWidth: document.querySelector('#previewRing').getBoundingClientRect().width,
    status: document.querySelector('#saveStatus').textContent
  }))()`);
}
async function agrees(window, expected) {
  const view = await until(() => observe(window), (v) => v.state.radius === expected && v.slider === expected && v.number === expected, 'settings convergence to ' + expected);
  assert.ok(Math.abs(view.previewWidth - expected * 0.64) < 0.1, 'preview follows radius');
  assert.equal(view.text.trim(), String(Number(expected.toFixed(2))), 'visible radius has at most two decimals');
  const overlay = overlayWindow();
  if (overlay) {
    const radius = await until(() => overlay.webContents.executeJavaScript('window.app && Object.values(window.app.renderLayers).find(x => typeof x.radius === "number")?.radius'), (v) => v === expected, 'actual canvas layer radius');
    assert.equal(radius, expected);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(testData, 'aperture-settings.json'))).radius, expected);
  checks.push({ radius: expected, view });
  fs.writeFileSync(path.join(reportDirectory, reportPrefix + 'e2e-progress.json'), JSON.stringify({ pid: process.pid, phase, stage, checks }, null, 2));
  return view;
}
async function setSlider(window, radius) {
  await window.webContents.executeJavaScript(`(()=>{const s=document.querySelector('#radius');s.value=${radius};s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  return agrees(window, radius);
}
async function precise(window, radius) {
  await window.webContents.executeJavaScript(`(()=>{const s=document.querySelector('#radiusNumber');s.value=${radius};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  return agrees(window, radius);
}
async function wheel(window, delta, expected) {
  // Reading no longer uses the wheel as a size shortcut. This specification
  // change is intentional; the user needs the real wheel for the page below.
  const before = await observe(window);
  const file = path.join(testData, 'aperture-settings.json');
  const beforeBytes = fs.readFileSync(file);
  assert.equal(before.state.radius, expected, 'wheel starts from the current requested radius');
  await overlayWindow().webContents.executeJavaScript(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel',{deltaY:${delta},bubbles:true}))`);
  await sleep(120);
  const after = await observe(window);
  assert.equal(after.state.radius, before.state.radius, 'ordinary wheel must keep the chosen radius');
  assert.equal(after.state.revision, before.state.revision, 'ordinary wheel must not publish a size change');
  assert.deepEqual(fs.readFileSync(file), beforeBytes, 'ordinary wheel must preserve saved bytes');
  return agrees(window, expected);
}

app.whenReady().then(async () => {
  try {
    await until(async () => overlayWindow(), Boolean, 'initial overlay');
    await loaded(overlayWindow());
    let settings = await openSettings();
    if (process.platform === 'win32' && expectedRadius === undefined) {
      // Establish real foreground input before programmatic mode transitions;
      // Windows may otherwise reject focus changes from a background process.
      const { runInput } = require(path.join(process.env.MOUSE_CLICK_SOURCE, 'scripts/windows-native-input.cjs'));
      const bounds = settings.getBounds();
      const point = require('electron').screen.dipToScreenPoint({ x: Math.round(bounds.x + bounds.width / 2), y: bounds.y + 12 });
      const input = runInput({ kind: 'click', ...point }, reportDirectory, phase + '-settings-foreground');
      assert.equal(input.sent, input.expected, 'native foreground setup input was delivered');
      await until(async () => settings.isFocused(), Boolean, 'settings receives real foreground input');
    }
    menu('aperture-settings');
    assert.equal(BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('settings.html')).length, 1, 'settings singleton');
    let startup;
    let operations;
    let failedView;
    if (expectedRadius !== undefined) {
      // Read the restored state before any write: a pre-test set would hide broken persistence.
      const view = await observe(settings);
      const canvasRadius = await until(() => overlayWindow().webContents.executeJavaScript('window.app && Object.values(window.app.renderLayers).find(x => typeof x.radius === "number")?.radius'), Number.isFinite, 'restored canvas initialized');
      const diskRadius = JSON.parse(fs.readFileSync(path.join(testData, 'aperture-settings.json'), 'utf8')).radius;
      startup = { view, canvasRadius, diskRadius, expectedRadius };
      assert.equal(view.state.radius, expectedRadius, 'restored IPC radius before writes');
      assert.equal(view.slider, expectedRadius, 'restored slider before writes');
      assert.equal(view.number, expectedRadius, 'restored number before writes');
      assert.ok(Math.abs(view.previewWidth - expectedRadius * 0.64) < 0.1, 'restored preview before writes');
      assert.equal(canvasRadius, expectedRadius, 'restored canvas before writes');
      assert.equal(diskRadius, expectedRadius, 'restored disk radius before writes');
      checks.push({ restored: true, radius: expectedRadius, view });
      fs.writeFileSync(path.join(reportDirectory, reportPrefix + 'startup-settings.png'), (await settings.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(reportDirectory, reportPrefix + 'startup-overlay.png'), (await overlayWindow().webContents.capturePage()).toPNG());
    } else {
    for (const radius of [20, 137, 300]) await setSlider(settings, radius);
    await precise(settings, 137.125);
    await wheel(settings, 0.25, 137.125);
    await setSlider(settings, 180);
    await wheel(settings, -0.5, 180);
    for (const radius of [20, 137.125, 300]) {
      await precise(settings, radius);
      for (const delta of [4, -4, 0]) await wheel(settings, delta, radius);
    }

    const sourceRequire = require('module').createRequire(path.join(process.env.MOUSE_CLICK_SOURCE, 'package.json'));
    const fc = sourceRequire('fast-check');
    operations = fc.sample(fc.array(fc.oneof(
      fc.record({ kind: fc.constant('set'), value: fc.integer({ min: 20, max: 300 }) }),
      fc.record({ kind: fc.constant('wheel'), value: fc.integer({ min: -8, max: 8 }).map((v) => v / 4) })
    ), { minLength: 5, maxLength: 8 }), { seed: 20261025, numRuns: 1 })[0];
    let expected = 300;
    for (const operation of operations) {
      if (operation.kind === 'set') {
        expected = operation.value;
        await setSlider(settings, expected);
      } else {
        await wheel(settings, operation.value, expected);
      }
    }
    for (let round = 1; round <= 2; round++) {
      stage = 'drawing-to-reading keyboard focus round ' + round;
      const overlay = overlayWindow();
      const beforeMode = await observe(settings);
      const beforeModeBytes = fs.readFileSync(path.join(testData, 'aperture-settings.json'));
      menu('drawing-mode');
      await until(async () => overlay.isFocused(), Boolean, 'drawing window takes keyboard focus');
      assert.equal(overlay.isFocused(), true, 'drawing mode receives keyboard focus');
      menu('reading-mode');
      await sleep(150);
      assert.equal(overlay.isFocused(), false, 'reading mode releases drawing window keyboard focus');
      const afterMode = await observe(settings);
      assert.equal(afterMode.state.radius, beforeMode.state.radius, 'mode changes preserve the chosen radius');
      assert.equal(afterMode.state.revision, beforeMode.state.revision, 'mode changes do not publish size updates');
      assert.deepEqual(fs.readFileSync(path.join(testData, 'aperture-settings.json')), beforeModeBytes, 'mode changes preserve saved size bytes');
      checks.push({ modeRound: round, drawingFocused: true, readingFocused: overlay.isFocused(), radius: afterMode.state.radius });
    }
    const closedSettings = settings;
    closedSettings.close();
    await until(async () => closedSettings.isDestroyed(), Boolean, 'settings closed before reopening');
    assert.ok(overlayWindow(), 'closing settings preserves overlay');
    settings = await openSettings();
    await agrees(settings, expected);
    menu('highlight-hide');
    await until(async () => overlayWindow(), (v) => !v, 'overlay hidden');
    await setSlider(settings, 80);
    menu('highlight-show');
    const replacement = await until(async () => overlayWindow(), Boolean, 'overlay recreated');
    await loaded(replacement);
    await agrees(settings, 80);

    const beforeInvalid = fs.readFileSync(path.join(testData, 'aperture-settings.json'));
    for (const input of ['"137"', 'null', 'NaN']) {
      const result = await settings.webContents.executeJavaScript(`window.mouseClick.setRadius(${input})`);
      assert.equal(result.radius, 80);
      assert.equal(result.saved, false);
      assert.ok(result.error);
      assert.deepEqual(fs.readFileSync(path.join(testData, 'aperture-settings.json')), beforeInvalid);
    }
    await settings.webContents.executeJavaScript('window.mouseClick.setRadius(301)');
    await agrees(settings, 300);
    const file = path.join(testData, 'aperture-settings.json');
    const preserved = fs.readFileSync(file);
    fs.mkdirSync(file + '.tmp');
    const failure = await settings.webContents.executeJavaScript('window.mouseClick.setRadius(180)');
    assert.equal(failure.radius, 180);
    assert.equal(failure.saved, false);
    assert.ok(failure.error);
    failedView = await until(() => observe(settings), (v) => v.state.radius === 180 && /未保存|无法保存|保存失败/.test(v.status), 'visible save failure');
    assert.deepEqual(fs.readFileSync(file), preserved);
    fs.renameSync(file + '.tmp', file + '.blocked-archive');
    await settings.webContents.executeJavaScript('window.mouseClick.setRadius(180)');
    await agrees(settings, 180);
    const stable = await observe(settings);
    await sleep(250);
    assert.equal((await observe(settings)).state.revision, stable.state.revision, 'no update loop');
    }
    if (finalRadius !== undefined) await precise(settings, finalRadius);
    const radius = (await observe(settings)).state.radius;
    const settingsScreenshot = path.join(reportDirectory, reportPrefix + 'settings.png');
    const overlayScreenshot = path.join(reportDirectory, reportPrefix + 'overlay.png');
    fs.writeFileSync(settingsScreenshot, (await settings.webContents.capturePage()).toPNG());
    fs.writeFileSync(overlayScreenshot, (await overlayWindow().webContents.capturePage()).toPNG());
    report({ status: 'PASS', seed: 20261025, operations, failedView, startup, radius,
      expectedRadius, finalRadius, screenshots: { settings: settingsScreenshot, overlay: overlayScreenshot } });
    console.log('MOUSE_CLICK_E2E_PASS ' + checks.length + ' real-window state checks');
    clearTimeout(deadline);
    exit(0);
  } catch (error) {
    fs.mkdirSync(testData, { recursive: true });
    report({ status: 'FAIL', error: error.stack });
    console.error(error.stack);
    clearTimeout(deadline);
    exit(1);
  }
});
