var MAX_BODY_BYTES_ = 16384;

function doGet(e) {
  try {
    // Reads migrate headers (ensureHeader_ writes), so GET shares the POST lock.
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var params = (e && e.parameter) || {};
      if (params.status !== undefined) return json_(chargerStatusPayload_());
      if (params.owner !== undefined) return json_(ownerPayload_());
      if (params.car) return json_(familyPayload_(params.car));
      throw new Error('Missing car or owner parameter');
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  }
}

function doPost(e) {
  try {
    var raw = e && e.postData ? e.postData.contents : '';
    if (!raw || raw.length > MAX_BODY_BYTES_) throw new Error('Request body too large');
    var data = JSON.parse(raw);
    var action = String(data.action || 'append');
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var result;
      if (action === 'append') result = appendAction_(data);
      else if (action === 'delete') result = deleteAction_(data);
      else if (action === 'sync') result = syncAction_(data);
      else if (action === 'assign') result = assignAction_(data);
      else if (action === 'claim') result = claimAction_(data);
      else if (action === 'ignore') result = ignoreAction_(data);
      else if (action === 'refreshRates') result = ratesAction_(data);
      else throw new Error('Invalid action');
      return json_(merge_({ ok: true }, result));
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  }
}

function setup() {
  var cars = readCars_();
  var records = readLog_();
  var rates = readRates_();
  var ignored = readIgnored_();
  return {
    ok: true,
    cars: cars.length,
    records: records.length,
    rates: rates.length,
    ignored: ignored.length,
    sheetUrl: sheetUrl_(),
  };
}

function merge_(base, extra) {
  var out = {};
  for (var key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
  for (var other in extra) if (Object.prototype.hasOwnProperty.call(extra, other)) out[other] = extra[other];
  return out;
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function findCar_(carId) {
  if (!validCarId_(carId)) return null;
  var cars = readCars_();
  for (var i = 0; i < cars.length; i += 1) if (cars[i].id === carId) return cars[i];
  return null;
}

function familyPayload_(carId) {
  if (!validCarId_(carId)) throw new Error('Invalid car id');
  var car = findCar_(carId);
  if (!car) throw new Error('Unknown car: ' + carId);
  if (!car.active) throw new Error('Car is inactive: ' + car.id);
  var records = readLog_();
  return {
    ok: true,
    car: car,
    records: records.filter(function (record) { return record.car === car.id; }),
    unassigned: records.filter(function (record) { return record.car === 'unassigned'; }),
    rates: readRates_(),
    serverTime: new Date().toISOString(),
  };
}

function ownerPayload_() {
  return {
    ok: true,
    cars: readCars_(),
    records: readLog_(),
    rates: readRates_(),
    sheetUrl: sheetUrl_(),
    serverTime: new Date().toISOString(),
  };
}

function chargerStatusPayload_() {
  return merge_({ ok: true }, chargerLiveStatus_());
}

function appendAction_(data) {
  if (!validCarId_(data.car)) throw new Error('Invalid car');
  var car = findCar_(data.car);
  if (!car || !car.active) throw new Error('Unknown or inactive car: ' + data.car);
  if (!data.id || !/^[A-Za-z0-9-]{1,64}$/.test(String(data.id))) throw new Error('Invalid id');
  if (!validIso_(data.startAt)) throw new Error('Invalid startAt');
  if (data.date !== hkDateString_(data.startAt) || data.time !== hkTimeString_(data.startAt)) {
    throw new Error('Date/time mismatch');
  }
  var records = readLog_();
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id !== String(data.id)) continue;
    if (records[i].car !== car.id) throw new Error('Record does not belong to this car');
    return { record: records[i] };
  }
  var record = {
    id: String(data.id),
    car: car.id,
    startAt: new Date(data.startAt).toISOString(),
    date: hkDateString_(data.startAt),
    time: hkTimeString_(data.startAt),
    kWh: null,
    durationSec: null,
    teslaStartAt: null,
    teslaEndAt: null,
    peakKWh: null,
    offPeakKWh: null,
    teslaKey: null,
    source: 'manual',
  };
  appendLog_(record);
  return { record: record };
}

function deleteAction_(data) {
  if (!data.id) throw new Error('Invalid id');
  if (!validCarId_(data.car)) throw new Error('Invalid car id');
  var car = findCar_(data.car);
  if (!car) throw new Error('Unknown car: ' + data.car);
  var records = readLog_();
  var target = null;
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id === String(data.id)) target = records[i];
  }
  if (!target) return { deleted: false };
  if (target.car !== data.car) throw new Error('Record does not belong to this car');
  if (target.teslaKey) addIgnored_(target.teslaKey, 'deleted');
  deleteLog_(target.id);
  return { deleted: true };
}

function syncAction_(data) {
  return syncTesla_(!data || !data.car);
}

function findRecord_(records, id) {
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id === String(id)) return records[i];
  }
  return null;
}

function assignUnassigned_(target, car, records) {
  if (!target) throw new Error('Unknown record');
  if (target.car !== 'unassigned') throw new Error('Only unassigned sessions can be assigned');
  if (!target.teslaKey) throw new Error('Record has no Tesla key');
  var windowMs = Number(scriptProperty_('MATCH_WINDOW_MINUTES') || 30) * 60 * 1000;
  var manualRows = records.filter(function (record) {
    return record.source === 'manual' && record.car === car.id && record.kWh === null && !record.teslaKey;
  });
  var manual = closestManualCandidate_(target.teslaStartAt || target.startAt, manualRows, windowMs);
  if (manual) {
    var updated = updateLog_(manual.id, {
      kWh: target.kWh,
      durationSec: target.durationSec,
      teslaStartAt: target.teslaStartAt,
      teslaEndAt: target.teslaEndAt,
      peakKWh: target.peakKWh,
      offPeakKWh: target.offPeakKWh,
      teslaKey: target.teslaKey,
      source: 'tesla+manual',
    });
    if (!updated) throw new Error('Failed to update manual record');
    deleteLog_(target.id);
    return { assigned: true, merged: true, id: manual.id };
  }
  var assigned = updateLog_(target.id, { car: car.id, source: 'tesla' });
  if (!assigned) throw new Error('Failed to assign record');
  return { assigned: true, merged: false, id: target.id };
}

function claimAction_(data) {
  var car = findCar_(data.car);
  if (!car || !car.active) throw new Error('Unknown or inactive car: ' + data.car);
  var records = readLog_();
  return assignUnassigned_(findRecord_(records, data.id), car, records);
}

function assignAction_(data) {
  var car = findCar_(data.car);
  if (!car || !car.active) throw new Error('Unknown or inactive car: ' + data.car);
  var records = readLog_();
  return assignUnassigned_(findRecord_(records, data.id), car, records);
}

function ignoreAction_(data) {
  var records = readLog_();
  var target = null;
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id === String(data.id)) target = records[i];
  }
  if (!target) throw new Error('Unknown record');
  if (!target.teslaKey) throw new Error('Record has no Tesla key');
  addIgnored_(target.teslaKey, 'owner ignored');
  deleteLog_(target.id);
  return { ignored: true };
}

function ratesAction_() {
  return refreshRates_();
}
