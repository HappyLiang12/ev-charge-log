var MAX_BODY_BYTES_ = 16384;
var MAX_SNAPSHOT_BODY_BYTES_ = 1300000;
var MAX_SNAPSHOT_IMAGE_BYTES_ = 900000;
var SNAPSHOT_MAX_AGE_MS_ = 10 * 60 * 1000;
var PENDING_DUPLICATE_WINDOW_MS_ = 30 * 60 * 1000;
var PENDING_START_LOOKBACK_MS_ = 24 * 60 * 60 * 1000;
var PENDING_START_FUTURE_MS_ = 5 * 60 * 1000;

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    // Status only calls Tesla; it must not queue behind Sheet writes or a sync.
    if (params.status !== undefined) return json_(chargerStatusPayload_());
    // Reads migrate headers (ensureHeader_ writes), so they share the POST lock.
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (params.latestImage !== undefined) return json_(latestImagePayload_());
      if (params.recordImage !== undefined) return json_(recordImagePayload_(params.recordImage));
      if (params.latest !== undefined) return json_(latestSnapshotPayload_());
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
    // Identify reads Drive and calls Vision/VLM outside the lock; identifySession_
    // takes short locks for its own Sheet reads and the final suggestion write.
    if (action === 'identify') return json_(merge_({ ok: true }, identifyAction_(data)));
    // The live claim runs Vision/VLM outside the sheet lock and takes short
    // locks for its own reads and the claim write.
    if (action === 'liveClaim') return json_(merge_({ ok: true }, liveClaimAction_(data)));
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
      else if (action === 'ignore') result = ignoreAction_(data);
      else if (action === 'reassign') result = reassignAction_(data);
      else if (action === 'refreshRates') result = ratesAction_(data);
      else if (action === 'bill') result = billAction_(data);
      else if (action === 'publishBill') result = publishBillAction_(data);
      else if (action === 'relayConfig') result = relayConfigAction_(data);
      else if (action === 'cleanup') result = cleanupAction_(data);
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

function referenceFolder_() {
  var configured = PropertiesService.getScriptProperties().getProperty('REFERENCE_FOLDER_ID');
  if (configured) return DriveApp.getFolderById(configured);
  var folders = DriveApp.getFoldersByName('EV Charge References');
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder('EV Charge References');
}

function addCarPhotoFromFile_(carId, fileId, lighting, view) {
  var car = findCar_(carId);
  if (!car) throw new Error('Unknown car: ' + carId);
  var file = DriveApp.getFileById(String(fileId || ''));
  if (!file) throw new Error('Unknown file: ' + fileId);
  var level = normalizeCarPhotoLighting_(lighting);
  var viewLevel = normalizeCarPhotoView_(view);
  var copy = file.makeCopy('ref-' + car.id + '-' + level + '-' + viewLevel + '-' + Date.now(), referenceFolder_());
  appendCarPhoto_({
    carId: car.id,
    fileId: copy.getId(),
    lighting: level,
    view: viewLevel,
    active: 'TRUE',
    createdAt: new Date().toISOString(),
  });
  return { carId: car.id, fileId: copy.getId(), lighting: level, view: viewLevel };
}

function addCarPhotoFromSnapshot_(carId, snapshotId, lighting, view) {
  var snapshots = readSnapshots_();
  var snapshot = null;
  for (var i = 0; i < snapshots.length; i += 1) {
    if (snapshots[i].id === String(snapshotId)) {
      snapshot = snapshots[i];
      break;
    }
  }
  if (!snapshot) throw new Error('Unknown snapshot: ' + snapshotId);
  // The copy lives in the reference folder so snapshot retention cannot trash it.
  return addCarPhotoFromFile_(carId, snapshot.driveFileId, lighting, view);
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
    crop: String(configValue_('relay.crop') || ''),
  };
  appendSnapshot_(snapshot);
  return { stored: true, existing: false, id: snapshot.id, driveUrl: snapshot.driveUrl };
}

var CLEANUP_FAILURE_SAMPLE_LIMIT_ = 10;

function cleanupWarn_(message) {
  if (typeof console === 'undefined' || !console) return;
  if (typeof console.warn === 'function') console.warn(message);
  else if (typeof console.log === 'function') console.log(message);
}

