import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppsScriptEnv } from './fake-apps-script.mjs';

function setupVision({ props = {}, fetch, sheets = {} } = {}) {
  return createAppsScriptEnv({
    props: { CLOUD_VISION_API_KEY: 'key-1', DEEPSEEK_API_KEY: 'key-1', ...props },
    sheets: {
      Config: [
        ['key', 'value', 'updatedAt', 'notes'],
        ['vision.vlmModel', 'deepseek-flash', '', ''],
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
      choices: [{ message: { content: '{"carId":"guest","confidence":0.99,"reason":"white mazda"}' } }],
    }) }),
  });
  const cars = [{ id: 'model3', name: 'Model 3', description: 'blue Tesla Model 3' }];
  const result = env.call('vlmIdentify_', 'base64', cars, 0.8, 'deepseek-flash');
  assert.equal(result.status, 'unknown');
  assert.equal(result.car, '');
});

test('VLM confidence above 1 is clamped to 1', () => {
  const env = setupVision({
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({
      choices: [{ message: { content: '{"carId":"model3","confidence":1.7,"reason":"clear"}' } }],
    }) }),
  });
  const cars = [{ id: 'model3', name: 'Model 3', active: true, description: 'blue Tesla Model 3' }];
  const result = env.call('vlmIdentify_', 'base64', cars, 0.8, 'deepseek-flash');
  assert.equal(result.status, 'matched');
  assert.equal(result.car, 'model3');
  assert.equal(result.confidence, 1);
});

test('VLM requires a model id passed from the locked config read', () => {
  const env = setupVision({
    fetch: () => { throw new Error('provider must not be called without a model'); },
  });
  const cars = [{ id: 'model3', name: 'Model 3', description: 'blue Tesla Model 3' }];
  const result = env.call('vlmIdentify_', 'base64', cars, 0.8, '');
  assert.equal(result.status, 'error');
  assert.match(result.reason, /not configured/);
});

