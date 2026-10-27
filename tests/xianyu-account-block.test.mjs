import test from 'node:test';
import assert from 'node:assert/strict';
import { xianyuAccountBlockActive } from '../scripts/xianyu-account-block.mjs';

const block = JSON.stringify({ at: '2026-10-28T10:00:00.000Z', reason: 'verificación' });

test('without a block the account can be used', () => {
  assert.equal(xianyuAccountBlockActive(null), false);
  assert.equal(xianyuAccountBlockActive(''), false);
  assert.equal(xianyuAccountBlockActive('not json'), false);
});

test('a block stays active until an unblock date after it', () => {
  assert.equal(xianyuAccountBlockActive(block), true);
  assert.equal(xianyuAccountBlockActive(block, ''), true);
  assert.equal(xianyuAccountBlockActive(block, 'cualquier cosa'), true);
  assert.equal(xianyuAccountBlockActive(block, '2026-10-27T10:00:00Z'), true);
  assert.equal(xianyuAccountBlockActive(block, '2026-10-28T12:00:00Z'), false);
});

test('a new block after an old unblock is active again', () => {
  const later = JSON.stringify({ at: '2026-11-02T08:00:00.000Z' });
  assert.equal(xianyuAccountBlockActive(later, '2026-10-28T12:00:00Z'), true);
});