function isDriveNotFound_(error) {
  var message = String((error && error.message) || error || '');
  return /no item with the given id|not found|could not be found|does not exist/i.test(message);
}

// Trashes one snapshot file. A missing file is already gone, so it counts as
// success; any other error is transient and must reach the caller.
function trashSnapshotFile_(fileId) {
  var id = String(fileId || '');
  if (!id) return;
  var file;
  try {
    file = DriveApp.getFileById(id);
  } catch (error) {
    if (isDriveNotFound_(error)) return;
    throw error;
  }
  if (!file) return;
  file.setTrashed(true);
}

function cleanupSnapshots_(now, limit) {
  var retentionDays = configInt_(readConfigMap_().values, 'snapshot.retentionDays', 30);
  var cutoff = (now ? now.getTime() : Date.now()) - retentionDays * 86400000;
  var max = Math.max(1, Math.min(Number(limit) || 500, 1000));
  var expired = readSnapshots_().filter(function (snapshot) {
    return Date.parse(snapshot.capturedAt) < cutoff;
  }).sort(function (a, b) {
    return Date.parse(a.capturedAt) - Date.parse(b.capturedAt);
  }).slice(0, max);
  var removable = [];
  var failures = [];
  for (var i = 0; i < expired.length; i += 1) {
    try {
      trashSnapshotFile_(expired[i].driveFileId);
      removable.push(expired[i].id);
    } catch (error) {
      // Keep the row so the next cleanup retries the Drive trash.
      failures.push(expired[i].id + ' (' + String(expired[i].driveFileId || 'no-file-id') + '): '
        + String((error && error.message) || error));
    }
  }
  var deleted = deleteSnapshots_(removable);
  if (failures.length) {
    cleanupWarn_('cleanup: trashed ' + deleted + ' of ' + expired.length + ' expired snapshot(s); kept '
      + failures.length + ' row(s) for retry: '
      + failures.slice(0, CLEANUP_FAILURE_SAMPLE_LIMIT_).join('; '));
  }
  return { deleted: deleted, failed: failures.length };
}

function cleanupAction_(data) {
  var secret = PropertiesService.getScriptProperties().getProperty('RELAY_HMAC_SECRET');
  if (!secret) throw new Error('Missing RELAY_HMAC_SECRET');
  if (!validIso_(data.at)) throw new Error('Invalid cleanup timestamp');
  if (Math.abs(Date.now() - Date.parse(data.at)) > SNAPSHOT_MAX_AGE_MS_) throw new Error('Cleanup timestamp outside window');
  var expected = hmacHex_('cleanup\n' + String(data.at), secret);
  if (String(data.signature || '') !== expected) throw new Error('Invalid signature');
  return cleanupSnapshots_(new Date(), data.limit);
}

function setup() {
  ensureConfigDefaults_();
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
    cars: readCars_(),
    snapshotCoverage: snapshotCoverage_(),
    records: stripFamilyRecord_(records.filter(function (record) { return record.car === car.id; })),
    unassigned: stripFamilyRecord_(records.filter(function (record) { return record.car === 'unassigned'; })),
    rates: readRates_(),
    bills: familyBillShares_(car.id),
    serverTime: new Date().toISOString(),
  };
}

// Family payloads carry only what the family UI needs: no evidence link, no
// engine, and no snapshot id. Least privilege keeps internal provenance out of
// a capability URL.
var FAMILY_HIDDEN_FIELDS_ = { evidenceUrl: true, suggestionEngine: true, suggestionSnapshotId: true };

