const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(process.argv[2]);
const expected = 'Mouse Click';
function check(bundle, main = false) {
  const contents = path.join(bundle, 'Contents');
  const info = JSON.parse(execFileSync('plutil', [
    '-convert', 'json', '-o', '-', path.join(contents, 'Info.plist'),
  ], { encoding: 'utf8' }));
  if (main) assert.equal(info.CFBundleName, expected);
  assert.ok(info.CFBundleExecutable.startsWith(expected));
  assert.ok(info.CFBundleDisplayName.startsWith(expected));
  const executable = path.join(contents, 'MacOS', info.CFBundleExecutable);
  fs.accessSync(executable, fs.constants.X_OK);
  return { bundle: path.basename(bundle), executable: info.CFBundleExecutable };
}
const checked = [check(root, true)];
const frameworks = path.join(root, 'Contents', 'Frameworks');
for (const file of fs.readdirSync(frameworks)) {
  if (file.endsWith('.app') && file.includes('Helper')) {
    checked.push(check(path.join(frameworks, file)));
  }
}
assert.ok(checked.length >= 5, 'main app and four Electron Helpers must exist');
console.log(JSON.stringify({ status: 'PASS', root, checked }, null, 2));
