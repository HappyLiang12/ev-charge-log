import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppsScriptEnv } from './fake-apps-script.mjs';

function setupVision({ props = {}, fetch, sheets = {} } = {}) {
  return createAppsScriptEnv({
    props: { CLOUD_VISION_API_KEY: 'key-1', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token', ...props },
    sheets: {
      Config: [
        ['key', 'value', 'updatedAt', 'notes'],
        ['vision.vlmModel', '@cf/test/vision-model', '', ''],
      ],
      ...sheets,
    },
    fetch,
  });
}

test('plate OCR returns the mapped car for a unique plate match', () => {
  const env = setupVision({
    fetch: (url) => {
      if (!url.includes('vision.googleapis.com')) throw new Error(`Unexpected URL: ${url}`);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
        responses: [{ textAnnotations: [{ description: 'AB 1234\nHONG KONG' }] }],
      }) };
    },
  });
  const result = env.call('plateIdentify_', 'base64', [
    { plate: 'AB1234', car: 'model3', active: true },
    { plate: 'CD5678', car: 'ix3', active: true },
  ]);
  assert.equal(result.status, 'matched');
  assert.equal(result.car, 'model3');
  assert.equal(result.engine, 'plate');
  assert.equal(result.confidence, 1);
});

test('VLM low confidence and guest become unknown', () => {
  const env = setupVision({
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({
      result: { response: '{"carId":"guest","confidence":0.99,"reason":"white mazda"}' },
    }) }),
  });
  const cars = [{ id: 'model3', name: 'Model 3', description: 'blue Tesla Model 3' }];
  const result = env.call('vlmIdentify_', 'base64', cars, 0.8);
  assert.equal(result.status, 'unknown');
  assert.equal(result.car, '');
});
