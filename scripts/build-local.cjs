// Optional offline runtime must be the same Electron version/architecture.
const path = require('node:path');
const { build, Platform, Arch } = require('electron-builder');
const e2e = process.argv.includes('--e2e');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : 'app_output';
const config = {
  directories: { output },
  files: ['dist/**/*', 'electron/**/*', 'package.json', 'LICENSE', ...(e2e ? ['tests/e2e/app.cjs'] : [])],
  mac: { identity: null },
  npmRebuild: false,
};
if (process.env.MOUSE_CLICK_ELECTRON_DIST) {
  config.electronDist = process.env.MOUSE_CLICK_ELECTRON_DIST;
  config.electronBranding = { productName: process.env.MOUSE_CLICK_RUNTIME_NAME || 'Electron' };
}
if (e2e) config.extraMetadata = { main: 'tests/e2e/app.cjs' };
build({
  projectDir: path.resolve(__dirname, '..'),
  targets: Platform.MAC.createTarget('dir', Arch.x64),
  config,
  publish: 'never',
}).catch((error) => { console.error(error); process.exitCode = 1; });
