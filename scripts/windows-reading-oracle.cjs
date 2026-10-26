// A real desktop oracle: input is global SendInput; inspector calls only observe
// the reader, or operate this application's own menu/settings test surface.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runInput } = require('./windows-native-input.cjs');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const overlay = `e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html'))`;
const readLayer = `(async()=>{if(!window.app)return null;const layers=Object.values(window.app.renderLayers);const bg=layers.find(x=>typeof x.radius==='number');return {radius:bg.radius,cursor:bg.cursorPosition,shapes:layers.find(x=>x.shapesSet)?.shapesSet.size||0,mode:document.documentElement.dataset.interactionMode||'legacy',state:await window.mouseClick.getRadius()}})()`;

class ReadingOracle {
  constructor(context) {
    assert.ok(process.platform === 'win32' && process.arch === 'x64' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'Native reading oracle only runs in disposable Windows x64 CI');
    Object.assign(this, context);
    this.evidence = { status: 'RUNNING', inputs: [], steps: [] };
  }
  save() { fs.writeFileSync(path.join(this.results, this.label + '-reading-oracle.json'), JSON.stringify(this.evidence, null, 2)); }
  input(action) {
    const result = runInput(action, this.results, this.label + '-input-' + this.evidence.inputs.length);
    this.evidence.inputs.push({ action, result }); this.save();
    return result;
  }
  async snapshot() {
    return this.client.evaluate(`const w=e.BrowserWindow.getAllWindows()[0];if(!w)return null;const state=await w.webContents.executeJavaScript('window.readingSnapshot&&window.readingSnapshot()');if(!state)return null;return {...state,pid:process.pid,visible:w.isVisible(),bounds:w.getBounds(),contentBounds:w.getContentBounds(),hwnd:w.getNativeWindowHandle().readBigUInt64LE().toString()};`);
  }
  async point(id, fx = 0.5, fy = 0.5) {
    return this.client.evaluate(`const w=e.BrowserWindow.getAllWindows()[0],b=w.getContentBounds();const s=await w.webContents.executeJavaScript('window.readingSnapshot()'),r=s.rects[${JSON.stringify(id)}];return e.screen.dipToScreenPoint({x:Math.round(b.x+r.x+r.width*${fx}),y:Math.round(b.y+r.y+r.height*${fy})});`);
  }
  async appView(client) {
    return client.evaluate(`const w=${overlay};if(!w||w.webContents.isLoadingMainFrame())return null;const view=await w.webContents.executeJavaScript(${JSON.stringify(readLayer)});if(!view)return null;const pointer=e.screen.getCursorScreenPoint();return {pid:process.pid,id:w.id,visible:w.isVisible(),focused:w.isFocused(),bounds:w.getBounds(),pointer,physicalPointer:e.screen.dipToScreenPoint(pointer),view};`);
  }
  bytes(data) {
    const file = path.join(data, 'aperture-settings.json');
    return fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null;
  }
  async invariant(client, data) { return { app: await this.appView(client), bytes: this.bytes(data) }; }
  async unchanged(client, data, before) {
    const after = await this.invariant(client, data);
    assert.ok(after.app && after.app.visible, 'the production overlay stays visible during reading');
    for (const key of ['radius', 'revision']) assert.equal(after.app.view.state[key], before.app.view.state[key], 'native reading preserves ' + key);
    assert.equal(after.app.view.radius, before.app.view.radius, 'native reading preserves the real canvas radius');
    assert.equal(after.bytes, before.bytes, 'native reading preserves exact settings bytes');
    return after;
  }
  async capture(client, prefix) {
    const png = await client.evaluate(`const w=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html'))||e.BrowserWindow.getAllWindows()[0];return (await w.webContents.capturePage()).toPNG().toString('base64');`);
    const file = path.join(this.results, this.label + '-' + prefix + '.png');
    fs.writeFileSync(file, Buffer.from(png, 'base64')); assert.ok(fs.statSync(file).size > 0); return file;
  }
  async start(label) {
    this.label = label; this.evidence.label = label;
    try {
    const executable = path.join(this.root, 'app_output', 'windows-reader', 'win-unpacked', 'Mouse Click Reading Fixture.exe');
    assert.ok(fs.statSync(executable).size > 0, 'separate reader fixture executable exists');
    const port = await this.freePort();
    this.child = this.launch(executable, ['--inspect=127.0.0.1:' + port], label + '-reader.log', { MOUSE_CLICK_READER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'mouse-click-reader-')) });
    this.client = await this.connect(port, this.child);
    const initial = await this.until(() => this.snapshot(), Boolean, label + ' reader ready');
    this.evidence.reader = { executable, pid: initial.pid, hwnd: initial.hwnd, bounds: initial.bounds };
    this.evidence.probe = this.input({ kind: 'probe' });
    const target = await this.point('native-button');
    this.input({ kind: 'click', ...target });
    let control;
    try { control = await this.until(() => this.snapshot(), s => s && s.clicks === initial.clicks + 1, label + ' no-overlay native click positive control', 10000); }
    catch (cause) { const error = new Error('No interactive native input oracle: reader did not receive the positive-control click', { cause }); error.code = 'ENVIRONMENT_NATIVE_INPUT_UNAVAILABLE'; throw error; }
    assert.ok(control.events.some(x => x.type === 'click' && x.trusted && x.target === 'native-button'), 'positive control records a trusted click');
    this.evidence.positiveControl = { before: initial, after: control };
    this.input({ kind: 'click', ...await this.point('native-input') });
    this.initialFocus = await this.until(() => this.snapshot(), s => s.focus && s.activeId === 'native-input', label + ' real reader input focus');
    this.evidence.initialFocus = this.initialFocus; this.save(); return this;
    } catch (error) { this.evidence.status = 'FAIL'; this.evidence.error = error.stack; this.save(); throw error; }
  }
  async checkInitialFocus(appClient) {
    const app = await this.until(() => this.appView(appClient), Boolean, this.label + ' initial production overlay');
    const reader = await this.snapshot();
    this.evidence.initialProductionFocus = { app, reader }; this.save();
    assert.equal(app.view.mode, 'reading', 'production defaults to reading mode');
    assert.ok(app.visible && !app.focused, 'initial reading overlay is visible without keyboard focus');
    assert.ok(reader.focus && reader.activeId === this.initialFocus.activeId, 'initial overlay does not steal the existing reader focus');
    return this.evidence.initialProductionFocus;
  }
  async setRadius(client, radius) {
    const state = await client.evaluate(`const w=${overlay};return w.webContents.executeJavaScript(${JSON.stringify('window.mouseClick.setRadius(' + radius + ')')});`);
    assert.equal(state.radius, radius); assert.equal(state.saved, true);
    return this.until(() => this.appView(client), s => s && s.view.state.radius === radius && s.view.radius === radius, this.label + ' native-test radius ' + radius);
  }
  async clickAndObserve(client, data, name) {
    const before = await this.snapshot(), stable = await this.invariant(client, data);
    this.input({ kind: 'click', ...await this.point('native-button') });
    const after = await this.until(() => this.snapshot(), s => s.clicks === before.clicks + 1, name + ' reader button receives exactly one native click');
    const unchanged = await this.unchanged(client, data, stable);
    this.evidence.steps.push({ name, before, after, unchanged }); this.save();
  }
  async nativeSettings(client, data) {
    await this.setRadius(client, 20);
    const settingsView = () => client.evaluate(`const w=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('settings.html'));if(!w)return null;return w.webContents.executeJavaScript('({number:Number(document.querySelector("#radiusNumber").value),slider:Number(document.querySelector("#radius").value)})');`);
    const before = await this.until(settingsView, s => s && s.number === 20 && s.slider === 20, this.label + ' native settings starts at a different value');
    const position = await client.evaluate(`const w=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('settings.html'));if(!w)return null;const b=w.getContentBounds(),r=await w.webContents.executeJavaScript('(()=>{const r=document.querySelector("#radiusNumber").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');return e.screen.dipToScreenPoint({x:Math.round(b.x+r.x+r.width/2),y:Math.round(b.y+r.y+r.height/2)});`);
    assert.ok(position, 'production settings window is open for native input');
    this.input({ kind: 'click', ...position }); this.input({ kind: 'key', key: 'CtrlA' });
    this.input({ kind: 'type', text: '137.125' }); this.input({ kind: 'key', key: 'Enter' });
    const saved = await this.until(() => this.appView(client), s => s && s.view.radius === 137.125 && s.view.state.radius === 137.125, this.label + ' native number field updates production radius');
    const after = await this.until(settingsView, s => s && s.number === 137.125 && s.slider === 137.125, this.label + ' native settings controls agree');
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'aperture-settings.json'), 'utf8')).radius, 137.125);
    this.evidence.nativeSettings = { before, after, app: saved };
    await client.evaluate(`for(const w of e.BrowserWindow.getAllWindows())if(w.webContents.getURL().includes('settings.html'))w.close();return true;`);
  }
  async follow(client, physical, name) {
    const result = this.input({ kind: 'move', ...physical });
    const app = await this.until(() => this.appView(client), s => s && Math.abs(s.view.cursor.x - (s.pointer.x - s.bounds.x)) <= 1 && Math.abs(s.view.cursor.y - (s.pointer.y - s.bounds.y)) <= 1 && Math.abs(s.physicalPointer.x - physical.x) <= 2 && Math.abs(s.physicalPointer.y - physical.y) <= 2, name + ' real pointer/canvas convergence');
    assert.ok(Math.abs(result.position.x - physical.x) <= 2 && Math.abs(result.position.y - physical.y) <= 2, 'global input actually moved the desktop pointer');
    this.evidence.steps.push({ name, input: result, app }); this.save(); return app;
  }
  async validate(client, data, kind) {
    try {
      await this.nativeSettings(client, data);
      for (const radius of [20, 137.125, 300]) {
        await this.setRadius(client, radius);
        const stable = await this.invariant(client, data);
        const target = await this.point('native-scroll');
        this.input({ kind: 'wheel', ...target, delta: 12000 });
        await this.until(() => this.snapshot(), s => s.scrollTop === 0, kind + ' scroll reset to top');
        const before = await this.snapshot();
        this.input({ kind: 'wheel', ...target, delta: -480 });
        const down = await this.until(() => this.snapshot(), s => s.scrollTop > before.scrollTop, kind + ' real downward reading scroll');
        this.input({ kind: 'wheel', ...target, delta: 480 });
        const up = await this.until(() => this.snapshot(), s => s.scrollTop < down.scrollTop, kind + ' real upward reading scroll');
        assert.ok(up.scrollTop >= 0 && down.scrollTop <= down.scrollHeight - down.clientHeight);
        assert.ok(down.events.some(x => x.type === 'wheel' && x.trusted), 'real wheel reaches the reader');
        const unchanged = await this.unchanged(client, data, stable);
        this.evidence.steps.push({ name: 'wheel-size-conservation', radius, before, down, up, unchanged }); this.save();
      }
      await this.setRadius(client, 137.125);
      await this.clickAndObserve(client, data, kind + ' reading');
      const stable = await this.invariant(client, data);
      const textFrom = await this.point('native-text', 0.001), textTo = await this.point('native-text', 0.999);
      this.input({ kind: 'drag', ...textFrom, x2: textTo.x, y2: textTo.y });
      const selection = await this.until(() => this.snapshot(), s => s.selection === 'Mouse Click reading test.', kind + ' exact native text selection');
      await this.unchanged(client, data, stable);
      this.evidence.steps.push({ name: 'text-selection', after: selection }); this.save();
      const scrollPoint = await this.point('native-scroll');
      this.input({ kind: 'wheel', ...scrollPoint, delta: 12000 });
      const top = await this.until(() => this.snapshot(), s => s.scrollTop === 0, kind + ' scrollbar starts at top');
      const start = await this.point('native-scroll', 0.988, 0.075), end = await this.point('native-scroll', 0.988, 0.75);
      this.input({ kind: 'drag', ...start, x2: end.x, y2: end.y });
      const dragged = await this.until(() => this.snapshot(), s => s.scrollTop > top.scrollTop, kind + ' real scrollbar thumb drag');
      await this.unchanged(client, data, stable);
      this.evidence.steps.push({ name: 'scrollbar-drag', before: top, after: dragged }); this.save();
      this.input({ kind: 'click', ...await this.point('native-input') });
      const typed = 'READING-' + kind;
      this.input({ kind: 'type', text: typed });
      const input = await this.until(() => this.snapshot(), s => s.input === typed && s.focus && s.activeId === 'native-input', kind + ' native reader keyboard input');
      await this.unchanged(client, data, stable);
      this.evidence.steps.push({ name: 'keyboard-input', after: input });
      for (const id of ['native-button', 'native-text', 'native-scroll']) await this.follow(client, await this.point(id), kind + ' ' + id);
      const original = (await this.appView(client)).bounds;
      try {
        await client.evaluate(`const w=${overlay};w.unmaximize();w.setBounds({x:${original.x + 17},y:${original.y + 23},width:${original.width - 34},height:${original.height - 46}});return true;`);
        await pause(150);
        const moved = await this.appView(client);
        assert.ok(moved.bounds.x !== original.x || moved.bounds.y !== original.y, 'actual overlay has a nonzero changed origin');
        await this.follow(client, await this.point('native-button'), kind + ' nonzero origin');
      } finally { await client.evaluate(`const w=${overlay};w.setBounds(${JSON.stringify(original)});w.maximize();return true;`); }
      await this.clickMenu(client, 'drawing-mode');
      const away = await this.point('native-scroll', 0.7, 0.8);
      this.input({ kind: 'move', ...away });
      await pause(150);
      const drawing = await this.appView(client), readerBefore = await this.snapshot();
      assert.equal(drawing.view.mode, 'drawing'); assert.ok(drawing.visible);
      const button = await this.point('native-button');
      const buttonDip = await this.client.evaluate(`return e.screen.screenToDipPoint(${JSON.stringify(button)});`);
      assert.ok(Math.hypot(buttonDip.x - drawing.bounds.x - drawing.view.cursor.x, buttonDip.y - drawing.bounds.y - drawing.view.cursor.y) > drawing.view.radius + 8, 'negative-control target is in the gray covered area, outside the transparent hole');
      this.input({ kind: 'click', ...button }); await pause(200);
      const blocked = await this.snapshot();
      assert.equal(blocked.clicks, readerBefore.clicks, 'drawing gray-area negative control blocks the same underlying click');
      this.evidence.negativeControl = { app: drawing, before: readerBefore, after: blocked, target: button, screenshot: await this.capture(client, 'drawing-negative-control') }; this.save();
      const paintFrom = await this.point('native-text', 0.1), paintTo = await this.point('native-scroll', 0.6, 0.5);
      this.input({ kind: 'move', ...away }); await pause(150);
      const oldShapes = (await this.appView(client)).view.shapes;
      this.input({ kind: 'drag', ...paintFrom, x2: paintTo.x, y2: paintTo.y });
      const painted = await this.until(() => this.appView(client), s => s.view.shapes > oldShapes, kind + ' drawing creates an actual stroke');
      this.evidence.drawing = { beforeShapes: oldShapes, after: painted, screenshot: await this.capture(client, 'drawing-stroke') };
      await this.clickMenu(client, 'reading-mode');
      await this.until(() => this.appView(client), s => s && s.view.mode === 'reading' && !s.focused, kind + ' reading releases drawing focus');
      await this.clickAndObserve(client, data, kind + ' restored reading');
      this.input({ kind: 'click', ...await this.point('native-input') });
      for (let round = 1; round <= 2; round++) {
        const before = await this.appView(client), beforeReader = await this.snapshot(), beforeBytes = this.bytes(data);
        assert.ok(beforeReader.focus && beforeReader.activeId === 'native-input');
        this.input({ kind: 'key', key: 'AltX' });
        await this.until(() => this.appView(client), s => s === null, kind + ' native AltX hides overlay');
        this.input({ kind: 'key', key: 'AltX' });
        const reopened = await this.until(() => this.appView(client), Boolean, kind + ' native AltX reopens overlay');
        const reader = await this.snapshot(); // No reactivation/input before this read.
        assert.ok(reader.focus && reader.activeId === beforeReader.activeId, 'AltX reopen preserves existing reader keyboard focus');
        assert.equal(reopened.pid, before.pid); assert.equal(reopened.view.radius, 137.125);
        assert.equal(reopened.view.state.revision, before.view.state.revision); assert.equal(this.bytes(data), beforeBytes);
        assert.equal(await client.evaluate(`return e.BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL().includes('index.html')).length;`), 1);
        this.evidence.steps.push({ name: 'native-hotkey-reopen', round, reopened, reader }); this.save();
        await this.follow(client, await this.point('native-text', round / 3), kind + ' reopened follow ' + round);
        this.input({ kind: 'type', text: String(round) });
        await this.until(() => this.snapshot(), s => s.input.endsWith(String(round)), kind + ' keyboard still reaches reader');
      }
      this.evidence.screenshots = { reader: await this.capture(this.client, 'reader-final'), overlay: await this.capture(client, 'overlay-final') };
      await this.unchanged(client, data, stable);
      await this.clickMenu(client, 'aperture-settings');
      await this.until(() => client.evaluate(`return e.BrowserWindow.getAllWindows().some(w=>w.webContents.getURL().includes('settings.html')&&w.isVisible());`), Boolean, kind + ' settings reopened for lifecycle checks');
      this.evidence.status = 'PASS'; this.save(); return this.evidence;
    } catch (error) { this.evidence.status = 'FAIL'; this.evidence.error = error.stack; this.save(); throw error; }
  }
  async observeLegacy(client, data) {
    const before = await this.until(() => this.appView(client), Boolean, this.label + ' legacy production renderer ready'), readerBefore = await this.snapshot();
    const away = await this.point('native-scroll', 0.7, 0.8);
    this.input({ kind: 'move', ...away }); await pause(200);
    this.input({ kind: 'click', ...await this.point('native-button') }); await pause(200);
    const clicked = await this.snapshot();
    this.input({ kind: 'wheel', ...await this.point('native-scroll'), delta: -480 }); await pause(300);
    const after = await this.appView(client), readerAfter = await this.snapshot();
    const failures = [];
    if (clicked.clicks === readerBefore.clicks) failures.push('underlying-click-blocked');
    if (after.view.radius !== before.view.radius) failures.push('native-wheel-changes-radius');
    this.evidence.legacy = { status: failures.length ? 'EXPECTED_PRODUCT_FAILURE' : 'NOT_REPRODUCED', failures, before, after, readerBefore, clicked, readerAfter, savedBytesAfter: this.bytes(data), screenshot: await this.capture(client, 'legacy-overlay') };
    this.save(); return this.evidence.legacy;
  }
  async close() {
    if (this.client) {
      try { await this.client.evaluate('setTimeout(()=>e.app.quit(),50);return {pid:process.pid};'); }
      finally { await this.client.disconnect(); this.client = null; }
    }
    if (this.child) {
      let timer;
      let result;
      try { result = await Promise.race([this.child.completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reader fixture did not exit')), 15000); })]); }
      finally { clearTimeout(timer); }
      assert.equal(result.code, 0, 'own reader fixture exits cleanly');
      this.evidence.readerExit = result; this.save();
    }
  }
}

module.exports = { ReadingOracle };
