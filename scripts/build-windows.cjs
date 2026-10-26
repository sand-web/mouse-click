const { build, Platform, Arch } = require('electron-builder');
const testPackage = process.argv.includes('--test-package');
const readerFixture = process.argv.includes('--reader-fixture');
if (testPackage && readerFixture) throw new Error('Choose one disposable test package');

if (process.platform !== 'win32') {
  console.error('Build Windows artifacts on Windows (the GitHub workflow provides this environment).');
  process.exit(1);
}

build({
  targets: Platform.WINDOWS.createTarget(testPackage || readerFixture ? 'dir' : ['nsis', 'portable'], Arch.x64),
  publish: 'never',
  config: {
    appId: readerFixture ? 'io.github.sand-web.mouse-click.reader-fixture' : 'io.github.sand-web.mouse-click',
    ...(readerFixture ? { productName: 'Mouse Click Reading Fixture' } : {}),
    directories: { output: readerFixture ? 'app_output/windows-reader' : testPackage ? 'app_output/windows-test' : 'app_output' },
    extraMetadata: {
      name: readerFixture ? 'mouse-click-reader-fixture' : 'mouse-click',
      productName: readerFixture ? 'Mouse Click Reading Fixture' : 'Mouse Click',
      ...(testPackage ? { main: 'tests/e2e/app.cjs' } : {}),
      ...(readerFixture ? { main: 'tests/e2e/windows-reader.cjs' } : {}),
    },
    files: readerFixture
      ? ['tests/e2e/windows-reader.cjs', 'tests/e2e/windows-reader.html', 'package.json', 'LICENSE']
      : ['dist/**/*', 'electron/**/*', 'package.json', 'LICENSE', ...(testPackage ? ['tests/e2e/app.cjs'] : [])],
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