function stripFamilyRecord_(records) {
  return records.map(function (record) {
    var copy = {};
    for (var key in record) {
      if (Object.prototype.hasOwnProperty.call(record, key)
        && !Object.prototype.hasOwnProperty.call(FAMILY_HIDDEN_FIELDS_, key)) {
        copy[key] = record[key];
      }
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

function latestSnapshotPayload_() {
  var snapshot = readLatestSnapshot_();
  return {
    ok: true,
    snapshot: snapshot ? {
      id: snapshot.id,
      capturedAt: snapshot.capturedAt,
      driveUrl: snapshot.driveUrl,
      driveFileId: snapshot.driveFileId,
      width: snapshot.width,
      height: snapshot.height,
      crop: snapshot.crop,
    } : null,
    serverTime: new Date().toISOString(),
  };
}

function latestImagePayload_() {
  var snapshot = readLatestSnapshot_();
  if (!snapshot) return { ok: true, snapshot: null };
  var bytes = DriveApp.getFileById(snapshot.driveFileId).getBlob().getBytes();
  return {
    ok: true,
    snapshot: {
      id: snapshot.id,
      capturedAt: snapshot.capturedAt,
      width: snapshot.width,
      height: snapshot.height,
      crop: snapshot.crop,
    },
    image: Utilities.base64Encode(bytes),
  };
}

var RECORD_THUMB_SIZE_ = 480;
var RECORD_THUMB_CACHE_SECONDS_ = 6 * 3600;
var RECORD_IMAGE_CACHE_SECONDS_ = 3600;
var SNAPSHOT_COVERAGE_CACHE_SECONDS_ = 5 * 60;
var FAMILY_SYNC_MIN_MS_ = 5 * 60 * 1000;

// The Drive thumbnail endpoint serves a private file without a browser session;
// the full crop stays in Drive and the browser never needs a Google login.
function driveThumbnailBase64_(fileId) {
  var id = String(fileId || '');
  if (!id) return null;
  var key = 'thumb:' + id + ':' + RECORD_THUMB_SIZE_;
  var cache = null;
  try {
    cache = CacheService.getScriptCache();
    var cached = cache.get(key);
    if (cached) return cached;
  } catch (error) {
    cache = null;
  }
  var bytes = null;
  try {
    var meta = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?fields=thumbnailLink',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
    );
    if (meta.getResponseCode() === 200) {
      var link = '';
      try { link = String(JSON.parse(meta.getContentText()).thumbnailLink || ''); } catch (error) { link = ''; }
      if (link) {
        var href = link.replace(/=s\d+.*$/, '=s' + RECORD_THUMB_SIZE_);
        var image = UrlFetchApp.fetch(href, { muteHttpExceptions: true });
        if (image.getResponseCode() === 200) bytes = image.getBlob().getBytes();
      }
    }
  } catch (error) {
    bytes = null;
  }
  if (!bytes || !bytes.length) {
    try { bytes = DriveApp.getFileById(id).getBlob().getBytes(); } catch (error) { bytes = null; }
  }
  if (!bytes || !bytes.length) return null;
  var base64 = Utilities.base64Encode(bytes);
  // A full-size fallback can exceed the per-key cache limit; returning it uncached is fine.
  try { if (cache) cache.put(key, base64, RECORD_THUMB_CACHE_SECONDS_); } catch (error) { /* not cacheable */ }
  return base64;
}

function resolveRecordSnapshot_(record, snapshots) {
  var rows = snapshots || [];
  var evidenceId = String(record.suggestionSnapshotId || '');
  if (evidenceId) {
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].id === evidenceId) return rows[i];
    }
  }
  var target = Date.parse(record.teslaStartAt || record.startAt);
  if (isNaN(target)) return null;
  var windowMs = configInt_(readConfigMap_().values, 'snapshot.windowMinutes', 10) * 60 * 1000;
  var best = null;
  var bestDelta = Infinity;
  for (var j = 0; j < rows.length; j += 1) {
    var at = Date.parse(rows[j].capturedAt);
    if (isNaN(at)) continue;
    var delta = Math.abs(at - target);
    if (delta > windowMs || delta >= bestDelta) continue;
    best = rows[j];
    bestDelta = delta;
  }
  return best;
}

