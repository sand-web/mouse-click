const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fc = require('fast-check');
const { createApertureSettings } = require('../../electron/aperture-settings');

// Fixtures stay inside this task's temporary directory for inspection; no deletion.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mouse-click-wi1-'));
let fixtureNumber = 0;
function fixture() {
  const directory = path.join(fixtureRoot, String(++fixtureNumber));
  fs.mkdirSync(directory);
  return path.join(directory, 'settings.json');
}
const read = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const clamp = (value) => Math.min(300, Math.max(20, value));
const success = (radius) => ({ radius, saved: true, error: null });
const invalid = [undefined, null, true, '137', '', [], {}, NaN, Infinity, -Infinity];

test('I1: missing settings default to 100 without writing, and first save round-trips', () => {
  const filePath = path.join(path.dirname(fixture()), 'nested', 'settings.json');
  const settings = createApertureSettings(filePath);
  assert.equal(settings.get(), 100);
  assert.equal(fs.existsSync(path.dirname(filePath)), false);
  assert.deepEqual(settings.set(137.125), success(137.125));
  assert.deepEqual(read(filePath), { radius: 137.125 });
  assert.equal(settings.get(), 137.125);
  assert.equal(createApertureSettings(filePath).get(), 137.125);
  assert.equal(fs.existsSync(filePath + '.tmp'), false);
});

test('I2: corrupt, invalid, and unreadable settings default without modifying original data', () => {
  for (const content of ['', '{broken', 'null', '[]', '"137"', '{}', '{"radius":"137"}', '{"radius":null}', '{"radius":19}', '{"radius":301}', '{"radius":1e309}']) {
    const filePath = fixture();
    fs.writeFileSync(filePath, content);
    const before = fs.readFileSync(filePath);
    assert.equal(createApertureSettings(filePath).get(), 100);
    assert.deepEqual(fs.readFileSync(filePath), before);
    assert.equal(fs.existsSync(filePath + '.tmp'), false);
  }
  const directoryPath = fixture();
  fs.mkdirSync(directoryPath);
  assert.equal(createApertureSettings(directoryPath).get(), 100);
  assert.ok(fs.statSync(directoryPath).isDirectory());
  assert.deepEqual(fs.readdirSync(directoryPath), []);
  for (const radius of [20, 300]) {
    const filePath = fixture();
    fs.writeFileSync(filePath, JSON.stringify({ radius }));
    const before = fs.readFileSync(filePath);
    assert.equal(createApertureSettings(filePath).get(), radius);
    assert.deepEqual(fs.readFileSync(filePath), before);
  }
});

test('I3: generated set/adjust sequences agree with the model at every real-file transition', () => {
  const operation = fc.oneof(
    fc.record({ kind: fc.constant('set'), value: fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }) }),
    fc.record({ kind: fc.constant('adjust'), value: fc.integer({ min: -800, max: 800 }).map((n) => n / 4) }),
  );
  fc.assert(fc.property(fc.array(operation, { minLength: 1, maxLength: 30 }), (operations) => {
    const filePath = fixture();
    const settings = createApertureSettings(filePath);
    let model = 100;
    assert.equal(settings.get(), model);
    for (const operation of operations) {
      model = clamp(operation.kind === 'set' ? operation.value : model + operation.value);
      assert.deepEqual(settings[operation.kind](operation.value), success(model));
      assert.equal(settings.get(), model);
      assert.deepEqual(read(filePath), { radius: model });
      assert.equal(createApertureSettings(filePath).get(), model);
      assert.deepEqual(settings.set(model), success(model));
      assert.equal(createApertureSettings(filePath).get(), model);
    }
  }), { numRuns: 35, seed: 20261025 });
  fc.assert(fc.property(fc.double({ min: 20, max: 300, noNaN: true, noDefaultInfinity: true }), (radius) => {
    const filePath = fixture();
    assert.deepEqual(createApertureSettings(filePath).set(radius), success(radius));
    assert.equal(createApertureSettings(filePath).get(), radius);
    assert.deepEqual(read(filePath), { radius });
  }), { numRuns: 35, seed: 20261025 });
});

