function visionEngine_() {
  return String(configValue_('vision.engine') || 'plate').toLowerCase();
}

function normalizeOcrText_(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function matchPlate_(ocrText, plates) {
  var text = normalizeOcrText_(ocrText);
  var matches = [];
  for (var i = 0; i < plates.length; i += 1) {
    var plate = normalizePlate_(plates[i].plate);
    if (plate && text.indexOf(plate) !== -1) matches.push(plates[i]);
  }
  return matches.length === 1 ? matches[0] : null;
}

function cloudVisionText_(imageBase64) {
  var key = scriptProperty_('CLOUD_VISION_API_KEY');
  if (!key) throw new Error('Missing CLOUD_VISION_API_KEY');
  var response = UrlFetchApp.fetch(
    'https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(key),
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        requests: [{ image: { content: imageBase64 }, features: [{ type: 'TEXT_DETECTION', maxResults: 1 }] }],
      }),
      muteHttpExceptions: true,
    },
  );
  var status = response.getResponseCode();
  var body = response.getContentText();
  if (status === 429) throw new Error('rate_limited');
  if (status < 200 || status >= 300) throw new Error('Cloud Vision ' + status + ': ' + body);
  var parsed = JSON.parse(body);
  var annotation = parsed.responses && parsed.responses[0]
    && parsed.responses[0].textAnnotations && parsed.responses[0].textAnnotations[0];
  return annotation ? String(annotation.description || '') : '';
}

function plateIdentify_(imageBase64, plates) {
  try {
    var text = cloudVisionText_(imageBase64);
    var match = matchPlate_(text, plates);
    if (!match) return { engine: 'plate', car: '', confidence: 0, plate: '', status: 'unknown', reason: 'No unique plate match' };
    return { engine: 'plate', car: match.car, confidence: 1, plate: match.plate, status: 'matched', reason: 'Plate match' };
  } catch (error) {
    var message = String(error.message || error);
    return { engine: 'plate', car: '', confidence: 0, plate: '', status: message === 'rate_limited' ? 'rate_limited' : 'error', reason: message };
  }
}

function vlmIdentify_(imageBase64, cars, minConfidence) {
  try {
    var account = scriptProperty_('CLOUDFLARE_ACCOUNT_ID');
    var token = scriptProperty_('CLOUDFLARE_API_TOKEN');
    var model = String(configValue_('vision.vlmModel') || '');
    if (!account || !token || !model) throw new Error('VLM provider is not configured');
    var choices = cars.filter(function (car) { return car.active; }).map(function (car) {
      return car.id + ' = ' + (car.description || car.name);
    }).join('; ');
    var prompt = 'Identify the car parked in the charging slot. Choose exactly one: '
      + choices + '; guest = any other car; unknown = unclear. Only the car in the charging slot counts; ignore other parked cars. '
      + 'Return JSON only: {"carId":"<id>","confidence":0..1,"reason":"<short>"}';
    var response = UrlFetchApp.fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(account)
        + '/ai/run/' + model.split('/').map(encodeURIComponent).join('/'),
      {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ prompt: prompt, image: Utilities.base64Decode(imageBase64) }),
        muteHttpExceptions: true,
      },
    );
    var status = response.getResponseCode();
    var body = response.getContentText();
    if (status < 200 || status >= 300) throw new Error('VLM ' + status + ': ' + body);
    var parsed = JSON.parse(body);
    var text = parsed.result && parsed.result.response ? parsed.result.response : '';
    var data = JSON.parse(text);
    var carId = String(data.carId || '');
    var confidence = Number(data.confidence);
    var valid = cars.some(function (car) { return car.active && car.id === carId; });
    if (!valid || carId === 'guest' || carId === 'unknown' || !isFinite(confidence) || confidence < minConfidence) {
      return { engine: 'vlm', car: '', confidence: isFinite(confidence) ? confidence : 0, plate: '', status: 'unknown', reason: String(data.reason || 'not confident') };
    }
    return { engine: 'vlm', car: carId, confidence: confidence, plate: '', status: 'matched', reason: String(data.reason || '') };
  } catch (error) {
    return { engine: 'vlm', car: '', confidence: 0, plate: '', status: 'error', reason: String(error.message || error) };
  }
}