function recordImagePayload_(recordId) {
  var id = String(recordId || '');
  if (!id) throw new Error('Unknown record');
  var cacheKey = 'recordImg:v1:' + id;
  var cache = null;
  var resolved = null;
  try {
    cache = CacheService.getScriptCache();
    var raw = cache.get(cacheKey);
    if (raw) resolved = JSON.parse(raw);
  } catch (error) {
    cache = null;
  }
  if (!resolved) {
    var record = findRecord_(readLog_(), id);
    if (!record) throw new Error('Unknown record');
    var snapshot = resolveRecordSnapshot_(record, readSnapshots_());
    resolved = snapshot ? {
      id: snapshot.id,
      capturedAt: snapshot.capturedAt,
      driveFileId: snapshot.driveFileId,
      width: snapshot.width,
      height: snapshot.height,
      crop: snapshot.crop,
    } : { id: '' };
    try {
      if (cache) cache.put(cacheKey, JSON.stringify(resolved), RECORD_IMAGE_CACHE_SECONDS_);
    } catch (error) { /* not cacheable */ }
  }
  if (!resolved.id) return { ok: true, recordId: id, snapshot: null };
  var image = driveThumbnailBase64_(resolved.driveFileId);
  return {
    ok: true,
    recordId: id,
    snapshot: {
      id: resolved.id,
      capturedAt: resolved.capturedAt,
      width: resolved.width,
      height: resolved.height,
      crop: resolved.crop,
    },
    image: image || '',
  };
}

function snapshotCoverage_() {
  var cacheKey = 'snapshotCoverage:v1';
  var cache = null;
  try {
    cache = CacheService.getScriptCache();
    var cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (error) {
    cache = null;
  }
  var snapshots = readSnapshots_();
  var from = null;
  var to = null;
  for (var i = 0; i < snapshots.length; i += 1) {
    var at = Date.parse(snapshots[i].capturedAt);
    if (isNaN(at)) continue;
    if (from === null || at < from) from = at;
    if (to === null || at > to) to = at;
  }
  var coverage = {
    from: from === null ? '' : new Date(from).toISOString(),
    to: to === null ? '' : new Date(to).toISOString(),
    windowMinutes: configInt_(readConfigMap_().values, 'snapshot.windowMinutes', 10),
  };
  try {
    if (cache) cache.put(cacheKey, JSON.stringify(coverage), SNAPSHOT_COVERAGE_CACHE_SECONDS_);
  } catch (error) { /* not cacheable */ }
  return coverage;
}

function ownerPayload_() {
  return {
    ok: true,
    cars: readCars_(),
    snapshotCoverage: snapshotCoverage_(),
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

function isPendingManual_(record) {
  return Boolean(record)
    && (record.source === 'manual' || record.source === 'live')
    && record.kWh === null && !record.teslaKey;
}

function pendingMaxAgeMs_() {
  return configInt_(readConfigMap_().values, 'manual.pendingMaxAgeHours', 24) * 3600 * 1000;
}

function prunePendingStarts_(nowMs, carId) {
  var maxAge = pendingMaxAgeMs_();
  var records = readLog_();
  var removed = 0;
  for (var i = 0; i < records.length; i += 1) {
    var record = records[i];
    if (!isPendingManual_(record)) continue;
    if (carId && record.car !== carId) continue;
    var start = Date.parse(record.startAt);
    if (isNaN(start) || nowMs - start <= maxAge) continue;
    if (deleteLog_(record.id)) removed += 1;
  }
  return removed;
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
  var nowMs = Date.now();
  var startMs = Date.parse(data.startAt);
  if (startMs > nowMs + PENDING_START_FUTURE_MS_ || startMs < nowMs - PENDING_START_LOOKBACK_MS_) {
    throw new Error('Start time outside the accepted window');
  }
  prunePendingStarts_(nowMs, car.id);
  records = readLog_();
  var duplicate = null;
  for (var j = 0; j < records.length; j += 1) {
    if (!isPendingManual_(records[j]) || records[j].car !== car.id) continue;
    var otherStart = Date.parse(records[j].startAt);
    if (isNaN(otherStart) || Math.abs(otherStart - startMs) > PENDING_DUPLICATE_WINDOW_MS_) continue;
    duplicate = records[j];
    break;
  }
  if (duplicate) return { record: duplicate, existing: true };
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
  var records = readLog_();
  var target = null;
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id === String(data.id)) target = records[i];
  }
  if (!target) return { deleted: false, released: false };
  // Manual starts have no Tesla key, and an unassigned leftover has no car
  // page to delete it from, so any car context may clear it.
  if ((target.source === 'manual' || target.source === 'live') && !target.teslaKey) {
    if (target.car !== 'unassigned' && target.car !== String(data.car || '')) {
      throw new Error('Record does not belong to this car');
    }
    deleteLog_(target.id);
    return { deleted: true, released: false };
  }
  if (!validCarId_(data.car)) throw new Error('Invalid car id');
  var car = findCar_(data.car);
  if (!car) throw new Error('Unknown car: ' + data.car);
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
  var params = data || {};
  var carScoped = Boolean(params.car);
  var familyTriggered = params.family === true;
  if (familyTriggered && params.manual !== true) {
    var lastSync = Date.parse(PropertiesService.getScriptProperties().getProperty('LAST_SYNC_AT') || '');
    if (!isNaN(lastSync) && Date.now() - lastSync < FAMILY_SYNC_MIN_MS_) {
      return { skipped: true, reason: 'recent', lastSyncAt: new Date(lastSync).toISOString() };
    }
  }
  // A family page runs the full path but must not open the 30-day history window.
  var result = syncTesla_(!carScoped && !familyTriggered);
  if (!carScoped && !result.skipped) {
    try { result.vision = identifyPending_(); } catch (error) { result.vision = { error: String(error.message || error) }; }
    try {
      PropertiesService.getScriptProperties().setProperty('LAST_SYNC_AT', new Date().toISOString());
    } catch (error) {
      result.lastSyncStored = false;
    }
  }
  return result;
}

var SCHEDULED_SYNC_MINUTES_ = 30;

function scheduledSync() {
  try {
    var last = Date.parse(PropertiesService.getScriptProperties().getProperty('LAST_SYNC_AT') || '');
    if (!isNaN(last) && Date.now() - last < SCHEDULED_SYNC_MINUTES_ * 60 * 1000) {
      console.log('scheduled sync skipped: last sync at ' + new Date(last).toISOString());
      return { ok: true, skipped: 'recent' };
    }
    var result = syncAction_({});
    console.log('scheduled sync ' + JSON.stringify(result));
    return result;
  } catch (error) {
    console.log('scheduled sync failed: ' + String(error.message || error));
    return { ok: false, error: String(error.message || error) };
  }
}

function installScheduledSync() {
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'scheduledSync';
  });
  existing.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('scheduledSync').timeBased().everyMinutes(SCHEDULED_SYNC_MINUTES_).create();
  return { ok: true, minutes: SCHEDULED_SYNC_MINUTES_, replaced: existing.length };
}

