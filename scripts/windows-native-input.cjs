// CI-only global input driver. A successful SendInput call is not a routing oracle:
// callers must also assert the real reader state and positive/negative controls.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function fail(code, message, evidence) {
  const error = new Error(message);
  error.code = code;
  if (evidence) error.evidence = evidence;
  throw error;
}

function runInput(action, outputDir, prefix = 'input') {
  if (process.platform !== 'win32' || process.arch !== 'x64' ||
      process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    fail('ENVIRONMENT_NATIVE_INPUT_GUARD', 'Native input requires a disposable GitHub-hosted Windows x64 runner');
  }
  const kinds = ['move', 'click', 'wheel', 'drag', 'type', 'key', 'probe'];
  if (!action || typeof action !== 'object' || Array.isArray(action) || !kinds.includes(action.kind)) {
    fail('NATIVE_INPUT_INVALID_ARGUMENT', 'Unknown native input action');
  }
  if (!path.isAbsolute(outputDir) || !/^[a-zA-Z0-9_-]+$/.test(prefix)) {
    fail('NATIVE_INPUT_INVALID_ARGUMENT', 'An absolute evidence directory and simple prefix are required');
  }
  const payload = { kind: action.kind };
  for (const field of ['x', 'y', ...(action.kind === 'drag' ? ['x2', 'y2'] : [])]) {
    if (!['move', 'click', 'wheel', 'drag'].includes(action.kind)) break;
    if (!Number.isInteger(action[field]) || action[field] < -2147483648 || action[field] > 2147483647) {
      fail('NATIVE_INPUT_INVALID_ARGUMENT', field + ' must be an Int32 integer');
    }
    payload[field] = action[field];
  }
  if (action.kind === 'wheel') {
    if (!Number.isInteger(action.delta) || Math.abs(action.delta) > 120000) {
      fail('NATIVE_INPUT_INVALID_ARGUMENT', 'Wheel delta must be an integer within 120000');
    }
    payload.delta = action.delta;
  }
  if (action.kind === 'type') {
    if (typeof action.text !== 'string' || action.text.length > 512) {
      fail('NATIVE_INPUT_INVALID_ARGUMENT', 'Input text must be a string of at most 512 UTF-16 units');
    }
    payload.text = action.text;
  }
  if (action.kind === 'key') {
    if (!['AltX', 'CtrlA', 'Home', 'ControlHome', 'Escape', 'Enter', 'Tab', 'Backspace'].includes(action.key)) {
      fail('NATIVE_INPUT_INVALID_ARGUMENT', 'Unknown key sequence');
    }
    payload.key = action.key;
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const stem = prefix + '-' + randomUUID();
  const inputFile = path.join(outputDir, stem + '.input.json');
  const resultFile = path.join(outputDir, stem + '.result.json');
  fs.writeFileSync(inputFile, JSON.stringify(payload), { flag: 'wx' });
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let result;
  try {
    const stdout = execFileSync(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'windows-native-input.ps1'), '-InputFile', inputFile,
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
    result = JSON.parse(stdout.trim());
  } catch (error) {
    let diagnostic;
    try { diagnostic = JSON.parse(String(error.stdout || '').trim()); } catch {}
    const evidence = {
      status: 'FAIL', inputFile, resultFile, action: payload,
      driver: diagnostic || null, exitCode: error.status ?? null,
      error: error.message, stderr: String(error.stderr || ''),
    };
    fs.writeFileSync(resultFile, JSON.stringify(evidence, null, 2), { flag: 'wx' });
    fail(diagnostic?.code || 'ENVIRONMENT_NATIVE_INPUT_DRIVER', 'Global native input failed: ' + (diagnostic?.error || error.message), evidence);
  }
  result.inputFile = inputFile;
  result.resultFile = resultFile;
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), { flag: 'wx' });
  if (result.status !== 'PASS' || result.sent !== result.expected) {
    fail(result.code || 'ENVIRONMENT_SENDINPUT_FAILED', 'Input packets were not fully inserted', result);
  }
  return result;
}

module.exports = { runInput };
