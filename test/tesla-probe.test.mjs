import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectChargeSessions,
  findEnergySites,
  redactSensitive,
  summarizeSessionIdentifiers,
  writeRefreshTokenFile,
} from '../tools/tesla-probe.mjs';

test('findEnergySites finds nested sites and marks wall connector evidence', () => {
  const payload = {
    response: [
      { id: 1, vin: '5YJ3E111111111111' },
      {
        energy_site_id: 123,
        resource_type: 'wall_connector',
        site_name: 'Home',
        wall_connectors: [{ din: 'abc' }],
      },
    ],
  };

  const sites = findEnergySites(payload);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].energy_site_id, 123);
  assert.equal(sites[0].site_name, 'Home');
  assert.equal(sites[0].hasWallConnector, true);
});

test('findEnergySites handles a single response object without wall connectors', () => {
  const sites = findEnergySites({
    response: { energy_site_id: 42, resource_type: 'battery' },
  });

  assert.equal(sites.length, 1);
  assert.equal(sites[0].energy_site_id, 42);
  assert.equal(sites[0].hasWallConnector, false);
});

test('collectChargeSessions returns the nested session array', () => {
  const sessions = collectChargeSessions({
    response: {
      charge_history: {
        data: [
          { start_time: '2026-11-01T10:00:00Z', energy_wh: 1000 },
          { start_time: '2026-11-02T10:00:00Z', energy_wh: 2000 },
        ],
      },
    },
  });

  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].energy_wh, 2000);
});

test('collectChargeSessions ignores arrays that are not session-like', () => {
  const sessions = collectChargeSessions({
    response: [{ id: 1 }, { id: 2 }],
  });

  assert.deepEqual(sessions, []);
});

test('redactSensitive hides VIN, address, coordinates, and tokens without mutating input', () => {
  const input = {
    vin: '5YJ3E111111111111',
    address: '1 Main St',
    nested: {
      latitude: 22.3,
      energy_site_id: 123,
      access_token: 'secret',
    },
  };

  const output = redactSensitive(input);

  assert.equal(output.vin, '***1111');
  assert.equal(output.address, '[redacted]');
  assert.equal(output.nested.latitude, '[redacted]');
  assert.equal(output.nested.access_token, '[redacted]');
  assert.equal(output.nested.energy_site_id, 123);
  assert.equal(input.vin, '5YJ3E111111111111');
  assert.equal(input.nested.access_token, 'secret');
});

test('summarizeSessionIdentifiers groups sessions by target_id and din', () => {
  const summary = summarizeSessionIdentifiers([
    {
      target_id: { text: 'car-a' },
      din: 'charger-1',
      charge_start_time: { seconds: 300 },
      energy_added_wh: 3000,
    },
    {
      target_id: { text: 'car-b' },
      din: 'charger-1',
      charge_start_time: { seconds: 200 },
      energy_added_wh: 2000,
    },
    {
      target_id: { text: 'car-a' },
      din: 'charger-1',
      charge_start_time: { seconds: 100 },
      energy_added_wh: 1000,
    },
  ]);

  assert.equal(summary.sessionCount, 3);
  assert.deepEqual(summary.uniqueTargetIds, ['car-a', 'car-b']);
  assert.deepEqual(summary.uniqueDins, ['charger-1']);
  assert.equal(summary.groups.length, 2);

  const carA = summary.groups.find((group) => group.targetId === 'car-a');
  assert.equal(carA.count, 2);
  assert.equal(carA.firstStartSeconds, 100);
  assert.equal(carA.lastStartSeconds, 300);
  assert.equal(carA.totalEnergyWh, 4000);
});

test('writeRefreshTokenFile writes a 0600 file with a trailing newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tesla-refresh-'));
  const file = join(dir, '.tesla-refresh-token.local');
  try {
    writeRefreshTokenFile(file, 'refresh-token-value');
    assert.equal(readFileSync(file, 'utf8'), 'refresh-token-value\n');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