function removeScheduledSync() {
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'scheduledSync';
  });
  existing.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  return { ok: true, removed: existing.length };
}

function readDriveImageBase64_(fileId) {
  return Utilities.base64Encode(DriveApp.getFileById(fileId).getBlob().getBytes());
}

var LIVE_CLAIM_CACHE_SECONDS_ = 1800;

function cacheLiveClaim_(cache, key, payload) {
  if (cache) cache.put(key, JSON.stringify(payload), LIVE_CLAIM_CACHE_SECONDS_);
  return payload;
}

// The family page runs this once when it opens while the charger is charging.
// It returns an existing claim or a cached verdict without provider calls, and
// matches the latest crop against the requested car only.
function liveClaimAction_(data) {
  var car = findCar_(String(data.car || ''));
  if (!car || !car.active) throw new Error('Unknown or inactive car: ' + data.car);
  var cache = typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null;
  var nowMs = Date.now();
  var plan = withScriptLock_(function () {
    prunePendingStarts_(nowMs, car.id);
    var records = readLog_();
    for (var i = 0; i < records.length; i += 1) {
      var record = records[i];
      if (record.source === 'live' && record.car === car.id && record.kWh === null && !record.teslaKey) {
        return { existing: record };
      }
    }
    var snapshot = readLatestSnapshot_();
    if (!snapshot) return { result: { status: 'no_snapshot', reason: 'no snapshot' } };
    var cacheKey = 'liveClaim:' + car.id + ':' + snapshot.id;
    if (cache) {
      var cached = cache.get(cacheKey);
      if (cached) {
        try {
          return { result: JSON.parse(cached) };
        } catch (error) {
          // fall through to a fresh check
        }
      }
    }
    return {
      snapshot: snapshot,
      cacheKey: cacheKey,
      config: readConfigMap_().values,
      cars: readCars_(),
      photos: readCarPhotos_(),
      plates: readPlates_(),
      feedback: readFeedback_(),
    };
  });
  if (plan.existing) {
    return { status: 'claimed', existing: true, claimId: plan.existing.id, snapshotId: '', confidence: null, reason: 'already claimed' };
  }
  if (plan.result) return plan.result;
  var snapshot = plan.snapshot;
  var charger = chargerLiveStatus_();
  if (!charger.available) return { status: 'unavailable', reason: 'charger status unavailable', snapshotId: snapshot.id };
  if (!charger.charging) return { status: 'not_charging', reason: 'charger is not charging', snapshotId: snapshot.id };
  var image = readDriveImageBase64_(snapshot.driveFileId);
  var plate = plateIdentify_(image, plan.plates);
  var lighting = lightingFor_(snapshot.capturedAt);
  var result = null;
  if (plate.status === 'matched') {
    if (plate.car !== car.id) {
      return cacheLiveClaim_(cache, plan.cacheKey, {
        status: 'other_car', car: plate.car, engine: 'plate', confidence: plate.confidence,
        plate: plate.plate, reason: 'plate matched another car', snapshotId: snapshot.id,
      });
    }
    result = { engine: 'plate', confidence: plate.confidence, plate: plate.plate, reason: plate.reason };
  } else {
    var minConfidence = configNumber_(plan.config, 'vision.minConfidence', 0.8, 0.5, 0.99);
    var model = String(configRaw_(plan.config, 'vision.vlmModel', '') || '');
    var vlm = vlmIdentify_(image, plan.cars, minConfidence, model, plan.photos, lighting);
    if (vlm.status !== 'matched' || vlm.car !== car.id) {
      return cacheLiveClaim_(cache, plan.cacheKey, {
        status: vlm.status === 'matched' ? 'other_car' : vlm.status,
        car: vlm.car, engine: vlm.engine || 'vlm', confidence: vlm.confidence,
        plate: vlm.plate, reason: vlm.reason, snapshotId: snapshot.id,
      });
    }
    var minSamples = configInt_(plan.config, 'policy.minSamples', 5);
    var minPrecision = configNumber_(plan.config, 'policy.minPrecision', 0.9, 0.5, 0.99);
    if (!policyAllowsRows_(plan.feedback, minSamples, minPrecision, 'vlm', vlm.car, lighting)) {
      return cacheLiveClaim_(cache, plan.cacheKey, {
        status: 'policy_blocked', car: vlm.car, engine: 'vlm', confidence: vlm.confidence,
        plate: '', reason: 'policy gate', snapshotId: snapshot.id,
      });
    }
    result = { engine: 'vlm', confidence: vlm.confidence, plate: '', reason: vlm.reason };
  }
  var created = withScriptLock_(function () {
    var records = readLog_();
    for (var j = 0; j < records.length; j += 1) {
      var record = records[j];
      if (record.source === 'live' && record.car === car.id && record.kWh === null && !record.teslaKey) {
        return { existing: record };
      }
    }
    var nowIso = new Date().toISOString();
    var claim = {
      id: 'live-' + nowMs + '-' + Math.floor(Math.random() * 100000),
      car: car.id,
      startAt: nowIso,
      date: hkDateString_(nowIso),
      time: hkTimeString_(nowIso),
      kWh: null,
      durationSec: null,
      teslaStartAt: null,
      teslaEndAt: null,
      peakKWh: null,
      offPeakKWh: null,
      teslaKey: null,
      source: 'live',
      evidenceUrl: snapshot.driveUrl,
    };
    appendLog_(claim);
    return { claim: claim };
  });
  if (created.existing) {
    return { status: 'claimed', existing: true, claimId: created.existing.id, snapshotId: snapshot.id, confidence: null, reason: 'already claimed' };
  }
  return cacheLiveClaim_(cache, plan.cacheKey, {
    status: 'claimed', existing: false, claimId: created.claim.id, car: car.id,
    engine: result.engine, confidence: result.confidence, plate: result.plate,
    reason: result.reason, snapshotId: snapshot.id,
  });
}