test('buildVlmContent_ picks one reference per car by lighting and appends the query last', () => {
  const env = setupVision();
  const cars = [
    { id: 'ix3', name: 'iX3', active: true, description: 'champagne gold SUV' },
    { id: 'vigo', name: 'Vigo', active: true, description: 'silver SUV' },
  ];
  const photos = [
    { carId: 'ix3', fileId: 'ref-day', lighting: 'day', active: true, createdAt: '2026-11-21T10:00:00Z' },
    { carId: 'ix3', fileId: 'ref-night', lighting: 'night', active: true, createdAt: '2026-11-22T10:00:00Z' },
    { carId: 'ix3', fileId: 'ref-any', lighting: 'any', active: true, createdAt: '2026-11-20T10:00:00Z' },
    { carId: 'vigo', fileId: 'ref-vigo', lighting: 'any', active: true, createdAt: '2026-11-20T10:00:00Z' },
  ];
  const content = JSON.parse(JSON.stringify(env.call(
    'buildVlmContent_', cars, photos, 'query-b64', 'day', 'PROMPT', 3, (id) => `b64-${id}`,
  )));
  assert.deepEqual(content, [
    { type: 'text', text: 'Reference photo of ix3:' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,b64-ref-day', detail: 'original' } },
    { type: 'text', text: 'Reference photo of vigo:' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,b64-ref-vigo', detail: 'original' } },
    { type: 'text', text: 'PROMPT' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,query-b64', detail: 'original' } },
  ]);
});

test('buildVlmContent_ prefers the newest exact-lighting reference and caps total references', () => {
  const env = setupVision();
  const cars = [
    { id: 'ix3', name: 'iX3', active: true },
    { id: 'vigo', name: 'Vigo', active: true },
    { id: 'model3', name: 'Model 3', active: true },
  ];
  const photos = [
    { carId: 'ix3', fileId: 'ix3-old-day', lighting: 'day', active: true, createdAt: '2026-11-20T10:00:00Z' },
    { carId: 'ix3', fileId: 'ix3-new-day', lighting: 'day', active: true, createdAt: '2026-11-22T10:00:00Z' },
    { carId: 'ix3', fileId: 'ix3-night', lighting: 'night', active: true, createdAt: '2026-11-22T12:00:00Z' },
    { carId: 'vigo', fileId: 'vigo-day', lighting: 'day', active: true, createdAt: '2026-11-20T10:00:00Z' },
    { carId: 'model3', fileId: 'model3-day', lighting: 'day', active: true, createdAt: '2026-11-20T10:00:00Z' },
  ];
  const content = JSON.parse(JSON.stringify(env.call(
    'buildVlmContent_', cars, photos, 'query-b64', 'day', 'PROMPT', 2, (id) => `b64-${id}`,
  )));
  assert.equal(content.filter((part) => part.type === 'image_url').length, 3);
  assert.deepEqual(content.slice(0, 4), [
    { type: 'text', text: 'Reference photo of ix3:' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,b64-ix3-new-day', detail: 'original' } },
    { type: 'text', text: 'Reference photo of vigo:' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,b64-vigo-day', detail: 'original' } },
  ]);
});

test('buildVlmContent_ includes both parking directions per car', () => {
  const env = setupVision();
  const cars = [{ id: 'ix3', name: 'iX3', active: true }];
  const photos = [
    { carId: 'ix3', fileId: 'ref-front', lighting: 'night', view: 'front', active: true, createdAt: '2026-11-22T10:05:00Z' },
    { carId: 'ix3', fileId: 'ref-rear', lighting: 'night', view: 'rear', active: true, createdAt: '2026-11-21T10:00:00Z' },
  ];
  const content = JSON.parse(JSON.stringify(env.call(
    'buildVlmContent_', cars, photos, 'query', 'night', 'PROMPT', 6, (id) => `b64-${id}`,
  )));
  assert.deepEqual(content.slice(0, 4), [
    { type: 'text', text: 'Reference photo of ix3 (front):' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,b64-ref-front', detail: 'original' } },
    { type: 'text', text: 'Reference photo of ix3 (rear):' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,b64-ref-rear', detail: 'original' } },
  ]);
});

test('buildVlmContent_ returns null without usable reference photos', () => {
  const env = setupVision();
  const cars = [{ id: 'ix3', name: 'iX3', active: true }];
  assert.equal(env.call('buildVlmContent_', cars, [], 'query', 'day', 'PROMPT', 3, () => 'b64'), null);
  assert.equal(env.call('buildVlmContent_', cars, [
    { carId: 'ix3', fileId: 'ref', lighting: 'day', active: false, createdAt: '' },
  ], 'query', 'day', 'PROMPT', 3, () => 'b64'), null);
});

test('VLM few-shot sends reference images and reports usedReferences', () => {
  let payload = null;
  const env = setupVision({
    fetch: (url, options) => {
      payload = JSON.parse(options.payload);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
        choices: [{ message: { content: '{"carId":"ix3","confidence":0.99,"reason":"same wheels"}' } }],
      }) };
    },
  });
  const folder = env.context.DriveApp.createFolder('refs');
  const ref = folder.createFile(env.context.Utilities.newBlob([255, 216, 1], 'image/jpeg', 'ref.jpg'));
  const cars = [{ id: 'ix3', name: 'iX3', active: true, description: 'champagne gold SUV' }];
  const photos = [{ carId: 'ix3', fileId: ref.getId(), lighting: 'any', active: true, createdAt: '' }];
  const result = env.call('vlmIdentify_', 'query-b64', cars, 0.8, 'deepseek-flash', photos, 'day');
  assert.equal(result.status, 'matched');
  assert.equal(result.car, 'ix3');
  assert.equal(result.usedReferences, true);
  const content = payload.messages[0].content;
  assert.equal(content.filter((part) => part.type === 'image_url').length, 2);
  assert.match(content[0].text, /Reference photo of ix3/);
  assert.match(content[content.length - 1].image_url.url, /query-b64$/);
});

test('VLM falls back to the text prompt without reference photos', () => {
  let payload = null;
  const env = setupVision({
    fetch: (url, options) => {
      payload = JSON.parse(options.payload);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
        choices: [{ message: { content: '{"carId":"ix3","confidence":0.99,"reason":"clear"}' } }],
      }) };
    },
  });
  const cars = [{ id: 'ix3', name: 'iX3', active: true, description: 'champagne gold SUV' }];
  const result = env.call('vlmIdentify_', 'query-b64', cars, 0.8, 'deepseek-flash', [], 'day');
  assert.equal(result.usedReferences, false);
  assert.equal(payload.messages[0].content.filter((part) => part.type === 'image_url').length, 1);
});

function setupIdentify({ photos = true, plateText = '', carMatch = 'ix3' } = {}) {
  const startIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const fetch = (url) => {
    if (String(url).includes('vision.googleapis.com')) {
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          responses: [{ textAnnotations: plateText ? [{ description: plateText }] : [] }],
        }),
      };
    }
    if (String(url).includes('api.deepseek.com')) {
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ carId: carMatch, confidence: 0.99, reason: 'reference match' }) } }],
        }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const env = createAppsScriptEnv({
    props: { DEEPSEEK_API_KEY: 'key-1', CLOUD_VISION_API_KEY: 'key-1' },
    sheets: {
      Config: [
        ['key', 'value', 'updatedAt', 'notes'],
        ['vision.engine', 'plate+vlm', '', ''],
        ['vision.vlmModel', 'deepseek-flash', '', ''],
      ],
      Log: [
        ['id', 'startAt', 'car', 'kWh', 'durationSec', 'teslaStartAt', 'teslaEndAt', 'teslaKey', 'source'],
        ['rec-1', startIso, 'unassigned', 10, 3600, startIso, '', 'tesla-key-1', 'tesla'],
      ],
      Cars: [
        ['id', 'name', 'active', 'createdAt', 'peakFactor', 'description'],
        ['ix3', 'iX3', 'TRUE', '', 1, 'champagne gold SUV'],
        ['vigo', 'Vigo', 'TRUE', '', 1, 'silver SUV'],
      ],
      CarPhotos: [
        ['carId', 'fileId', 'lighting', 'active', 'createdAt'],
        ...(photos ? [['ix3', 'ref-placeholder', 'any', 'TRUE', '']] : []),
      ],
      Snapshots: [
        ['id', 'capturedAt', 'driveFileId', 'driveUrl', 'width', 'height', 'bytes', 'source', 'createdAt', 'crop'],
        ['snap-1', startIso, 'snap-placeholder', '', 960, 750, 10, 'pi', '', '0:550:960:750'],
      ],
      Plates: [
        ['plate', 'car', 'active', 'createdAt'],
        ['PL5422', 'vigo', 'TRUE', ''],
      ],
    },
    fetch,
  });
  const folder = env.context.DriveApp.createFolder('fixtures');
  const snapFile = folder.createFile(env.context.Utilities.newBlob([255, 216, 0], 'image/jpeg', 'snap.jpg'));
  env.spreadsheet.getSheetByName('Snapshots').getRange(2, 3).setValues([[snapFile.getId()]]);
  if (photos) {
    const refFile = folder.createFile(env.context.Utilities.newBlob([255, 216, 0], 'image/jpeg', 'ref.jpg'));
    env.spreadsheet.getSheetByName('CarPhotos').getRange(2, 2).setValues([[refFile.getId()]]);
  }
  return env;
}