test('I4: invalid runtime updates preserve both current state and exact disk bytes', () => {
  const filePath = fixture();
  const settings = createApertureSettings(filePath);
  assert.deepEqual(settings.set(137.125), success(137.125));
  const before = fs.readFileSync(filePath);
  for (const value of invalid) {
    for (const method of ['set', 'adjust']) {
      const result = settings[method](value);
      assert.equal(result.radius, 137.125);
      assert.equal(result.saved, false);
      assert.ok(result.error instanceof TypeError);
      assert.equal(settings.get(), 137.125);
      assert.equal(createApertureSettings(filePath).get(), 137.125);
      assert.deepEqual(fs.readFileSync(filePath), before);
      assert.equal(fs.existsSync(filePath + '.tmp'), false);
    }
  }
});

test('I5: failed temporary writes preserve the last saved file while live state continues', () => {
  const filePath = fixture();
  const settings = createApertureSettings(filePath);
  assert.deepEqual(settings.set(137), success(137));
  const before = fs.readFileSync(filePath);
  fs.mkdirSync(filePath + '.tmp');
  for (const [method, value, expected] of [['set', 180, 180], ['adjust', 0.25, 180.25]]) {
    const result = settings[method](value);
    assert.equal(result.radius, expected);
    assert.equal(result.saved, false);
    assert.ok(result.error instanceof Error);
    assert.equal(settings.get(), expected);
    assert.equal(createApertureSettings(filePath).get(), 137);
    assert.deepEqual(fs.readFileSync(filePath), before);
    assert.ok(fs.statSync(filePath + '.tmp').isDirectory());
  }
  fs.renameSync(filePath + '.tmp', filePath + '.tmp-archived');
  assert.deepEqual(settings.set(181), success(181));
  assert.equal(createApertureSettings(filePath).get(), 181);
  assert.deepEqual(read(filePath), { radius: 181 });
});

test('I6: parent creation and rename errors return errors and preserve existing objects', () => {
  const occupiedParent = fixture();
  fs.writeFileSync(occupiedParent, 'parent sentinel');
  const filePathA = path.join(occupiedParent, 'settings.json');
  const settingsA = createApertureSettings(filePathA);
  assert.equal(settingsA.get(), 100);
  const resultA = settingsA.set(180);
  assert.equal(resultA.radius, 180);
  assert.equal(resultA.saved, false);
  assert.ok(resultA.error instanceof Error);
  assert.equal(settingsA.get(), 180);
  assert.equal(fs.readFileSync(occupiedParent, 'utf8'), 'parent sentinel');

  const filePathB = fixture();
  fs.mkdirSync(filePathB);
  const sentinel = path.join(filePathB, 'sentinel');
  fs.writeFileSync(sentinel, 'rename sentinel');
  const settingsB = createApertureSettings(filePathB);
  assert.equal(settingsB.get(), 100);
  const resultB = settingsB.set(180);
  assert.equal(resultB.radius, 180);
  assert.equal(resultB.saved, false);
  assert.ok(resultB.error instanceof Error);
  assert.equal(settingsB.get(), 180);
  assert.ok(fs.statSync(filePathB).isDirectory());
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'rename sentinel');
});

test('I7: retrying the same live value after a failed save persists it successfully', () => {
  const filePath = fixture();
  const settings = createApertureSettings(filePath);
  assert.deepEqual(settings.set(137), success(137));
  fs.mkdirSync(filePath + '.tmp');
  for (const [method, value, expected] of [['set', 180, 180], ['adjust', 0.25, 180.25]]) {
    const result = settings[method](value);
    assert.equal(result.radius, expected);
    assert.equal(result.saved, false);
    assert.ok(result.error instanceof Error);
  }
  assert.equal(createApertureSettings(filePath).get(), 137);
  fs.renameSync(filePath + '.tmp', filePath + '.tmp-archived');
  assert.deepEqual(settings.set(180.25), success(180.25));
  assert.equal(settings.get(), 180.25);
  assert.equal(createApertureSettings(filePath).get(), 180.25);
  assert.deepEqual(read(filePath), { radius: 180.25 });
  assert.equal(fs.existsSync(filePath + '.tmp'), false);
});
