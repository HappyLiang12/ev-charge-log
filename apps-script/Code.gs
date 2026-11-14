var SHEET_ID = 'PASTE_SHEET_ID_HERE';
var MAX_BODY_BYTES_ = 16384;

function doGet(e) {
  try {
    // Reads migrate headers (ensureHeader_ writes), so GET shares the POST lock.
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var params = (e && e.parameter) || {};
      if (params.owner) return json_(ownerPayload_(params.owner));
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
      else if (action === 'ignore') result = ignoreAction_(data);
      else if (action === 'refreshRates') result = ratesAction_(data);
      else throw new Error('Unknown action');
      return json_(merge_({ ok: true }, result));
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  }
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

function assertOwner_(ownerKey) {
  var expected = scriptProperty_('OWNER_KEY');
  if (!expected) throw new Error('Owner key is not configured (set the OWNER_KEY script property)');
  if (!ownerKey || String(ownerKey) !== String(expected)) throw new Error('Invalid owner key');
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
  return {
    ok: true,
    car: car,
    records: readLog_().filter(function (record) { return record.car === car.id; }),
    rates: readRates_(),
    serverTime: new Date().toISOString(),
  };
}

function ownerPayload_(ownerKey) {
  assertOwner_(ownerKey);
  return {
    ok: true,
    cars: readCars_(),
    records: readLog_(),
    rates: readRates_(),
    serverTime: new Date().toISOString(),
  };
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
  if (data.ownerKey) {
    assertOwner_(data.ownerKey);
  } else if (data.car) {
    if (!validCarId_(data.car)) throw new Error('Invalid car id');
    var car = findCar_(data.car);
    if (!car) throw new Error('Unknown car: ' + data.car);
  } else {
    throw new Error('Missing authorization');
  }
  var records = readLog_();
  var target = null;
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id === String(data.id)) target = records[i];
  }
  if (!target) return { deleted: false };
  if (!data.ownerKey && target.car !== data.car) throw new Error('Record does not belong to this car');
  if (target.teslaKey) addIgnored_(target.teslaKey, 'deleted');
  deleteLog_(target.id);
  return { deleted: true };
}

function syncAction_(data) {
  if (data.ownerKey) {
    assertOwner_(data.ownerKey);
  } else if (data.car) {
    if (!validCarId_(data.car)) throw new Error('Invalid car id');
    var car = findCar_(data.car);
    if (!car) throw new Error('Unknown car: ' + data.car);
  } else {
    throw new Error('Missing authorization');
  }
  return syncTesla_();
}

function assignAction_(data) {
  assertOwner_(data.ownerKey);
  var records = readLog_();
  var target = null;
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id === String(data.id)) target = records[i];
  }
  if (!target) throw new Error('Unknown record');
  if (target.car !== 'unassigned') throw new Error('Only unassigned sessions can be assigned');
  var car = findCar_(data.car);
  if (!car || !car.active) throw new Error('Unknown or inactive car: ' + data.car);
  if (!target.teslaKey) throw new Error('Record has no Tesla key');
  var windowMs = Number(scriptProperty_('MATCH_WINDOW_MINUTES') || 30) * 60 * 1000;
  var manualRows = records.filter(function (record) {
    return record.source === 'manual' && record.car === car.id && record.kWh === null && !record.teslaKey;
  });
  var manual = closestManualCandidate_(target.teslaStartAt || target.startAt, manualRows, windowMs);
  if (manual) {
    updateLog_(target.id, {
      car: car.id,
      startAt: manual.startAt,
      date: manual.date,
      time: manual.time,
      source: 'tesla+manual',
    });
    deleteLog_(manual.id);
    return { assigned: true, merged: true };
  }
  updateLog_(target.id, { car: car.id, source: 'tesla' });
  return { assigned: true, merged: false };
}

function ignoreAction_(data) {
  assertOwner_(data.ownerKey);
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

function ratesAction_(data) {
  assertOwner_(data.ownerKey);
  return refreshRates_();
}
