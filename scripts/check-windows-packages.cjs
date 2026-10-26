const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results', 'windows');
const output = path.join(root, 'app_output');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function inspectAsar(file) {
  const asar = require('asar');
  assert.ok(fs.statSync(file).size > 0, 'nonempty application ASAR: ' + file);
  const files = asar.listPackage(file).map((entry) => entry.replace(/\\/g, '/').replace(/^\//, ''));
  const required = [
    'electron/main.js', 'electron/preload.js', 'electron/aperture-settings.js',
    'electron/trayIcon.png', 'dist/index.html', 'dist/settings.html', 'package.json', 'LICENSE',
  ];
  for (const entry of required) assert.ok(files.includes(entry), 'production package contains ' + entry);
  for (const entry of files) {
    assert.ok(/^(electron|dist)(\/|$)|^(package\.json|LICENSE)$/.test(entry), 'only production resources: ' + entry);
    assert.ok(!/(^|\/)(tests|\.claude|coverage[^/]*)(\/|$)/i.test(entry), 'no test or local report resources: ' + entry);
    if (/\.(js|cjs|mjs|json|html|css|map|txt)$/i.test(entry)) {
      const content = asar.extractFile(file, entry).toString('utf8');
      assert.ok(!/\/Users\/[^/]+\//.test(content), 'no private machine path in ' + entry);
    }
  }
  const metadata = JSON.parse(asar.extractFile(file, 'package.json').toString('utf8'));
  assert.equal(metadata.main, 'electron/main.js', 'production entry point');
  assert.equal(metadata.name, 'mouse-click', 'Windows application name');
  assert.equal(metadata.productName, 'Mouse Click', 'Windows product name');
  return { path: file, sha256: sha256(file), files, metadata: {
    main: metadata.main, name: metadata.name, productName: metadata.productName, version: metadata.version,
  } };
}

function runInstaller(executable, installPath, logFile) {
  return new Promise((resolve, reject) => {
    // NSIS requires /D to be the last argument. The disposable path is retained as evidence.
    const child = spawn(executable, ['/S', '/D=' + installPath], { windowsHide: true });
    const log = fs.createWriteStream(logFile);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Silent installer timed out after 120 seconds'));
    }, 120000);
    child.once('error', (error) => { clearTimeout(timer); log.end(); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      log.end();
      if (code === 0) resolve({ pid: child.pid, exitCode: code, signal });
      else reject(new Error('Silent installer failed: exit=' + code + ' signal=' + signal));
    });
  });
}

async function main() {
  fs.mkdirSync(results, { recursive: true });
  const reportFile = path.join(results, 'package-checks.json');
  const report = {
    status: 'RUNNING', platform: process.platform, arch: process.arch,
    commit: process.env.GITHUB_SHA || null,
    runUrl: process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? 'https://github.com/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID : null,
    startedAt: new Date().toISOString(),
  };
  try {
    assert.equal(process.platform, 'win32', 'Windows package checks require a real Windows host; this is not a skipped PASS');
    assert.equal(process.arch, 'x64', 'Windows x64 package checks require an x64 host');
    assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'Installation checks require a disposable GitHub-hosted runner, not a personal Windows account');
    const version = require('../package.json').version;
    report.version = version;
    const names = ['Setup', 'Portable'].map((kind) => 'Mouse-Click-' + version + '-x64-' + kind + '.exe');
    report.artifacts = names.map((fileName) => {
      const file = path.join(output, fileName);
      const size = fs.statSync(file).size;
      assert.ok(size > 0, 'nonempty Windows EXE ' + fileName);
      return { fileName, path: file, size, sha256: sha256(file) };
    });
    fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), report.artifacts.map((item) => item.sha256 + '  ' + item.fileName).join('\n') + '\n');
    const productionExe = path.join(output, 'win-unpacked', 'Mouse Click.exe');
    assert.ok(fs.statSync(productionExe).size > 0, 'real unpacked production EXE');
    report.production = { executable: productionExe, asar: inspectAsar(path.join(output, 'win-unpacked', 'resources', 'app.asar')) };
    report.installPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mouse-click-install-')), 'application');
    report.installer = await runInstaller(report.artifacts[0].path, report.installPath, path.join(results, 'installer.log'));
    const installedExe = path.join(report.installPath, 'Mouse Click.exe');
    const installedAsar = path.join(report.installPath, 'resources', 'app.asar');
    for (let attempt = 0; attempt < 100 && (!fs.existsSync(installedExe) || !fs.existsSync(installedAsar)); attempt++) await sleep(100);
    assert.ok(fs.statSync(installedExe).size > 0, 'silent installation created the real EXE');
    report.installed = { executable: installedExe, asar: inspectAsar(installedAsar) };
    assert.equal(report.installed.asar.sha256, report.production.asar.sha256, 'installation preserves production ASAR bytes');
    report.status = 'PASS';
    console.log('WINDOWS_PACKAGE_CHECKS_PASS ' + names.join(', '));
  } catch (error) {
    report.status = 'FAIL';
    report.reason = error.stack || String(error);
    console.error(report.reason);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  }
}

module.exports = { inspectAsar, sha256 };
if (require.main === module) main();
