import assert from 'node:assert/strict';
import test from 'node:test';
import { transformPoint } from '../src/pdf/pageCoordinates';

test('source hit coordinates preserve rotation, scaling, and translation', () => {
  assert.deepEqual(transformPoint([13, 19], [0, 2, -2, 0, 800, -7]), [762, 19]);
});

test('source hit coordinates preserve shears and nonzero translation', () => {
  assert.deepEqual(transformPoint([13, 19], [2, 0.5, -0.25, 3, 17, -29]), [38.25, 34.5]);
});