function selectCandidateSnapshots_(record, snapshots) {
  var config = readConfigMap_().values;
  var count = configInt_(config, 'snapshot.candidateCount', 3);
  var windowMs = configInt_(config, 'snapshot.windowMinutes', 10) * 60 * 1000;
  var target = Date.parse(record.teslaStartAt || record.startAt);
  return (snapshots || []).filter(function (snapshot) {
    var at = Date.parse(snapshot.capturedAt);
    return !isNaN(at) && Math.abs(at - target) <= windowMs;
  }).sort(function (a, b) {
    var delta = Math.abs(Date.parse(a.capturedAt) - target) - Math.abs(Date.parse(b.capturedAt) - target);
    return delta !== 0 ? delta : String(a.id).localeCompare(String(b.id));
  }).slice(0, count);
}

function policyAllowsSuggestion_(engine, car, lighting) {
  if (!car) return true;
  var config = readConfigMap_().values;
  var minSamples = configInt_(config, 'policy.minSamples', 5);
  var minPrecision = configNumber_(config, 'policy.minPrecision', 0.9, 0.5, 0.99);
  var rows = readFeedback_().filter(function (row) {
    return row.engine === engine && row.suggestedCar === car && row.lighting === lighting;
  });
  if (rows.length < minSamples) return true;
  var correct = rows.filter(function (row) { return row.chosenCar === car; }).length;
  return correct / rows.length >= minPrecision;
}

function identifySession_(record, force) {
  if (!record || record.car !== 'unassigned') return { status: 'unknown', reason: 'not unassigned' };
  var engineSetting = visionEngine_();
  if (engineSetting === 'off') return { status: 'unknown', reason: 'vision disabled' };
  var snapshots = readSnapshots_();
  var candidates = selectCandidateSnapshots_(record, snapshots);
  if (!candidates.length) {
    updateLog_(record.id, { suggestionStatus: 'unknown', identifiedAt: new Date().toISOString() });
    return { status: 'unknown', reason: 'no snapshot' };
  }
  var plates = readPlates_();
  var lighting = lightingFor_(record.teslaStartAt || record.startAt);
  var result = null;
  for (var i = 0; i < candidates.length; i += 1) {
    var image = readDriveImageBase64_(candidates[i].driveFileId);
    result = plateIdentify_(image, plates);
    if (result.status === 'matched') break;
    if (i <= 1 && engineSetting.indexOf('vlm') !== -1) {
      var cars = readCars_();
      var vlm = vlmIdentify_(image, cars, configNumber_(readConfigMap_().values, 'vision.minConfidence', 0.8, 0.5, 0.99));
      if (vlm.status === 'matched' && policyAllowsSuggestion_('vlm', vlm.car, lighting)) result = vlm;
    }
  }
  if (!result) result = { engine: '', car: '', confidence: 0, plate: '', status: 'unknown', reason: 'no match' };
  updateLog_(record.id, {
    evidenceUrl: candidates[0].driveUrl,
    suggestedCar: result.car,
    suggestionConfidence: result.confidence,
    suggestionPlate: result.plate,
    suggestionStatus: result.status,
    suggestionEngine: result.engine,
    suggestionSnapshotId: candidates[0].id,
    identifiedAt: new Date().toISOString(),
  });
  return result;
}

function identifyPending_() {
  if (visionEngine_() === 'off') return { identified: 0, unknown: 0, engine: 'off' };
  var max = configInt_(readConfigMap_().values, 'vision.maxPerSync', 5);
  var candidates = readLog_().filter(function (record) {
    return record.car === 'unassigned' && record.teslaKey
      && record.suggestionStatus !== 'matched' && record.suggestionStatus !== 'unknown';
  }).sort(function (a, b) { return Date.parse(b.startAt) - Date.parse(a.startAt); }).slice(0, max);
  var identified = 0;
  var unknown = 0;
  for (var i = 0; i < candidates.length; i += 1) {
    var result = identifySession_(candidates[i], false);
    if (result.status === 'matched') identified += 1;
    else unknown += 1;
  }
  return { identified: identified, unknown: unknown };
}
