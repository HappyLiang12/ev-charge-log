import test from 'node:test';
import assert from 'node:assert/strict';
import { startSnapshotPolling } from '../snapshot.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(visibility = 'visible') {
  const intervals = [];
  const listeners = new Map();
  const doc = {
    visibilityState: visibility,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { listeners.delete(type); },
  };
  const timerApi = {
    setInterval(fn, ms) {
      intervals.push({ fn, ms, cleared: false });
      return intervals.length;
    },
    clearInterval(id) {
      const entry = intervals[id - 1];
      if (entry) entry.cleared = true;
    },
  };
  return { doc, timerApi, intervals, listeners };
}

test('snapshot polling fetches immediately and every interval', async () => {
  const h = harness();
  const updates = [];
  let calls = 0;
  const poll = startSnapshotPolling({
    apiUrl: 'https://example.test/api',
    fetchLatest: async () => ({ id: `snap-${++calls}` }),
    onSnapshot: (snapshot) => updates.push(snapshot),
    onError: () => {},
    timerApi: h.timerApi,
    doc: h.doc,
  });
  await flush();
  assert.equal(calls, 1);
  assert.equal(updates[0].id, 'snap-1');
  assert.equal(h.intervals[0].ms, 60000);
  h.intervals[0].fn();
  await flush();
  assert.equal(calls, 2);
  assert.equal(updates[1].id, 'snap-2');
  poll.stop();
});

test('snapshot polling skips hidden tabs and refreshes when visible', async () => {
  const h = harness('hidden');
  let calls = 0;
  const poll = startSnapshotPolling({
    apiUrl: 'https://example.test/api',
    fetchLatest: async () => ({ id: `snap-${++calls}` }),
    onSnapshot: () => {},
    onError: () => {},
    timerApi: h.timerApi,
    doc: h.doc,
  });
  await flush();
  assert.equal(calls, 0);
  h.intervals[0].fn();
  await flush();
  assert.equal(calls, 0);
  h.doc.visibilityState = 'visible';
  h.listeners.get('visibilitychange')();
  await flush();
  assert.equal(calls, 1);
  poll.stop();
});

test('snapshot polling reports errors without emitting a snapshot', async () => {
  const h = harness();
  const updates = [];
  const errors = [];
  const poll = startSnapshotPolling({
    apiUrl: 'https://example.test/api',
    fetchLatest: async () => { throw new Error('offline'); },
    onSnapshot: (snapshot) => updates.push(snapshot),
    onError: (error) => errors.push(error.message),
    timerApi: h.timerApi,
    doc: h.doc,
  });
  await flush();
  assert.equal(updates.length, 0);
  assert.deepEqual(errors, ['offline']);
  poll.stop();
});

test('stopping snapshot polling clears the interval and visibility listener', async () => {
  const h = harness();
  let calls = 0;
  const poll = startSnapshotPolling({
    apiUrl: 'https://example.test/api',
    fetchLatest: async () => ({ id: `snap-${++calls}` }),
    onSnapshot: () => {},
    onError: () => {},
    timerApi: h.timerApi,
    doc: h.doc,
  });
  await flush();
  poll.stop();
  assert.equal(h.intervals[0].cleared, true);
  assert.equal(h.listeners.size, 0);
  h.intervals[0].fn();
  await flush();
  assert.equal(calls, 1);
});