test('identifySession_ auto-assigns a reference-photo match', () => {
  const env = setupIdentify();
  const result = env.call('identifySession_', { id: 'rec-1' }, false);
  assert.equal(result.status, 'matched');
  assert.equal(result.car, 'ix3');
  assert.equal(result.usedReferences, true);
  assert.equal(result.assigned, true);
  const rows = env.values('Log');
  const header = rows[0];
  const row = rows[1];
  assert.equal(row[header.indexOf('car')], 'ix3');
  assert.equal(row[header.indexOf('suggestedCar')], 'ix3');
  assert.deepEqual(env.values('Feedback').slice(1), []);
});

test('identifySession_ keeps a text-only match as a suggestion', () => {
  const env = setupIdentify({ photos: false });
  const result = env.call('identifySession_', { id: 'rec-1' }, false);
  assert.equal(result.status, 'matched');
  assert.equal(result.car, 'ix3');
  assert.equal(result.usedReferences, false);
  assert.ok(!result.assigned);
  const rows = env.values('Log');
  const header = rows[0];
  assert.equal(rows[1][header.indexOf('car')], 'unassigned');
  assert.equal(rows[1][header.indexOf('suggestedCar')], 'ix3');
});

test('identifySession_ auto-assigns a plate match', () => {
  const env = setupIdentify({ plateText: 'PL 5422', carMatch: 'ix3' });
  const result = env.call('identifySession_', { id: 'rec-1' }, false);
  assert.equal(result.status, 'matched');
  assert.equal(result.engine, 'plate');
  assert.equal(result.car, 'vigo');
  assert.equal(result.assigned, true);
  const rows = env.values('Log');
  const header = rows[0];
  assert.equal(rows[1][header.indexOf('car')], 'vigo');
});

test('addCarPhotoFromSnapshot_ copies the file outside the snapshots folder', () => {
  const env = setupIdentify();
  const result = env.call('addCarPhotoFromSnapshot_', 'ix3', 'snap-1', 'night', 'front');
  assert.equal(result.carId, 'ix3');
  assert.equal(result.lighting, 'night');
  assert.equal(result.view, 'front');
  assert.notEqual(result.fileId, '');
  const folder = env.driveFolders.find((item) => item.name === 'EV Charge References');
  assert.ok(folder);
  assert.equal(folder.files.length, 1);
  const rows = env.values('CarPhotos');
  const header = rows[0];
  const last = rows[rows.length - 1];
  assert.equal(last[header.indexOf('carId')], 'ix3');
  assert.equal(last[header.indexOf('fileId')], result.fileId);
  assert.equal(last[header.indexOf('lighting')], 'night');
  assert.equal(last[header.indexOf('view')], 'front');
});

test('addCarPhotoFromSnapshot_ rejects unknown cars', () => {
  const env = setupIdentify();
  assert.throws(() => env.call('addCarPhotoFromSnapshot_', 'guest', 'snap-1', 'day'), /Unknown car/);
});