function identifyAction_(data) {
  // identifySession_ re-reads the record under the script lock; this action
  // runs outside doPost's general lock so provider calls do not block syncs.
  var id = String(data.id || '');
  if (!id) throw new Error('Unknown record');
  return identifySession_({ id: id }, Boolean(data.force));
}

function findRecord_(records, id) {
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id === String(id)) return records[i];
  }
  return null;
}

function recordAssignmentFeedback_(target, chosenCar, actor) {
  recordFeedbackRow_(target, chosenCar, actor);
}

function recordCorrectionFeedback_(target, chosenCar, actor) {
  recordFeedbackRow_(target, chosenCar, actor || 'owner');
}

function recordFeedbackRow_(target, chosenCar, actor) {
  if (!target) return;
  // Auto-assignment is not a human correction; counting it would bias the
  // precision gate that learns from owner/family choices.
  if (actor === 'auto') return;
  appendFeedback_({
    id: 'fb-' + target.id + '-' + Date.now(),
    recordId: target.id,
    startAt: target.teslaStartAt || target.startAt,
    engine: target.suggestionEngine || (target.suggestedCar ? '' : 'manual'),
    suggestedCar: target.suggestedCar || '',
    chosenCar: chosenCar,
    confidence: target.suggestionConfidence,
    plate: target.suggestionPlate || '',
    snapshotId: target.suggestionSnapshotId || '',
    lighting: lightingFor_(target.teslaStartAt || target.startAt),
    actor: actor || '',
    createdAt: new Date().toISOString(),
  });
  // Plate-map tuning is owner-only: a family claim still records its feedback
  // row, but a mistaken family claim must never rewrite OCR for every car.
  if (actor === 'owner' && target.suggestionPlate && target.suggestedCar && target.suggestedCar !== chosenCar) {
    upsertPlate_(target.suggestionPlate, chosenCar);
  }
}

