const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { inspectAsar, sha256 } = require('./check-windows-packages.cjs');
const { ReadingOracle } = require('./windows-reading-oracle.cjs');

const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results', 'windows');
const reportFile = path.join(results, 'runtime-checks.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalPath = (value) => path.resolve(value).toLowerCase();
const ownedProcesses = new Set();
let activeClient;
let activeMainPid;
let activeOracle;
let stage = 'startup';
const report = {
  status: 'RUNNING', platform: process.platform, arch: process.arch,
  commit: process.env.GITHUB_SHA || null, runId: process.env.GITHUB_RUN_ID || null,
  startedAt: new Date().toISOString(), production: [], restarts: [],
};
function saveReport() { fs.writeFileSync(reportFile, JSON.stringify({ ...report, stage }, null, 2)); }
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function until(read, accept, label, timeoutMs = 15000) {
  stage = label;
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await sleep(75);
  }
  throw new Error('Timed out: ' + label + '; last value=' + JSON.stringify(last));
}
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), ms); })]); }
  finally { clearTimeout(timer); }
}
function launch(executable, args, logName, extraEnv = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith('MOUSE_CLICK_E2E_')) delete environment[name];
  Object.assign(environment, extraEnv);
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.IS_DEV;
  // GUI executables must be shown: windowsHide also passes SW_HIDE to their
  // first ShowWindow call, leaving a rendered but invisible native test target.
  const child = spawn(executable, args, { env: environment, windowsHide: false, cwd: root });
  if (child.pid) ownedProcesses.add(child.pid);
  const log = fs.createWriteStream(path.join(results, logName));
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const record = { child, pid: child.pid, executable, exit: null };
  child.once('error', (error) => { record.error = error.message; });
  record.completed = new Promise((resolve) => child.once('close', (code, signal) => {
    ownedProcesses.delete(child.pid);
    record.exit = { code, signal, error: record.error || null, at: new Date().toISOString() };
    log.end();
    resolve(record.exit);
  }));
  return record;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

class Inspector {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error('Inspector protocol: ' + JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Inspector disconnected during a command'));
      }
      this.pending.clear();
    });
  }
  async evaluate(body) {
    const id = ++this.nextId;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Inspector evaluation timed out')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
      expression: '(async()=>{const e=process.mainModule.require("electron");' + body + '})()',
      awaitPromise: true, returnByValue: true,
    } }));
    const result = await response;
    if (result.exceptionDetails) throw new Error('Application evaluation: ' + JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async disconnect() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await bounded(new Promise((resolve) => {
      this.socket.addEventListener('close', resolve, { once: true });
      this.socket.close();
    }), 5000, 'inspector disconnect');
  }
}

