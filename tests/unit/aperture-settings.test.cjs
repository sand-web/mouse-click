const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { normalizeRadius, adjustRadius } = require('../../electron/aperture-settings');

const invalid = [undefined, null, true, '137', '', [], {}, NaN, Infinity, -Infinity];
const finite = fc.double({ noNaN: true, noDefaultInfinity: true });
const bounded = (min, max) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
const clamp = (value) => Math.min(300, Math.max(20, value));
const propertyOptions = { numRuns: 150, seed: 20261025 };

test('U1: normalize preserves decimals and saturates both boundaries', () => {
  for (const [input, expected] of [[20, 20], [300, 300], [100, 100], [19.5, 20], [301.25, 300], [137.125, 137.125], [-Number.MAX_VALUE, 20], [Number.MAX_VALUE, 300]]) {
    assert.equal(normalizeRadius(input), expected);
  }
});

test('U2: normalize rejects non-finite numbers and implicit conversions', () => {
  for (const value of invalid) assert.throws(() => normalizeRadius(value), TypeError);
});

test('U3: normalization obeys formula, idempotence, ordering, and in-range identity', () => {
  fc.assert(fc.property(finite, finite, bounded(20, 300), (a, b, inside) => {
    const result = normalizeRadius(a);
    assert.equal(result, clamp(a));
    assert.equal(normalizeRadius(result), result);
    assert.ok(normalizeRadius(Math.min(a, b)) <= normalizeRadius(Math.max(a, b)));
    assert.equal(normalizeRadius(inside), inside);
  }), propertyOptions);
});

test('U4: adjust preserves wheel direction, decimals, zero, and overflow saturation', () => {
  for (const [current, delta, expected] of [[100, 0.25, 100.25], [100, -0.25, 99.75], [137.125, 0, 137.125], [299.75, 1, 300], [20.25, -1, 20], [Number.MAX_VALUE, Number.MAX_VALUE, 300], [-Number.MAX_VALUE, -Number.MAX_VALUE, 20]]) {
    assert.equal(adjustRadius(current, delta), expected);
  }
});

test('U5: adjust validates both current and delta', () => {
  for (const value of invalid) {
    assert.throws(() => adjustRadius(value, 1), TypeError);
    assert.throws(() => adjustRadius(100, value), TypeError);
  }
});

test('U6: adjust follows addition, zero identity, ordering, and unsaturated inverse', () => {
  fc.assert(fc.property(bounded(20, 300), bounded(-1000, 1000), bounded(-1000, 1000), (current, a, b) => {
    assert.equal(adjustRadius(current, a), clamp(current + a));
    assert.equal(adjustRadius(current, 0), current);
    assert.ok(adjustRadius(current, Math.min(a, b)) <= adjustRadius(current, Math.max(a, b)));
  }), propertyOptions);
  fc.assert(fc.property(fc.integer({ min: 80, max: 240 }), fc.integer({ min: -160, max: 160 }), (quarterCurrent, quarterDelta) => {
    const current = quarterCurrent / 4;
    const delta = quarterDelta / 4;
    if (current + delta >= 20 && current + delta <= 300) {
      assert.equal(adjustRadius(adjustRadius(current, delta), -delta), current);
    }
  }), propertyOptions);
});

test('U7: adjust adds before clamping arbitrary finite current values', () => {
  assert.equal(adjustRadius(400, -200), 200);
  assert.equal(adjustRadius(-100, 200), 100);
  fc.assert(fc.property(finite, finite, (current, delta) => {
    assert.equal(adjustRadius(current, delta), clamp(current + delta));
  }), propertyOptions);
});
