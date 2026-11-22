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

function selectCarPhotos_(photos, carId, lighting) {
  var mine = (photos || []).filter(function (photo) {
    return photo.carId === carId && photo.active !== false;
  });
  var byView = {};
  for (var i = 0; i < mine.length; i += 1) {
    var photo = mine[i];
    if (photo.lighting !== lighting && photo.lighting !== 'any') continue;
    var view = photo.view || 'any';
    var score = photo.lighting === lighting ? 2 : 1;
    var current = byView[view];
    if (!current || score > current.score
        || (score === current.score && String(photo.createdAt || '') > String(current.photo.createdAt || ''))) {
      byView[view] = { photo: photo, score: score };
    }
  }
  // One photo per view (front/rear/side), at most two per car, so either
  // parking direction can match.
  return Object.keys(byView).map(function (view) { return byView[view].photo; }).slice(0, 2);
}

// Reference photos are optional: when a car has no usable photo the caller
// falls back to the text-only prompt. At most one photo per car (newest photo
// matching the session lighting) keeps provider payloads and cost bounded.
function buildVlmContent_(cars, photos, queryBase64, lighting, prompt, maxRefs, readImage) {
  var load = readImage || readDriveImageBase64_;
  var cap = Math.max(0, maxRefs === undefined ? 6 : Number(maxRefs) || 0);
  var content = [];
  var used = 0;
  for (var i = 0; i < cars.length && used < cap; i += 1) {
    if (!cars[i] || !cars[i].active) continue;
    var picks = selectCarPhotos_(photos, cars[i].id, String(lighting || ''));
    for (var j = 0; j < picks.length && used < cap; j += 1) {
      var view = picks[j].view || 'any';
      var label = 'Reference photo of ' + cars[i].id + (view === 'any' ? '' : ' (' + view + ')') + ':';
      content.push({ type: 'text', text: label });
      content.push({
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,' + load(picks[j].fileId), detail: 'original' },
      });
      used += 1;
    }
  }
  if (!used) return null;
  content.push({ type: 'text', text: prompt });
  content.push({
    type: 'image_url',
    image_url: { url: 'data:image/jpeg;base64,' + queryBase64, detail: 'original' },
  });
  return content;
}

// The VLM model id is read under the script lock in prepareIdentify_ and passed
// in; this stage performs only provider calls and must not touch the Sheet.
function vlmIdentify_(imageBase64, cars, minConfidence, model, photos, lighting) {
  try {
    var key = scriptProperty_('DEEPSEEK_API_KEY');
    var modelId = String(model || '');
    if (!key || !modelId) throw new Error('DeepSeek vision is not configured');
    var choices = cars.filter(function (car) { return car.active; }).map(function (car) {
      return car.id + ' = ' + (car.description || car.name);
    }).join('; ');
    var prompt = 'Identify the car parked in the charging slot. Choose exactly one: '
      + choices + '; guest = any other car; unknown = unclear. Only the car in the charging slot counts; ignore other parked cars. '
      + 'Return JSON only: {"carId":"<id>","confidence":0..1,"reason":"<short>"}';
    var refPrompt = 'The images before the final one are reference photos of household cars; the final image is the charging slot. '
      + 'Compare the final image with the reference photos. ' + prompt;
    var content = buildVlmContent_(cars, photos || [], imageBase64, lighting || '', refPrompt);
    var usedReferences = Boolean(content);
    if (!content) {
      content = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageBase64, detail: 'original' } },
      ];
    }
    var response = UrlFetchApp.fetch('https://api.deepseek.com/chat/completions', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: content }],
        temperature: 0,
      }),
      muteHttpExceptions: true,
    });
    var status = response.getResponseCode();
    var body = response.getContentText();
    if (status < 200 || status >= 300) throw new Error('DeepSeek ' + status + ': ' + body);
    var parsed = JSON.parse(body);
    var content = parsed.choices && parsed.choices[0] && parsed.choices[0].message
      ? parsed.choices[0].message.content : '';
    if (!content) throw new Error('DeepSeek response missing content');
    var text = String(content).trim();
    if (text.indexOf('```') === 0) {
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    }
    var data = JSON.parse(text);
    var carId = String(data.carId || '');
    var confidence = Number(data.confidence);
    // A provider can return an out-of-range number; clamp it to the contract.
    if (isFinite(confidence)) confidence = Math.min(1, Math.max(0, confidence));
    var valid = cars.some(function (car) { return car.active && car.id === carId; });
    if (!valid || carId === 'guest' || carId === 'unknown' || !isFinite(confidence) || confidence < minConfidence) {
      return { engine: 'vlm', car: '', confidence: isFinite(confidence) ? confidence : 0, plate: '', status: 'unknown', reason: String(data.reason || 'not confident'), usedReferences: usedReferences };
    }
    return { engine: 'vlm', car: carId, confidence: confidence, plate: '', status: 'matched', reason: String(data.reason || ''), usedReferences: usedReferences };
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
  return policyAllowsRows_(
    readFeedback_(),
    configInt_(config, 'policy.minSamples', 5),
    configNumber_(config, 'policy.minPrecision', 0.9, 0.5, 0.99),
    engine,
    car,
    lighting,
  );
}