async function connect(port, processRecord) {
  const targets = await until(async () => {
    if (processRecord && processRecord.exit) throw new Error('Application exited before inspector connection: ' + JSON.stringify(processRecord.exit));
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1500) });
      return await response.json();
    } catch { return []; }
  }, (value) => value.some((item) => item.webSocketDebuggerUrl), 'own process inspector ready', 45000);
  const target = targets.find((item) => item.webSocketDebuggerUrl);
  const url = new URL(target.webSocketDebuggerUrl);
  assert.equal(url.hostname, '127.0.0.1', 'inspector only uses loopback');
  assert.equal(Number(url.port), port, 'inspector remains on the allocated port');
  const socket = new WebSocket(url);
  await bounded(new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Unable to connect to the own-process inspector')), { once: true });
  }), 10000, 'inspector websocket open');
  return new Inspector(socket);
}
const metadataBody = 'return {pid:process.pid,platform:process.platform,electron:process.versions.electron,ready:e.app.isReady(),packaged:e.app.isPackaged,appPath:e.app.getAppPath(),execPath:process.execPath,userData:e.app.getPath("userData"),name:e.app.getName(),version:e.app.getVersion(),portableFile:process.env.PORTABLE_EXECUTABLE_FILE||null};';
const windowsBody = 'return e.BrowserWindow.getAllWindows().map(w=>({id:w.id,url:w.webContents.getURL(),visible:w.isVisible(),destroyed:w.isDestroyed()}));';
async function clickMenu(client, id) {
  await client.evaluate('const item=e.Menu.getApplicationMenu().getMenuItemById(' + JSON.stringify(id) + ');if(!item)throw Error("Missing native menu item");item.click(item,e.BrowserWindow.getFocusedWindow());return true;');
}
async function readView(client) {
  return client.evaluate(`
    const windows=e.BrowserWindow.getAllWindows();
    const settings=windows.find(w=>w.webContents.getURL().includes('settings.html'));
    const overlay=windows.find(w=>w.webContents.getURL().includes('index.html'));
    if(!settings||!overlay)return null;
    const view=await settings.webContents.executeJavaScript(
      '(async()=>{if(!window.mouseClick||!document.querySelector("#radius")||document.querySelector("#radius").disabled)return null;return {state:await window.mouseClick.getRadius(),slider:Number(document.querySelector("#radius").value),number:Number(document.querySelector("#radiusNumber").value),text:document.querySelector("#radiusValue").textContent,previewWidth:document.querySelector("#previewRing").getBoundingClientRect().width}})()');
    if(!view)return null;
    view.canvas=await overlay.webContents.executeJavaScript('window.app && Object.values(window.app.renderLayers).find(x=>typeof x.radius==="number")?.radius');
    view.settingsVisible=settings.isVisible();view.overlayVisible=overlay.isVisible();
    return view;
  `);
}
async function agreement(client, data, radius) {
  const view = await until(() => readView(client), (value) => value && value.state.radius === radius && value.slider === radius && value.number === radius && value.canvas === radius, 'production IPC/DOM/canvas converge to ' + radius);
  assert.ok(Math.abs(view.previewWidth - radius * 0.64) < 0.1, 'production preview radius');
  assert.equal(view.text.trim(), String(Number(radius.toFixed(2))), 'production visible radius');
  assert.ok(view.settingsVisible && view.overlayVisible, 'both production windows are visible');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'aperture-settings.json'), 'utf8')).radius, radius, 'production saved radius');
  return view;
}
async function setRadius(client, data, radius) {
  const state = await client.evaluate('const w=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes("settings.html"));return w.webContents.executeJavaScript(' + JSON.stringify('window.mouseClick.setRadius(' + radius + ')') + ');');
  assert.equal(state.radius, radius, 'production IPC result radius');
  assert.equal(state.saved, true, 'production IPC saved successfully');
  return agreement(client, data, radius);
}
async function screenshots(client, prefix) {
  const paths = {};
  for (const [kind, page] of [['settings', 'settings.html'], ['overlay', 'index.html']]) {
    const png = await client.evaluate('const w=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes(' + JSON.stringify(page) + '));return (await w.webContents.capturePage()).toPNG().toString("base64");');
    const file = path.join(results, prefix + '-' + kind + '.png');
    fs.writeFileSync(file, Buffer.from(png, 'base64'));
    assert.ok(fs.statSync(file).size > 0, 'nonempty captured production screenshot');
    paths[kind] = file;
  }
  return paths;
}

