import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyError } from '../ui.js';

test('friendlyError maps CLP failures to manual override before generic 403', () => {
  assert.match(friendlyError(new Error('CLP page parse failed'), 'fallback'), /manualOverride/);
  assert.match(
    friendlyError(new Error('CLP fetch failed (HTTP 403, reader 200)'), 'fallback'),
    /manualOverride/,
  );
});
