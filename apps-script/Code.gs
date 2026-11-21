var MAX_BODY_BYTES_ = 16384;
var MAX_SNAPSHOT_BODY_BYTES_ = 1300000;
var MAX_SNAPSHOT_IMAGE_BYTES_ = 900000;
var SNAPSHOT_MAX_AGE_MS_ = 10 * 60 * 1000;

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
    if (!raw || raw.length > MAX_SNAPSHOT_BODY_BYTES_) throw new Error('Request body too large');
    var data = JSON.parse(raw);
    var action = String(data.action || 'append');
    if (action !== 'snapshot' && raw.length > MAX_BODY_BYTES_) throw new Error('Request body too large');
    // Sync fetches Tesla outside the lock and locks only for Sheet reads/writes.
    if (action === 'sync') return json_(merge_({ ok: true }, syncAction_(data)));
    if (action === 'snapshot') {
      var snapshotLock = LockService.getScriptLock();
      snapshotLock.waitLock(30000);
      try {
        return json_(merge_({ ok: true }, snapshotAction_(data)));
      } finally {
        snapshotLock.releaseLock();
      }
    }
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
      else if (action === 'publishBill') result = publishBillAction_(data);
      else throw new Error('Invalid action');
      return json_(merge_({ ok: true }, result));
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  }
}

function hmacHex_(text, secret) {
  var bytes = Utilities.computeHmacSha256Signature(String(text), String(secret));
  var out = '';
  for (var i = 0; i < bytes.length; i += 1) {
    var value = (bytes[i] + 256) % 256;
    out += (value < 16 ? '0' : '') + value.toString(16);
  }
  return out;
}

function snapshotCanonical_(data) {
  return [
    String(data.id || ''),
    String(data.capturedAt || ''),
    String(data.width || ''),
    String(data.height || ''),
    String(data.image || ''),
  ].join('\n');
}

function snapshotFolder_() {
  var configured = PropertiesService.getScriptProperties().getProperty('SNAPSHOT_FOLDER_ID');
  if (configured) return DriveApp.getFolderById(configured);
  var folders = DriveApp.getFoldersByName('EV Charge Snapshots');
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder('EV Charge Snapshots');
}

function snapshotAction_(data) {
  var secret = PropertiesService.getScriptProperties().getProperty('RELAY_HMAC_SECRET');
  if (!secret) throw new Error('Missing RELAY_HMAC_SECRET');
  if (!/^snap-[0-9]{10,13}$/.test(String(data.id || ''))) throw new Error('Invalid snapshot id');
  if (!validIso_(data.capturedAt)) throw new Error('Invalid capturedAt');
  var capturedMs = Date.parse(data.capturedAt);
  if (Math.abs(Date.now() - capturedMs) > SNAPSHOT_MAX_AGE_MS_) throw new Error('Snapshot timestamp outside window');
  var expected = hmacHex_(snapshotCanonical_(data), secret);
  if (String(data.signature || '') !== expected) throw new Error('Invalid signature');

  var existing = readSnapshots_().filter(function (row) { return row.id === data.id; });
  if (existing.length) return { stored: true, existing: true, id: data.id, driveUrl: existing[0].driveUrl };

  var bytes = Utilities.base64Decode(String(data.image || ''));
  if (!bytes.length || bytes.length > MAX_SNAPSHOT_IMAGE_BYTES_) throw new Error('Snapshot image too large');
  if ((bytes[0] + 256) % 256 !== 0xff || (bytes[1] + 256) % 256 !== 0xd8) throw new Error('Snapshot is not JPEG');

  var file = snapshotFolder_().createFile(
    Utilities.newBlob(bytes, 'image/jpeg', data.id + '.jpg'),
  );
  var snapshot = {
    id: data.id,
    capturedAt: new Date(data.capturedAt).toISOString(),
    driveFileId: file.getId(),
    driveUrl: file.getUrl(),
    width: Number(data.width) || null,
    height: Number(data.height) || null,
    bytes: bytes.length,
    source: 'pi',
    createdAt: new Date().toISOString(),
  };
  appendSnapshot_(snapshot);
  return { stored: true, existing: false, id: snapshot.id, driveUrl: snapshot.driveUrl };
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
    records: stripEvidenceUrl_(records.filter(function (record) { return record.car === car.id; })),
    unassigned: stripEvidenceUrl_(records.filter(function (record) { return record.car === 'unassigned'; })),
    rates: readRates_(),
    bills: familyBillShares_(car.id),
    serverTime: new Date().toISOString(),
  };
}

function stripEvidenceUrl_(records) {
  return records.map(function (record) {
    var copy = {};
    for (var key in record) {
      if (Object.prototype.hasOwnProperty.call(record, key) && key !== 'evidenceUrl') copy[key] = record[key];
    }
    return copy;
  });
}

function familyBillShares_(carId) {
  var bills = readBills_();
  var records = readLog_();
  var cars = readCars_();
  var output = [];
  for (var i = 0; i < bills.length; i += 1) {
    var bill = bills[i];
    if (!bill.publishedAt) continue;
    var allocation;
    try {
      allocation = billAllocation_(bill, records, cars);
    } catch (error) {
      continue;
    }
    // Any unassigned session in the period blocks the published share.
    if (allocation.unassignedCount > 0) continue;
    if (!(allocation.loggedKWh > 0)) continue;
    var row = null;
    for (var j = 0; j < allocation.rows.length; j += 1) {
      if (allocation.rows[j].id === carId) { row = allocation.rows[j]; break; }
    }
    output.push({
      periodStart: bill.periodStart,
      periodEnd: bill.periodEnd,
      cutoff: bill.cutoff,
      units: bill.units,
      peakKWh: bill.peakKWh,
      offPeakKWh: bill.offPeakKWh,
      total: bill.total,
      loggedKWh: allocation.loggedKWh,
      myKWh: row ? row.kWh : 0,
      myShare: row ? row.share : 0,
      myAmount: row ? row.amount : 0,
      publishedAt: bill.publishedAt,
    });
  }
  return output;
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
      evidenceUrl: target.evidenceUrl || '',
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

function publishBillAction_(data) {
  var periodStart = dateOnlyValue_(data && data.periodStart);
  var periodEnd = dateOnlyValue_(data && data.periodEnd);
  if (!periodStart || !periodEnd) throw new Error('Invalid bill period reference');
  var bills = readBills_();
  var bill = null;
  for (var i = 0; i < bills.length; i += 1) {
    if (bills[i].periodStart === periodStart && bills[i].periodEnd === periodEnd) {
      bill = bills[i];
      break;
    }
  }
  if (!bill) throw new Error('Unknown bill period');
  var allocation = billAllocation_(bill, readLog_(), readCars_());
  if (allocation.unassignedCount > 0) {
    throw new Error('Cannot publish: ' + allocation.unassignedCount + ' unassigned session(s) in this bill period');
  }
  if (!(allocation.loggedKWh > 0)) throw new Error('Cannot publish: no assigned sessions in this bill period');
  var publishedAt = new Date().toISOString();
  return {
    bill: updateBillPublished_(periodStart, periodEnd, publishedAt),
    allocation: { loggedKWh: allocation.loggedKWh, unassignedCount: 0 },
  };
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
    var samePeak = record.peakKWh !== null && record.peakKWh !== undefined
      && Number(record.peakKWh) === Number(split.peakKWh);
    var sameOff = record.offPeakKWh !== null && record.offPeakKWh !== undefined
      && Number(record.offPeakKWh) === Number(split.offPeakKWh);
    if (samePeak && sameOff) continue;
    updates[record.id] = split;
  }
  return updateLogSplits_(updates);
}