async function smoke(kind, executable, expectedAsarHash) {
  const oracle = new ReadingOracle({ root, results, launch, connect, freePort, until, clickMenu });
  activeOracle = oracle;
  await oracle.start(kind);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mouse-click-' + kind + '-'));
  const port = await freePort();
  const child = launch(executable, ['--inspect=127.0.0.1:' + port, '--user-data-dir=' + data], kind + '.log');
  const result = { kind, executable, launcherPid: child.pid, data, port, status: 'RUNNING', states: [], zeroWindow: [] };
  report.production.push(result);
  saveReport();
  let client = await connect(port, child);
  activeClient = client;
  const metadata = await until(() => client.evaluate(metadataBody), (value) => value.ready, kind + ' app ready');
  result.metadata = metadata;
  activeMainPid = metadata.pid;
  assert.equal(metadata.platform, 'win32');
  assert.equal(metadata.packaged, true, 'real packaged production application');
  assert.equal(metadata.version, require('../package.json').version);
  assert.equal(normalPath(metadata.userData), normalPath(data), 'production uses the isolated CI profile');
  assert.equal(path.basename(metadata.appPath), 'app.asar', 'production runtime uses a real ASAR');
  assert.equal(normalPath(metadata.execPath), normalPath(path.join(path.dirname(path.dirname(metadata.appPath)), 'Mouse Click.exe')), 'main executable belongs to its observed production package');
  if (kind === 'installed') assert.equal(normalPath(metadata.execPath), normalPath(executable), 'installed EXE is the requested target');
  else assert.equal(normalPath(metadata.portableFile || ''), normalPath(executable), 'portable runtime identifies the requested launcher');
  ownedProcesses.add(metadata.pid);
  result.asar = inspectAsar(metadata.appPath);
  assert.equal(result.asar.sha256, expectedAsarHash, 'launched production ASAR matches the checked build');
  // Both production launches run only in the disposable Windows CI account.
  // Undo this process's packaged-app startup registration before any possible test failure.
  await client.evaluate('e.app.setLoginItemSettings({openAtLogin:false});return true;');
  await until(() => client.evaluate(windowsBody), (value) => value.some((item) => item.url.includes('index.html')), kind + ' initial overlay');
  result.initialReadingFocus = await oracle.checkInitialFocus(client);
  await clickMenu(client, 'aperture-settings');
  await until(() => readView(client), (value) => value && Number.isFinite(value.canvas), kind + ' rendered windows');
  for (const window of await client.evaluate(windowsBody)) {
    assert.ok(window.url.startsWith('file:'), 'production window loads a packaged file');
    const actual = fileURLToPath(window.url);
    const page = window.url.includes('settings.html') ? 'settings.html' : 'index.html';
    assert.equal(normalPath(actual), normalPath(path.join(metadata.appPath, 'dist', page)), 'page belongs to the running ASAR');
  }
  await clickMenu(client, 'aperture-settings');
  assert.equal((await client.evaluate(windowsBody)).filter((item) => item.url.includes('settings.html')).length, 1, 'production settings singleton');
  for (const radius of [20, 137.125, 300]) result.states.push({ radius, view: await setRadius(client, data, radius) });
  result.screenshots = await screenshots(client, kind);
  await setRadius(client, data, 137.125);
  result.nativeReading = await oracle.validate(client, data, kind);
  saveReport();

  for (let round = 1; round <= 2; round++) {
    stage = kind + ' zero-window round ' + round;
    const cycle = { round, pid: metadata.pid, aliveSamples: [] };
    result.zeroWindow.push(cycle);
    cycle.scheduled = await client.evaluate('setTimeout(()=>{const settings=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes("settings.html"));if(settings)settings.close();const item=e.Menu.getApplicationMenu().getMenuItemById("highlight-hide");if(!item)throw Error("Missing highlight-hide menu item");item.click(item,e.BrowserWindow.getFocusedWindow());},50);return {pid:process.pid,at:Date.now()};');
    // Node can wait for an attached debugger during app.quit(). Disconnect BEFORE
    // observing survival, otherwise the old window-all-closed bug can falsely pass.
    await client.disconnect();
    activeClient = null;
    cycle.detachedAt = Date.now();
    const observeUntil = Date.now() + 1200;
    while (Date.now() < observeUntil) {
      const sample = { at: Date.now(), alive: alive(metadata.pid) };
      cycle.aliveSamples.push(sample);
      if (!sample.alive) {
        const error = new Error('W3 product failure: the production process exited after closing all windows (PID ' + metadata.pid + ')');
        error.code = 'PRODUCT_ZERO_WINDOW_EXIT';
        throw error;
      }
      await sleep(100);
    }
    assert.ok(Date.now() - cycle.detachedAt >= 1000, 'at least one second of survival without a debugger');
    client = await connect(port);
    activeClient = client;
    const current = await client.evaluate(metadataBody);
    assert.equal(current.pid, metadata.pid, 'same real main process survives');
    cycle.zeroState = await client.evaluate(windowsBody);
    assert.equal(cycle.zeroState.length, 0, 'all production BrowserWindows closed');
    await clickMenu(client, 'highlight-show');
    await clickMenu(client, 'aperture-settings');
    cycle.reopenedView = await agreement(client, data, 137.125);
    cycle.reopenedWindows = await client.evaluate(windowsBody);
    assert.equal(cycle.reopenedWindows.filter((item) => item.url.includes('index.html')).length, 1, 'one reopened production overlay');
    assert.equal(cycle.reopenedWindows.filter((item) => item.url.includes('settings.html')).length, 1, 'one reopened production settings window');
    cycle.screenshots = await screenshots(client, kind + '-reopened-' + round);
    saveReport();
  }
  await client.evaluate('e.app.setLoginItemSettings({openAtLogin:false});setTimeout(()=>e.app.quit(),50);return {pid:process.pid};');
  await client.disconnect();
  activeClient = null;
  await until(() => alive(metadata.pid), (value) => !value, kind + ' explicit quit exits the real main PID', 20000);
  ownedProcesses.delete(metadata.pid);
  result.exit = await bounded(child.completed, 30000, kind + ' launcher exits');
  assert.equal(result.exit.code, 0, 'production launcher exits successfully');
  result.status = 'PASS';
  activeMainPid = null;
  await oracle.close();
  activeOracle = null;
  saveReport();
}

