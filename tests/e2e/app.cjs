// Runs only in a separate local Electron test build, never in the installed app.
const { app, BrowserWindow, Menu } = require('electron');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const testData = process.env.MOUSE_CLICK_E2E_DATA;
assert.ok(testData && path.isAbsolute(testData), 'isolated test data path required');
app.setPath('userData', testData);
require('../../electron/main.js');

const checks = [];
let stage = 'startup';
const deadline = setTimeout(() => {
  fs.mkdirSync(testData, { recursive: true });
  fs.writeFileSync(path.join(testData, 'e2e-result.json'), JSON.stringify({ status: 'FAIL', stage, error: 'test-driver timeout', checks }, null, 2));
  console.error('E2E timeout at ' + stage);
  app.exit(1);
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
  fs.writeFileSync(path.join(testData, 'e2e-progress.json'), JSON.stringify({ stage, checks }, null, 2));
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
  await overlayWindow().webContents.executeJavaScript(`document.querySelector('canvas').dispatchEvent(new WheelEvent('wheel',{deltaY:${delta},bubbles:true}))`);
  return agrees(window, expected);
}

app.whenReady().then(async () => {
  try {
    await until(async () => overlayWindow(), Boolean, 'initial overlay');
    await loaded(overlayWindow());
    let settings = await openSettings();
    menu('aperture-settings');
    assert.equal(BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('settings.html')).length, 1, 'settings singleton');
    for (const radius of [20, 137, 300]) await setSlider(settings, radius);
    await precise(settings, 137.125);
    await wheel(settings, 0.25, 137.375);
    await setSlider(settings, 180);
    await wheel(settings, -0.5, 179.5);

    const sourceRequire = require('module').createRequire(path.join(process.env.MOUSE_CLICK_SOURCE, 'package.json'));
    const fc = sourceRequire('fast-check');
    const operations = fc.sample(fc.array(fc.oneof(
      fc.record({ kind: fc.constant('set'), value: fc.integer({ min: 20, max: 300 }) }),
      fc.record({ kind: fc.constant('wheel'), value: fc.integer({ min: -8, max: 8 }).map((v) => v / 4) })
    ), { minLength: 5, maxLength: 8 }), { seed: 20261025, numRuns: 1 })[0];
    let expected = 179.5;
    for (const operation of operations) {
      if (operation.kind === 'set') {
        expected = operation.value;
        await setSlider(settings, expected);
      } else {
        expected = Math.min(300, Math.max(20, expected + operation.value));
        await wheel(settings, operation.value, expected);
      }
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
    const failedView = await until(() => observe(settings), (v) => v.state.radius === 180 && /未保存|无法保存|保存失败/.test(v.status), 'visible save failure');
    assert.deepEqual(fs.readFileSync(file), preserved);
    fs.renameSync(file + '.tmp', file + '.blocked-archive');
    await settings.webContents.executeJavaScript('window.mouseClick.setRadius(180)');
    await agrees(settings, 180);
    const stable = await observe(settings);
    await sleep(250);
    assert.equal((await observe(settings)).state.revision, stable.state.revision, 'no update loop');
    fs.writeFileSync(path.join(testData, 'settings.png'), (await settings.webContents.capturePage()).toPNG());
    const report = { status: 'PASS', seed: 20261025, operations, checks, failedView };
    fs.writeFileSync(path.join(testData, 'e2e-result.json'), JSON.stringify(report, null, 2));
    console.log('MOUSE_CLICK_E2E_PASS ' + checks.length + ' real-window state checks');
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    fs.mkdirSync(testData, { recursive: true });
    fs.writeFileSync(path.join(testData, 'e2e-result.json'), JSON.stringify({ status: 'FAIL', error: error.stack, checks }, null, 2));
    console.error(error.stack);
    clearTimeout(deadline);
    app.exit(1);
  }
});
