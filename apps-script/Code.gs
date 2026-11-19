var MAX_BODY_BYTES_ = 16384;

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    // Status only calls Tesla; it must not queue behind Sheet writes or a sync.
    if (params.status !== undefined) return json_(chargerStatusPayload_());
    // Reads migrate headers (ensureHeader_ writes), so they share the POST lock.
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
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
    // Sync fetches Tesla outside the lock and locks only for Sheet reads/writes.
    if (action === 'sync') return json_(merge_({ ok: true }, syncAction_(data)));
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var result;
      if (action === 'append') result = appendAction_(data);
      else if (action === 'delete') result = deleteAction_(data);
      else if (action === 'assign') result = assignAction_(data);
      else if (action === 'claim') result = claimAction_(data);
      else if (action === 'refreshRates') result = ratesAction_(data);
      else if (action === 'bill') result = billAction_(data);
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
  return {
    ok: true,
    cars: cars.length,
    records: records.length,
    rates: rates.length,
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
    bills: readBills_(),
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
  if (!target) return { deleted: false, released: false };
  if (target.car !== data.car) {
    if (target.car === 'unassigned' && target.source === 'tesla' && target.teslaKey) {
      return { deleted: true, released: true, alreadyReleased: true };
    }
    throw new Error('Record does not belong to this car');
  }
  if (target.teslaKey) {
    var startAt = target.teslaStartAt || target.startAt;
    var released = updateLog_(target.id, {
      car: 'unassigned',
      startAt: startAt,
      date: hkDateString_(startAt),
      time: hkTimeString_(startAt),
      source: 'tesla',
    });
    if (!released) throw new Error('Failed to release record');
    return { deleted: true, released: true, record: released };
  }
  deleteLog_(target.id);
  return { deleted: true, released: false };
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
  var rates = readRates_();
  var split = splitRecordForCar_(target, car, rates);
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
      peakKWh: split ? split.peakKWh : target.peakKWh,
      offPeakKWh: split ? split.offPeakKWh : target.offPeakKWh,
      teslaKey: target.teslaKey,
      source: 'tesla+manual',
    });
    if (!updated) throw new Error('Failed to update manual record');
    deleteLog_(target.id);
    return { assigned: true, merged: true, id: manual.id };
  }
  var patch = { car: car.id, source: 'tesla' };
  if (split) {
    patch.peakKWh = split.peakKWh;
    patch.offPeakKWh = split.offPeakKWh;
  }
  var assigned = updateLog_(target.id, patch);
  if (!assigned) throw new Error('Failed to assign record');
  return { assigned: true, merged: false, id: target.id };
}