async function previousReleaseBaseline() {
  stage = 'previous release native reading baseline';
  const executable = path.join(root, 'app_output', 'baseline-1.0.4', 'Mouse-Click-1.0.4-x64-Portable.exe');
  assert.equal(sha256(executable), '3574a5361528644c84f2773d183c91bf3d2cc4919aca38dcf91897c3d245dff4', 'baseline is the original published portable EXE');
  const oracle = new ReadingOracle({ root, results, launch, connect, freePort, until, clickMenu });
  activeOracle = oracle;
  await oracle.start('baseline');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mouse-click-old-reading-'));
  const port = await freePort();
  const child = launch(executable, ['--inspect=127.0.0.1:' + port, '--user-data-dir=' + data], 'previous-release.log');
  const client = await connect(port, child);
  activeClient = client;
  const metadata = await until(() => client.evaluate(metadataBody), (value) => value.ready, 'previous release ready');
  activeMainPid = metadata.pid;
  ownedProcesses.add(metadata.pid);
  assert.equal(metadata.version, '1.0.4', 'baseline runtime is the published old version');
  await client.evaluate('e.app.setLoginItemSettings({openAtLogin:false});return true;');
  report.readingBaseline = { metadata, evidence: await oracle.observeLegacy(client, data) };
  saveReport();
  await client.evaluate('setTimeout(()=>e.app.quit(),50);return true;');
  await client.disconnect();
  activeClient = null;
  await until(() => alive(metadata.pid), (value) => !value, 'previous release exits');
  assert.equal((await bounded(child.completed, 30000, 'previous portable launcher exits')).code, 0);
  ownedProcesses.delete(metadata.pid);
  activeMainPid = null;
  await oracle.close();
  activeOracle = null;
}

async function restartTests() {
  const executable = path.join(root, 'app_output', 'windows-test', 'win-unpacked', 'Mouse Click.exe');
  assert.ok(fs.statSync(executable).size > 0, 'separate Windows test package exists');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mouse-click-restart-'));
  report.restartData = data;
  const phases = [
    { phase: 'p1-full', final: 137.125 },
    { phase: 'p2-resume', expected: 137.125, final: 180 },
    { phase: 'p3-resume', expected: 180 },
  ];
  const pids = new Set();
  for (const phase of phases) {
    stage = phase.phase;
    const file = path.join(results, phase.phase + '.json');
    const environment = {
      MOUSE_CLICK_E2E_DATA: data, MOUSE_CLICK_E2E_RESULT: file,
      MOUSE_CLICK_E2E_PHASE: phase.phase, MOUSE_CLICK_SOURCE: root,
    };
    if (phase.expected !== undefined) environment.MOUSE_CLICK_E2E_EXPECT_RADIUS = String(phase.expected);
    if (phase.final !== undefined) environment.MOUSE_CLICK_E2E_FINAL_RADIUS = String(phase.final);
    const child = launch(executable, [], phase.phase + '.log', environment);
    const result = { ...phase, pid: child.pid, reportFile: file, data, status: 'RUNNING' };
    report.restarts.push(result);
    saveReport();
    result.exit = await bounded(child.completed, 120000, phase.phase + ' complete process exit');
    assert.equal(result.exit.code, 0, phase.phase + ' exits successfully');
    assert.equal(alive(child.pid), false, 'previous test process is completely gone');
    assert.ok(!pids.has(child.pid), 'three different real test-process PIDs');
    pids.add(child.pid);
    const details = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(details.status, 'PASS', phase.phase + ' has a PASS report');
    assert.equal(details.pid, child.pid, 'report belongs to the launched test process');
    assert.equal(details.platform, 'win32');
    assert.equal(normalPath(details.userData), normalPath(data));
    assert.equal(details.radius, phase.final === undefined ? phase.expected : phase.final, 'final radius for phase');
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'aperture-settings.json'), 'utf8')).radius, details.radius);
    if (phase.expected !== undefined) {
      assert.equal(details.startup.expectedRadius, phase.expected);
      assert.equal(details.startup.view.state.radius, phase.expected);
      assert.equal(details.startup.view.slider, phase.expected);
      assert.equal(details.startup.view.number, phase.expected);
      assert.equal(details.startup.canvasRadius, phase.expected);
      assert.equal(details.startup.diskRadius, phase.expected);
      for (const suffix of ['startup-settings.png', 'startup-overlay.png']) {
        assert.ok(fs.statSync(path.join(results, phase.phase + '-' + suffix)).size > 0, 'restored-state screenshot');
      }
    } else {
      assert.equal(details.seed, 20261025);
      assert.ok(details.operations.length >= 5, 'existing generated real-window operation sequence ran');
      assert.ok(details.failedView && /未保存|无法保存|保存失败/.test(details.failedView.status), 'existing real-save-failure UI verified');
    }
    for (const screenshot of Object.values(details.screenshots)) assert.ok(fs.statSync(screenshot).size > 0, 'phase screenshot retained');
    result.status = 'PASS';
    result.radius = details.radius;
    saveReport();
  }
  assert.equal(pids.size, 3, 'three independent complete process starts');
}