function policyAllowsRows_(rows, minSamples, minPrecision, engine, car, lighting) {
  if (!car) return true;
  var scoped = (rows || []).filter(function (row) {
    return row.engine === engine && row.suggestedCar === car && row.lighting === lighting;
  });
  if (scoped.length < minSamples) return true;
  var correct = scoped.filter(function (row) { return row.chosenCar === car; }).length;
  return correct / scoped.length >= minPrecision;
}

// Sheet reads and header migration run under the script lock; Drive, Vision,
// and VLM calls stay outside it. The final write takes a second short lock and
// re-checks the record so a concurrent assign or identify wins.
function prepareIdentify_(recordId, force) {
  var record = findRecord_(readLog_(), recordId);
  if (!record) throw new Error('Unknown record');
  if (record.car !== 'unassigned') {
    return { result: { engine: '', car: '', confidence: 0, plate: '', status: 'unknown', snapshotId: '', reason: 'not unassigned' } };
  }
  if (!force && (record.suggestionStatus === 'matched' || record.suggestionStatus === 'unknown')) {
    return {
      result: {
        engine: record.suggestionEngine || '',
        car: record.suggestedCar || '',
        confidence: record.suggestionConfidence || 0,
        plate: record.suggestionPlate || '',
        status: record.suggestionStatus,
        snapshotId: record.suggestionSnapshotId || '',
        reason: 'skipped',
      },
    };
  }
  var engineSetting = visionEngine_();
  if (engineSetting === 'off') {
    return { result: { engine: '', car: '', confidence: 0, plate: '', status: 'unknown', snapshotId: '', reason: 'vision disabled' } };
  }
  var candidates = selectCandidateSnapshots_(record, readSnapshots_());
  if (!candidates.length) {
    updateLog_(record.id, { suggestionStatus: 'unknown', identifiedAt: new Date().toISOString() });
    return { result: { engine: '', car: '', confidence: 0, plate: '', status: 'unknown', snapshotId: '', reason: 'no snapshot' } };
  }
  var config = readConfigMap_().values;
  var vlmEnabled = engineSetting.indexOf('vlm') !== -1;
  return {
    candidates: candidates,
    plates: readPlates_(),
    lighting: lightingFor_(record.teslaStartAt || record.startAt),
    vlm: vlmEnabled ? {
      cars: readCars_(),
      photos: readCarPhotos_(),
      minConfidence: configNumber_(config, 'vision.minConfidence', 0.8, 0.5, 0.99),
      model: String(configRaw_(config, 'vision.vlmModel', '') || ''),
    } : null,
    feedback: vlmEnabled ? readFeedback_() : [],
    policy: {
      minSamples: configInt_(config, 'policy.minSamples', 5),
      minPrecision: configNumber_(config, 'policy.minPrecision', 0.9, 0.5, 0.99),
    },
  };
}

