import test from 'node:test';
import assert from 'node:assert/strict';
import { cropGeometry } from '../../web/src/supplier/photo-processing.mjs';

test('landscape crop keeps 4:3 and bounds a large phone photo to 1600 pixels', () => {
  const result = cropGeometry(4032, 3024, { x: 400, y: 200, width: 3200, height: 2400 });
  assert.deepEqual([result.outputWidth, result.outputHeight], [1600, 1200]);
  assert.equal(result.scale, .5);
  assert.deepEqual([result.x, result.y], [400, 200]);
});

test('square crop from a portrait shot does not enlarge small selections', () => {
  const result = cropGeometry(1200, 2400, { x: 100, y: 800, width: 700, height: 700 });
  assert.deepEqual([result.outputWidth, result.outputHeight, result.scale], [700, 700, 1]);
});

test('quarter turns use rotated bounds and retain their direction', () => {
  for (const [angle, radians] of [[90, Math.PI / 2], [270, 3 * Math.PI / 2], [-90, 3 * Math.PI / 2]]) {
    const result = cropGeometry(1200, 2400, { x: 800, y: 100, width: 1600, height: 1200 }, angle);
    assert.deepEqual([result.rotatedWidth, result.rotatedHeight], [2400, 1200]);
    assert.deepEqual([result.outputWidth, result.outputHeight], [1600, 1100]);
    assert.equal(result.radians, radians);
  }
  const halfTurn = cropGeometry(1200, 2400, { x: 0, y: 0, width: 1200, height: 2400 }, 180);
  assert.deepEqual([halfTurn.outputWidth, halfTurn.outputHeight], [800, 1600]);
  assert.equal(halfTurn.radians, Math.PI);
});

test('rounding at photo edges never reads outside the image', () => {
  const result = cropGeometry(2000, 1500, { x: -.01, y: -.01, width: 2000.1, height: 1500.1 });
  assert.deepEqual([result.x, result.y, result.outputWidth, result.outputHeight], [0, 0, 1600, 1200]);
  const corner = cropGeometry(2000, 1500, { x: 1999.9, y: 1499.9, width: 50, height: 50 });
  assert.deepEqual([corner.outputWidth, corner.outputHeight], [1, 1]);
});

test('empty, non-finite and unsupported geometry cannot produce a blank upload', () => {
  for (const area of [null, { x: 0, y: 0, width: 0, height: 100 }, { x: NaN, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: Infinity, height: 100 }]) {
    assert.throws(() => cropGeometry(2000, 1500, area));
  }
  assert.throws(() => cropGeometry(0, 100, { x: 0, y: 0, width: 100, height: 100 }));
  assert.throws(() => cropGeometry(2000, 1500, { x: 0, y: 0, width: 100, height: 100 }, 45));
});