async function cleanup() {
  let readerCleanupError;
  if (activeClient) {
    try { await activeClient.evaluate('e.app.setLoginItemSettings({openAtLogin:false});setTimeout(()=>e.app.quit(),50);return true;'); } catch {}
    try { await activeClient.disconnect(); } catch {}
    activeClient = null;
  }
  if (activeMainPid) await sleep(300);
  if (activeOracle) {
    try { await activeOracle.close(); }
    catch (error) { readerCleanupError = error; }
    finally { activeOracle = null; }
  }
  // Only descendants launched by this script are eligible for forced teardown.
  for (const pid of ownedProcesses) {
    if (!alive(pid)) continue;
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await bounded(new Promise((resolve) => { killer.once('close', resolve); killer.once('error', resolve); }), 10000, 'own process cleanup');
  }
  if (readerCleanupError) throw readerCleanupError;
}

async function main() {
  fs.mkdirSync(results, { recursive: true });
  try {
    assert.equal(process.platform, 'win32', 'Windows runtime verification requires a real Windows host; this is not a skipped PASS');
    assert.equal(process.arch, 'x64', 'Windows runtime verification requires an x64 host');
    assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'Runtime checks require a disposable GitHub-hosted runner, not a personal Windows account');
    assert.equal(typeof WebSocket, 'function', 'the Windows driver requires Node 24 WebSocket support');
    const packages = JSON.parse(fs.readFileSync(path.join(results, 'package-checks.json'), 'utf8'));
    assert.equal(packages.status, 'PASS', 'real package and silent installation checks passed');
    assert.equal(packages.commit, process.env.GITHUB_SHA || null, 'package evidence belongs to this commit');
    for (const artifact of packages.artifacts) assert.equal(sha256(artifact.path), artifact.sha256, 'checked EXE bytes have not changed');
    await previousReleaseBaseline();
    await smoke('installed', packages.installed.executable, packages.production.asar.sha256);
    const portable = packages.artifacts.find((item) => item.fileName.endsWith('-Portable.exe'));
    assert.ok(portable, 'checked portable artifact exists');
    await smoke('portable', portable.path, packages.production.asar.sha256);
    await restartTests();
    report.status = 'PASS';
    console.log('WINDOWS_RUNTIME_CHECKS_PASS native reading input + installed + portable + three independent test starts');
  } catch (error) {
    report.status = 'FAIL';
    report.failureKind = error.code?.startsWith('ENVIRONMENT_') ? 'environment-native-input' : error.code === 'PRODUCT_ZERO_WINDOW_EXIT' ? 'product-zero-window-exit' : 'test-or-runtime-failure';
    if (error.evidence) report.failureEvidence = error.evidence;
    report.reason = error.stack || String(error);
    console.error(report.reason);
    process.exitCode = 1;
  } finally {
    if (process.platform === 'win32') {
      try { await cleanup(); }
      catch (error) { report.status = 'FAIL'; report.cleanupError = error.stack; console.error(error.stack); process.exitCode = 1; }
    }
    report.finishedAt = new Date().toISOString();
    saveReport();
  }
}

main();
