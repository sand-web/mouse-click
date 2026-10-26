const { build, Platform, Arch } = require('electron-builder');
const testPackage = process.argv.includes('--test-package');

if (process.platform !== 'win32') {
  console.error('Build Windows artifacts on Windows (the GitHub workflow provides this environment).');
  process.exit(1);
}

build({
  targets: Platform.WINDOWS.createTarget(testPackage ? 'dir' : ['nsis', 'portable'], Arch.x64),
  publish: 'never',
  config: {
    appId: 'io.github.sand-web.mouse-click',
    directories: { output: testPackage ? 'app_output/windows-test' : 'app_output' },
    extraMetadata: {
      name: 'mouse-click',
      productName: 'Mouse Click',
      ...(testPackage ? { main: 'tests/e2e/app.cjs' } : {}),
    },
    files: ['dist/**/*', 'electron/**/*', 'package.json', 'LICENSE', ...(testPackage ? ['tests/e2e/app.cjs'] : [])],
    npmRebuild: false,
    win: { requestedExecutionLevel: 'asInvoker' },
    nsis: {
      artifactName: 'Mouse-Click-${version}-${arch}-Setup.${ext}',
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      runAfterFinish: false,
    },
    portable: { artifactName: 'Mouse-Click-${version}-${arch}-Portable.${ext}' },
  },
}).catch((error) => { console.error(error); process.exitCode = 1; });