function splitRecordForCar_(record, car, rates) {
  if (!record || record.kWh === null || record.kWh === undefined) return null;
  if (!record.durationSec || !isFinite(Number(record.durationSec))) return null;
  var at = record.teslaStartAt || record.startAt;
  if (!validIso_(at)) return null;
  var rate = selectRateRow_(hkMonth_(at), rates);
  return splitPeakKwh_(
    at,
    record.durationSec,
    record.kWh,
    rate ? rate.peakStart : DEFAULT_PEAK_START_,
    rate ? rate.peakEnd : DEFAULT_PEAK_END_,
    car.peakFactor,
  );
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

function ratesAction_() {
  return refreshRates_();
}

function billAction_(data) {
  if (!data || !data.bill) throw new Error('Missing bill');
  var bill = upsertBill_(normalizedBillInput_(data.bill));
  var calibration;
  try {
    calibration = recalibratePeakFactors_();
  } catch (error) {
    console.error('Calibration failed: ' + (error && error.message ? error.message : error));
    calibration = { applied: false, reason: 'calibration failed', error: String(error.message || error) };
  }
  return { bill: bill, calibration: calibration };
}

function recalibratePeakFactors_() {
  var bills = readBills_();
  var records = readLog_();
  var rates = readRates_();
  var cars = readCars_();
  var current = carPeakFactorMap_(cars);
  var knownCars = {};
  for (var k = 0; k < cars.length; k += 1) knownCars[cars[k].id] = true;
  var periods = [];
  var skipped = [];
  for (var b = 0; b < bills.length; b += 1) {
    var bill = bills[b];
    if (bill.peakKWh === null || bill.offPeakKWh === null) {
      skipped.push({ label: bill.periodEnd, reason: 'no peak/off-peak' });
      continue;
    }
    var startMs = Date.parse(bill.periodStart + 'T00:00:00+08:00');
    var cutoffMs = Date.parse(bill.cutoff);
    if (!isFinite(startMs) || !isFinite(cutoffMs)) {
      skipped.push({ label: bill.periodEnd, reason: 'invalid period' });
      continue;
    }
    var byCar = {};
    var assignedKWh = 0;
    var totalKWh = 0;
    for (var r = 0; r < records.length; r += 1) {
      var record = records[r];
      if (record.kWh === null || record.kWh === undefined) continue;
      if (!record.durationSec || !isFinite(Number(record.durationSec))) continue;
      var at = Date.parse(record.teslaStartAt || record.startAt);
      if (!isFinite(at) || at < startMs || at >= cutoffMs) continue;
      totalKWh += record.kWh;
      if (!record.car || record.car === 'unassigned' || !knownCars[record.car]) continue;
      var rate = selectRateRow_(hkMonth_(record.teslaStartAt || record.startAt), rates);
      var split = splitPeakKwh_(
        record.teslaStartAt || record.startAt,
        record.durationSec,
        record.kWh,
        rate ? rate.peakStart : DEFAULT_PEAK_START_,
        rate ? rate.peakEnd : DEFAULT_PEAK_END_,
      );
      if (!Object.prototype.hasOwnProperty.call(byCar, record.car)) byCar[record.car] = 0;
      byCar[record.car] += split.peakKWh;
      assignedKWh += record.kWh;
    }
    if (totalKWh <= 0 || bill.units <= 0) {
      skipped.push({ label: bill.periodEnd, reason: 'no sessions' });
      continue;
    }
    if (assignedKWh / totalKWh < 0.9) {
      skipped.push({ label: bill.periodEnd, reason: 'unlabeled sessions' });
      continue;
    }
    if (totalKWh / bill.units < 0.8) {
      skipped.push({ label: bill.periodEnd, reason: 'missing sessions' });
      continue;
    }
    periods.push({
      label: bill.periodEnd,
      actualPeakKWh: bill.peakKWh,
      byCar: byCar,
    });
  }

  var fit = fitPeakFactors_(periods, current);
  var updatedCars = [];
  if (fit.applied) {
    for (var c = 0; c < cars.length; c += 1) {
      var car = cars[c];
      var next = fit.factors[car.id];
      if (next === undefined) continue;
      var previous = peakFactorFor_(current, car.id);
      if (Math.abs(Number(next) - previous) < 0.005) continue;
      if (!updateCarPeakFactor_(car.id, next)) continue;
      updatedCars.push({
        id: car.id,
        name: car.name,
        from: round6_(previous),
        to: round6_(Number(next)),
      });
    }
  }
  var recomputed = 0;
  if (updatedCars.length) {
    recomputed = recomputeCarSplits_(updatedCars.map(function (car) { return car.id; }), rates);
  }
  return {
    applied: fit.applied,
    billsUsed: fit.billsUsed,
    updatedCars: updatedCars,
    recomputed: recomputed,
    currentRmse: fit.currentRmse,
    bestRmse: fit.bestRmse,
    periods: fit.periods,
    skipped: skipped,
    reason: fit.billsUsed ? '' : 'insufficient labeled data',
  };
}

function recomputeCarSplits_(carIds, rates) {
  if (!carIds || !carIds.length) return 0;
  var wanted = {};
  for (var i = 0; i < carIds.length; i += 1) wanted[carIds[i]] = true;
  var factors = carPeakFactorMap_(readCars_());
  var records = readLog_();
  var updates = {};
  for (var r = 0; r < records.length; r += 1) {
    var record = records[r];
    if (!wanted[record.car]) continue;
    if (record.kWh === null || record.kWh === undefined) continue;
    if (!record.durationSec || !isFinite(Number(record.durationSec))) continue;
    var at = record.teslaStartAt || record.startAt;
    if (!validIso_(at)) continue;
    var rate = selectRateRow_(hkMonth_(at), rates);
    var split = splitPeakKwh_(
      at,
      record.durationSec,
      record.kWh,
      rate ? rate.peakStart : DEFAULT_PEAK_START_,
      rate ? rate.peakEnd : DEFAULT_PEAK_END_,
      peakFactorFor_(factors, record.car),
    );
    if (Number(record.peakKWh) === Number(split.peakKWh)
        && Number(record.offPeakKWh) === Number(split.offPeakKWh)) continue;
    updates[record.id] = split;
  }
  return updateLogSplits_(updates);
}