function identifySession_(record, force) {
  if (!record || !record.id) {
    return { engine: '', car: '', confidence: 0, plate: '', status: 'unknown', snapshotId: '', reason: 'not unassigned' };
  }
  var recordId = String(record.id);
  var plan = withScriptLock_(function () { return prepareIdentify_(recordId, force); });
  if (plan.result) return plan.result;
  var candidates = plan.candidates;
  var result = null;
  var resultIndex = -1;
  var vlmError = '';
  var readError = '';
  for (var i = 0; i < candidates.length; i += 1) {
    // A matched result is final; later candidates never overwrite it.
    if (result && result.status === 'matched') break;
    var image;
    try {
      image = readDriveImageBase64_(candidates[i].driveFileId);
    } catch (error) {
      readError = String(error.message || error);
      continue;
    }
    var plate = plateIdentify_(image, plan.plates);
    if (plate.status === 'matched') {
      result = plate;
      resultIndex = i;
      break;
    }
    // Keep the nearest unknown, but let a provider error win over it.
    if (!result || plate.status === 'error' || plate.status === 'rate_limited') {
      result = plate;
      resultIndex = i;
    }
    // The VLM inspects the closest candidate and, only when nothing has
    // matched yet, the second one. At most two visual calls per session.
    if (!plan.vlm || i > 1) continue;
    var vlm = vlmIdentify_(image, plan.vlm.cars, plan.vlm.minConfidence, plan.vlm.model, plan.vlm.photos, plan.lighting);
    if (vlm.status === 'matched') {
      if (policyAllowsRows_(plan.feedback, plan.policy.minSamples, plan.policy.minPrecision, 'vlm', vlm.car, plan.lighting)) {
        result = vlm;
        resultIndex = i;
        break;
      }
      continue;
    }
    if (vlm.status === 'error' && !vlmError) vlmError = vlm.reason;
  }
  if (!result) {
    result = {
      engine: '', car: '', confidence: 0, plate: '',
      status: readError ? 'error' : 'unknown',
      reason: readError || 'no match',
    };
    resultIndex = 0;
  } else if (result.status === 'unknown' && vlmError) {
    // The plate stage could not decide and the provider failed: surface the
    // provider error instead of hiding it behind an unknown suggestion.
    result = { engine: 'vlm', car: '', confidence: 0, plate: '', status: 'error', reason: vlmError };
    resultIndex = 0;
  }
  // Suggestion provenance follows the candidate that produced a match; an
  // unknown/error suggestion points at the nearest candidate.
  var winner = result.status === 'matched' ? candidates[resultIndex] : null;
  var evidence = winner || candidates[0];
  var snapshotId = String(evidence.id);
  result.snapshotId = snapshotId;
  result.evidenceUrl = evidence.driveUrl;
  var patch = {
    evidenceUrl: evidence.driveUrl,
    suggestedCar: result.car,
    suggestionConfidence: result.confidence,
    suggestionPlate: result.plate,
    suggestionStatus: result.status,
    suggestionEngine: result.engine,
    suggestionSnapshotId: snapshotId,
    identifiedAt: new Date().toISOString(),
  };
  // Only evidence-backed matches assign themselves: a unique plate or a VLM
  // match made against reference photos. Text-only VLM matches stay suggestions
  // so the owner can confirm them.
  var autoAssign = result.status === 'matched' && (result.engine === 'plate' || result.usedReferences);
  var assigned = false;
  var assignError = '';
  var written = withScriptLock_(function () {
    var fresh = findRecord_(readLog_(), recordId);
    if (!fresh || fresh.car !== 'unassigned') return false;
    if (!force && (fresh.suggestionStatus === 'matched' || fresh.suggestionStatus === 'unknown')) return false;
    if (!updateLog_(recordId, patch)) return false;
    if (autoAssign) {
      try {
        var car = findCar_(result.car);
        if (car && car.active) {
          assignUnassigned_(fresh, car, readLog_(), 'auto');
          assigned = true;
        }
      } catch (error) {
        assignError = String(error.message || error);
      }
    }
    return true;
  });
  if (!written) {
    return { engine: '', car: '', confidence: 0, plate: '', status: 'unknown', snapshotId: '', reason: 'superseded' };
  }
  if (autoAssign) {
    result.assigned = assigned;
    if (assignError) result.assignError = assignError;
  }
  return result;
}

// A provider outage must not turn a frequent sync into an unbounded retry
// loop; manual identify still retries immediately.
var IDENTIFY_ERROR_RETRY_MS_ = 6 * 3600 * 1000;

function isIdentifyCandidate_(record, nowMs) {
  if (!record || record.car !== 'unassigned' || !record.teslaKey) return false;
  if (record.suggestionStatus === 'matched' || record.suggestionStatus === 'unknown') return false;
  if (record.suggestionStatus !== 'error' && record.suggestionStatus !== 'rate_limited') return true;
  var at = Date.parse(record.identifiedAt || '');
  if (isNaN(at)) return true;
  return nowMs - at >= IDENTIFY_ERROR_RETRY_MS_;
}

function identifyPending_() {
  var state = withScriptLock_(function () {
    var engine = visionEngine_();
    if (engine === 'off') return { engine: engine, candidates: [] };
    var max = configInt_(readConfigMap_().values, 'vision.maxPerSync', 5);
    var coverage = snapshotCoverage_();
    var fromMs = coverage && coverage.from ? Date.parse(coverage.from) : NaN;
    var toMs = coverage && coverage.to ? Date.parse(coverage.to) : NaN;
    var windowMs = (coverage ? coverage.windowMinutes : 10) * 60000;
    var nowMs = Date.now();
    var candidates = readLog_().filter(function (record) {
      if (!isIdentifyCandidate_(record, nowMs)) return false;
      // A record outside the camera history can never have candidate evidence.
      if (isNaN(fromMs) || isNaN(toMs)) return false;
      var at = Date.parse(record.teslaStartAt || record.startAt);
      return !isNaN(at) && at >= fromMs - windowMs && at <= toMs + windowMs;
    }).sort(function (a, b) { return Date.parse(b.startAt) - Date.parse(a.startAt); }).slice(0, max);
    return { engine: engine, candidates: candidates };
  });
  if (state.engine === 'off') return { identified: 0, unknown: 0, engine: 'off' };
  var identified = 0;
  var unknown = 0;
  for (var i = 0; i < state.candidates.length; i += 1) {
    var result = identifySession_(state.candidates[i], false);
    if (result.status === 'matched') identified += 1;
    else unknown += 1;
  }
  return { identified: identified, unknown: unknown };
}