function assignUnassigned_(target, car, records, actor) {
  if (!target) throw new Error('Unknown record');
  if (target.car !== 'unassigned') throw new Error('Only unassigned sessions can be assigned');
  if (!target.teslaKey) throw new Error('Record has no Tesla key');
  recordAssignmentFeedback_(target, car.id, actor);
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
  return assignUnassigned_(findRecord_(records, data.id), car, records, 'family');
}

function assignAction_(data) {
  var car = findCar_(data.car);
  if (!car || !car.active) throw new Error('Unknown or inactive car: ' + data.car);
  var records = readLog_();
  return assignUnassigned_(findRecord_(records, data.id), car, records, 'owner');
}

function ignoreAction_(data) {
  var record = findRecord_(readLog_(), String(data.id || ''));
  if (!record) throw new Error('Unknown record');
  if (record.car !== 'unassigned') {
    throw new Error('Only unassigned sessions can be ignored');
  }
  // A pending manual start is not a guest decision; deleting it must not
  // train the feedback gate.
  if (isPendingManual_(record)) return { ignored: deleteLog_(record.id) };
  // Deleting the Log row also deletes the dedupe key, so persist it first;
  // otherwise the next sync re-imports the session.
  if (record.teslaKey) appendIgnoredTeslaKey_(record.teslaKey, 'owner');
  recordAssignmentFeedback_(record, 'guest', 'owner');
  var deleted = deleteLog_(record.id);
  return { ignored: deleted };
}

