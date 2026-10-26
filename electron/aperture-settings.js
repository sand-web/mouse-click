const fs = require('node:fs');
const path = require('node:path');

function requireFinite(value) {
  if (!Number.isFinite(value)) throw new TypeError('Radius and delta must be finite numbers');
}

function normalizeRadius(value) {
  requireFinite(value);
  return Math.min(300, Math.max(20, value));
}

function adjustRadius(current, delta) {
  requireFinite(current);
  requireFinite(delta);
  return Math.min(300, Math.max(20, current + delta));
}

function createApertureSettings(filePath) {
  let radius = 100;
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')).radius;
    if (Number.isFinite(stored) && stored >= 20 && stored <= 300) radius = stored;
  } catch {
    // Missing, unreadable, and corrupt settings keep the default without writing.
  }

  function set(value) {
    try {
      const next = normalizeRadius(value);
      radius = next;
    } catch (error) {
      return { radius, saved: false, error };
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = filePath + '.tmp';
      fs.writeFileSync(temporaryPath, JSON.stringify({ radius }));
      fs.renameSync(temporaryPath, filePath);
      return { radius, saved: true, error: null };
    } catch (error) {
      return { radius, saved: false, error };
    }
  }

  function adjust(delta) {
    try {
      return set(adjustRadius(radius, delta));
    } catch (error) {
      return { radius, saved: false, error };
    }
  }

  return { get: () => radius, set, adjust };
}

module.exports = { normalizeRadius, adjustRadius, createApertureSettings };
