const { readdirSync, mkdirSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const lane = process.argv[2] || 'all';
const listOnly = process.argv.includes('--list');
const lanes = lane === 'all' ? ['unit', 'integration'] : [lane];
if (lanes.some((name) => !['unit', 'integration'].includes(name))) {
  throw new Error('Unknown test lane: ' + lane);
}
let failed = false;
for (const name of lanes) {
  const directory = resolve('tests', name);
  const files = existsSync(directory)
    ? readdirSync(directory).filter((file) => file.endsWith('.test.cjs')).sort()
    : [];
  if (listOnly) {
    console.log(JSON.stringify({ lane: name, testFiles: files, count: files.length }));
    continue;
  }
  if (!files.length) {
    console.error(name + ': no test files discovered');
    failed = true;
    continue;
  }
  const reports = resolve('coverage-' + name);
  mkdirSync(reports, { recursive: true });
  const result = spawnSync(process.execPath, [
    '--test', '--experimental-test-coverage',
    '--test-coverage-include=**/electron/aperture-settings.js',
    '--test-reporter=tap', '--test-reporter-destination=stdout',
    '--test-reporter=lcov',
    '--test-reporter-destination=' + join(reports, 'lcov.info'),
    ...files.map((file) => join(directory, file)),
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