function reassignAction_(data) {
  var record = findRecord_(readLog_(), String(data.id || ''));
  if (!record || !record.car || record.car === 'unassigned') {
    throw new Error('Only assigned records can be reassigned');
  }
  var car = findCar_(data.car);
  if (!car || !car.active) throw new Error('Unknown or inactive car: ' + data.car);
  // The UI blocks this, but a direct call must not append a duplicate
  // correction that would inflate the precision buckets.
  if (record.car === car.id) throw new Error('Record already belongs to this car');
  var at = record.teslaStartAt || record.startAt;
  var rate = selectRateRow_(hkMonth_(at), readRates_());
  var split = record.kWh !== null && record.durationSec
    ? splitPeakKwh_(
        at,
        record.durationSec,
        record.kWh,
        rate ? rate.peakStart : DEFAULT_PEAK_START_,
        rate ? rate.peakEnd : DEFAULT_PEAK_END_,
        car.peakFactor,
      )
    : null;
  recordCorrectionFeedback_(record, car.id, data.actor === 'family' ? 'family' : 'owner');
  var patch = { car: car.id, source: record.source };
  if (split) { patch.peakKWh = split.peakKWh; patch.offPeakKWh = split.offPeakKWh; }
  var updated = updateLog_(record.id, patch);
  if (!updated) throw new Error('Failed to reassign record');
  return { reassigned: true, id: record.id, car: car.id };
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

var CONFIG_INT_LIMITS_ = {
  'relay.intervalSeconds': [60, 3600],
  'relay.imageWidth': [640, 2560],
  'relay.jpegQuality': [2, 10],
  'relay.captureTimeoutSeconds': [10, 120],
  'relay.maxQueue': [100, 5000],
  'relay.cleanupIntervalSeconds': [600, 86400],
  'relay.cleanupBatch': [10, 1000],
  'snapshot.retentionDays': [1, 365],
  'snapshot.windowMinutes': [1, 60],
  'snapshot.candidateCount': [1, 5],
  'manual.pendingMaxAgeHours': [6, 72],
  'vision.maxPerSync': [0, 20],
  'policy.minSamples': [1, 50],
};

function configRaw_(map, key, fallback) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback;
}

function configBool_(map, key, fallback) {
  var raw = String(configRaw_(map, key, fallback)).trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

function configNumericRaw_(map, key, fallback) {
  var raw = configRaw_(map, key, fallback);
  if (raw === undefined || raw === null) return NaN;
  raw = String(raw).trim();
  if (raw === '') return NaN;
  return Number(raw);
}

function configInt_(map, key, fallback) {
  var limits = CONFIG_INT_LIMITS_[key];
  var number = configNumericRaw_(map, key, fallback);
  if (!isFinite(number)) number = fallback;
  number = Math.round(number);
  if (!limits) return number;
  return Math.min(Math.max(number, limits[0]), limits[1]);
}

function configNumber_(map, key, fallback, min, max) {
  var number = configNumericRaw_(map, key, fallback);
  if (!isFinite(number)) number = fallback;
  return Math.min(Math.max(number, min), max);
}

function configCrop_(map) {
  var raw = String(configRaw_(map, 'relay.crop', '') || '').trim();
  if (raw === 'full') return 'full';
  if (!/^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/.test(raw)) return '';
  var parts = raw.split(':').map(Number);
  if (parts[2] <= 0 || parts[3] <= 0) return '';
  return raw;
}

function relayConfigAction_(data) {
  var secret = PropertiesService.getScriptProperties().getProperty('RELAY_HMAC_SECRET');
  if (!secret) throw new Error('Missing RELAY_HMAC_SECRET');
  if (!validIso_(data.at)) throw new Error('Invalid config timestamp');
  if (Math.abs(Date.now() - Date.parse(data.at)) > SNAPSHOT_MAX_AGE_MS_) throw new Error('Config timestamp outside window');
  var expected = hmacHex_('relayConfig\n' + String(data.at), secret);
  if (String(data.signature || '') !== expected) throw new Error('Invalid signature');
  var read = readConfigMap_();
  var map = read.values;
  var config = {
    'relay.enabled': configBool_(map, 'relay.enabled', true),
    'relay.intervalSeconds': configInt_(map, 'relay.intervalSeconds', 300),
    'relay.imageWidth': configInt_(map, 'relay.imageWidth', 1920),
    'relay.jpegQuality': configInt_(map, 'relay.jpegQuality', 3),
    'relay.crop': configCrop_(map),
    'relay.captureTimeoutSeconds': configInt_(map, 'relay.captureTimeoutSeconds', 30),
    'relay.maxQueue': configInt_(map, 'relay.maxQueue', 1000),
    'relay.cleanupIntervalSeconds': configInt_(map, 'relay.cleanupIntervalSeconds', 3600),
    'relay.cleanupBatch': configInt_(map, 'relay.cleanupBatch', 500),
  };
  return { config: config, updatedAt: read.updatedAt };
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
