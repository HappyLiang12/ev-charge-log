var LOG_COLUMNS = [
  'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec',
  'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source',
  'evidenceUrl', 'suggestedCar', 'suggestionConfidence', 'suggestionPlate',
  'suggestionStatus', 'identifiedAt',
];
var SNAPSHOTS_COLUMNS = [
  'id', 'capturedAt', 'driveFileId', 'driveUrl', 'width', 'height',
  'bytes', 'source', 'createdAt',
];
var PLATES_COLUMNS = ['plate', 'car', 'active', 'createdAt'];
var CARS_COLUMNS = ['id', 'name', 'active', 'createdAt', 'peakFactor'];
var RATES_COLUMNS = [
  'month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate',
  'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride',
];

function sheetId_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Missing SHEET_ID script property (Project Settings -> Script Properties)');
  return String(id).trim();
}

function sheetUrl_() {
  return 'https://docs.google.com/spreadsheets/d/' + sheetId_() + '/edit';
}

function openSpreadsheet_() {
  return SpreadsheetApp.openById(sheetId_());
}

function headerRow_(sheet) {
  var lastColumn = sheet.getLastColumn();
  if (!lastColumn) return [];
  return sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(function (value) { return String(value || '').trim(); });
}

function ensureHeader_(sheet, columns) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    sheet.setFrozenRows(1);
    return;
  }
  var header = headerRow_(sheet);
  var missing = columns.filter(function (column) { return header.indexOf(column) === -1; });
  if (!missing.length) return;
  sheet.getRange(1, sheet.getLastColumn() + 1, 1, missing.length).setValues([missing]);
}

function sheetNamed_(spreadsheet, name, columns) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  ensureHeader_(sheet, columns);
  return sheet;
}

function readObjects_(sheet, columns) {
  ensureHeader_(sheet, columns);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0].map(function (value) { return String(value || '').trim(); });
  var objects = [];
  for (var i = 1; i < values.length; i += 1) {
    var row = values[i];
    var empty = true;
    for (var j = 0; j < row.length; j += 1) {
      if (String(row[j] === undefined || row[j] === null ? '' : row[j]).trim() !== '') {
        empty = false;
        break;
      }
    }
    if (empty) continue;
    var object = {};
    for (var k = 0; k < header.length; k += 1) object[header[k]] = row[k];
    objects.push(object);
  }
  return objects;
}

function logValue_(record, column) {
  if (column === '日期') return record.date;
  if (column === '時間') return record.time;
  return record[column];
}

function isDateValue_(value) {
  return value && typeof value.getTime === 'function' && typeof value.getUTCFullYear === 'function'
    && !isNaN(value.getTime());
}

function isoValue_(value) {
  if (isDateValue_(value)) return value.toISOString();
  var text = String(value || '').trim();
  return validIso_(text) ? text : '';
}

function monthValue_(value) {
  if (isDateValue_(value)) {
    // Date-only Sheet cells are midnight in the spreadsheet timezone; shift
    // into the same calendar day before reading UTC parts.
    var shifted = new Date(value.getTime() + 12 * 60 * 60 * 1000);
    return shifted.getUTCFullYear() + '-' + pad2_(shifted.getUTCMonth() + 1);
  }
  return String(value || '').trim();
}

function hmValue_(value) {
  if (isDateValue_(value)) {
    // Time-only Sheet cells are stored at the 1899 epoch, where Hong Kong's
    // historical offset was not UTC+08:00. Format in the billing timezone
    // rather than adding a fixed offset.
    var formatted = Utilities.formatDate(value, 'Asia/Hong_Kong', 'HH:mm');
    return parseHm_(formatted) === null ? '' : formatted;
  }
  var text = String(value || '').trim();
  return parseHm_(text) === null ? '' : text;
}

function normalizeLogRow_(row) {
  var car = row.car ? String(row.car).trim() : '';
  var source = row.source ? String(row.source).trim() : (car ? 'manual' : 'legacy');
  var startAt = isoValue_(row.startAt);
  return {
    id: String(row.id || '').trim(),
    car: car,
    startAt: startAt,
    date: validIso_(startAt) ? hkDateString_(startAt) : String(row['日期'] || '').trim(),
    time: validIso_(startAt) ? hkTimeString_(startAt) : String(row['時間'] || '').trim(),
    kWh: numberOrNull_(row.kWh),
    durationSec: numberOrNull_(row.durationSec),
    teslaStartAt: isoValue_(row.teslaStartAt) || null,
    teslaEndAt: isoValue_(row.teslaEndAt) || null,
    peakKWh: numberOrNull_(row.peakKWh),
    offPeakKWh: numberOrNull_(row.offPeakKWh),
    teslaKey: row.teslaKey ? String(row.teslaKey) : null,
    source: source,
    evidenceUrl: String(row.evidenceUrl || '').trim(),
    suggestedCar: String(row.suggestedCar || '').trim(),
    suggestionConfidence: numberOrNull_(row.suggestionConfidence),
    suggestionPlate: String(row.suggestionPlate || '').trim(),
    suggestionStatus: String(row.suggestionStatus || '').trim(),
    identifiedAt: isoValue_(row.identifiedAt) || null,
  };
}

function readLog_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Log', LOG_COLUMNS);
  var rows = readObjects_(sheet, LOG_COLUMNS);
  var records = [];
  for (var i = 0; i < rows.length; i += 1) {
    var record = normalizeLogRow_(rows[i]);
    if (!record.id || !validIso_(record.startAt)) continue;
    records.push(record);
  }
  return records;
}

function appendLog_(record) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Log', LOG_COLUMNS);
  var row = headerRow_(sheet).map(function (column) {
    var value = logValue_(record, column);
    return value === undefined || value === null ? '' : value;
  });
  sheet.appendRow(row);
}

function updateLog_(id, patch) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Log', LOG_COLUMNS);
  var values = sheet.getDataRange().getValues();
  if (!values.length) return null;
  var header = values[0].map(function (value) { return String(value || '').trim(); });
  var idCol = header.indexOf('id');
  if (idCol === -1) return null;
  for (var i = 1; i < values.length; i += 1) {
    if (String(values[i][idCol] || '') !== String(id)) continue;
    var current = {};
    for (var j = 0; j < header.length; j += 1) current[header[j]] = values[i][j];
    if (!current.date && current['日期']) current.date = current['日期'];
    if (!current.time && current['時間']) current.time = current['時間'];
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) current[key] = patch[key];
    }
    if (!current.date && validIso_(current.startAt)) current.date = hkDateString_(current.startAt);
    if (!current.time && validIso_(current.startAt)) current.time = hkTimeString_(current.startAt);
    var row = header.map(function (column) {
      var value = logValue_(current, column);
      return value === undefined || value === null ? '' : value;
    });
    sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
    return normalizeLogRow_(current);
  }
  return null;
}

function deleteLog_(id) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Log', LOG_COLUMNS);
  var values = sheet.getDataRange().getValues();
  if (!values.length) return false;
  var header = values[0].map(function (value) { return String(value || '').trim(); });
  var idCol = header.indexOf('id');
  if (idCol === -1) return false;
  for (var i = 1; i < values.length; i += 1) {
    if (String(values[i][idCol] || '') === String(id)) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

function normalizeCarRow_(row) {
  var id = String(row.id || '').trim();
  var name = String(row.name || '').trim();
  if (!validCarId_(id) || !name || id === 'unassigned') return null;
  return {
    id: id,
    name: name,
    active: String(row.active).toUpperCase() !== 'FALSE' && row.active !== false,
    peakFactor: clampedPeakFactor_(row.peakFactor),
  };
}

function readCars_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Cars', CARS_COLUMNS);
  var rows = readObjects_(sheet, CARS_COLUMNS);
  var cars = [];
  for (var i = 0; i < rows.length; i += 1) {
    var car = normalizeCarRow_(rows[i]);
    if (car) cars.push(car);
  }
  return cars;
}

function updateCarPeakFactor_(carId, factor) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Cars', CARS_COLUMNS);
  var values = sheet.getDataRange().getValues();
  if (!values.length) return false;
  var header = values[0].map(function (value) { return String(value || '').trim(); });
  var idCol = header.indexOf('id');
  var factorCol = header.indexOf('peakFactor');
  if (idCol === -1 || factorCol === -1) return false;
  var next = clampedPeakFactor_(factor);
  for (var i = 1; i < values.length; i += 1) {
    if (String(values[i][idCol] || '').trim() !== String(carId)) continue;
    if (clampedPeakFactor_(values[i][factorCol]) !== next) {
      sheet.getRange(i + 1, factorCol + 1).setValues([[next]]);
    }
    return true;
  }
  return false;
}

function cellNumberEquals_(cell, value) {
  if (cell === '' || cell === null || cell === undefined) return false;
  return Number(cell) === Number(value);
}

function updateLogSplits_(updates) {
  if (!updates) return 0;
  var sheet = sheetNamed_(openSpreadsheet_(), 'Log', LOG_COLUMNS);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;
  var header = values[0].map(function (value) { return String(value || '').trim(); });
  var idCol = header.indexOf('id');
  var peakCol = header.indexOf('peakKWh');
  var offCol = header.indexOf('offPeakKWh');
  if (idCol === -1 || peakCol === -1 || offCol === -1) return 0;
  var changed = 0;
  for (var i = 1; i < values.length; i += 1) {
    var update = updates[String(values[i][idCol] || '').trim()];
    if (!update) continue;
    var peak = update.peakKWh;
    var off = update.offPeakKWh;
    if (peak === undefined || peak === null || off === undefined || off === null) continue;
    if (!cellNumberEquals_(values[i][peakCol], peak) || !cellNumberEquals_(values[i][offCol], off)) {
      values[i][peakCol] = peak;
      values[i][offCol] = off;
      changed += 1;
    }
  }
  if (changed) {
    var peakValues = [];
    var offValues = [];
    for (var r = 1; r < values.length; r += 1) {
      peakValues.push([values[r][peakCol] === undefined || values[r][peakCol] === null ? '' : values[r][peakCol]]);
      offValues.push([values[r][offCol] === undefined || values[r][offCol] === null ? '' : values[r][offCol]]);
    }
    sheet.getRange(2, peakCol + 1, peakValues.length, 1).setValues(peakValues);
    sheet.getRange(2, offCol + 1, offValues.length, 1).setValues(offValues);
  }
  return changed;
}

function normalizeRateRow_(row) {
  var month = monthValue_(row.month);
  if (!validMonth_(month)) return null;
  var basicOffPeak = numberOrNull_(row.basicOffPeak);
  var basicPeak = numberOrNull_(row.basicPeak);
  var fuelAdjustment = numberOrNull_(row.fuelAdjustment);
  if (basicOffPeak === null || basicPeak === null || fuelAdjustment === null) return null;
  var peakStart = hmValue_(row.peakStart) || DEFAULT_PEAK_START_;
  var peakEnd = hmValue_(row.peakEnd) || DEFAULT_PEAK_END_;
  return {
    month: month,
    basicOffPeak: basicOffPeak,
    basicPeak: basicPeak,
    fuelAdjustment: fuelAdjustment,
    rebate: numberOrNull_(row.rebate) || 0,
    peakStart: peakStart,
    peakEnd: peakEnd,
    sourceUrl: String(row.sourceUrl || ''),
    fetchedAt: isoValue_(row.fetchedAt) || String(row.fetchedAt || '').trim(),
    manualOverride: String(row.manualOverride || '').toUpperCase() === 'TRUE',
  };
}

function readRates_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Rates', RATES_COLUMNS);
  var rows = readObjects_(sheet, RATES_COLUMNS);
  var byMonth = {};
  var order = [];
  for (var i = 0; i < rows.length; i += 1) {
    var rate = normalizeRateRow_(rows[i]);
    if (!rate) continue;
    if (!Object.prototype.hasOwnProperty.call(byMonth, rate.month)) {
      byMonth[rate.month] = rate;
      order.push(rate.month);
    } else {
      byMonth[rate.month] = preferRate_(byMonth[rate.month], rate);
    }
  }
  var rates = [];
  for (var j = 0; j < order.length; j += 1) rates.push(byMonth[order[j]]);
  return rates;
}

function preferRate_(current, next) {
  if (next.manualOverride !== current.manualOverride) return next.manualOverride ? next : current;
  var currentAt = Date.parse(current.fetchedAt) || 0;
  var nextAt = Date.parse(next.fetchedAt) || 0;
  return nextAt >= currentAt ? next : current;
}

function rateValue_(rate, column) {
  if (column === 'manualOverride') return rate.manualOverride ? 'TRUE' : 'FALSE';
  var value = rate[column];
  return value === undefined || value === null ? '' : value;
}

function upsertRates_(rates) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Rates', RATES_COLUMNS);
  var values = sheet.getDataRange().getValues();
  var header = values[0].map(function (value) { return String(value || '').trim(); });
  var monthCol = header.indexOf('month');
  var manualCol = header.indexOf('manualOverride');
  var groups = {};
  for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    var rowMonth = monthValue_(values[rowIndex][monthCol]);
    if (!validMonth_(rowMonth)) continue;
    if (!groups[rowMonth]) groups[rowMonth] = [];
    groups[rowMonth].push(rowIndex);
  }
  var toDelete = {};
  var updated = 0;
  for (var r = 0; r < rates.length; r += 1) {
    var rate = rates[r];
    if (!rate || !validMonth_(rate.month)) continue;
    var indices = groups[rate.month] || [];
    var manualIndices = indices.filter(function (index) {
      return String(values[index][manualCol] || '').toUpperCase() === 'TRUE';
    });
    var target = -1;
    if (manualIndices.length) {
      target = manualIndices[manualIndices.length - 1];
      for (var m = 0; m < indices.length; m += 1) {
        if (indices[m] !== target) toDelete[indices[m]] = true;
      }
    } else if (indices.length) {
      target = indices[0];
      for (var n = 1; n < indices.length; n += 1) toDelete[indices[n]] = true;
    }
    if (target < 0) {
      var appended = header.map(function (column) {
        return RATES_COLUMNS.indexOf(column) !== -1 ? rateValue_(rate, column) : '';
      });
      sheet.appendRow(appended);
      values = sheet.getDataRange().getValues();
      groups[rate.month] = [values.length - 1];
      updated += 1;
      continue;
    }
    if (manualIndices.length) continue;
    var row = header.map(function (column, index) {
      if (RATES_COLUMNS.indexOf(column) !== -1) return rateValue_(rate, column);
      var existing = values[target][index];
      return existing === undefined || existing === null ? '' : existing;
    });
    sheet.getRange(target + 1, 1, 1, row.length).setValues([row]);
    updated += 1;
  }
  var deleteRows = Object.keys(toDelete).map(Number).sort(function (a, b) { return b - a; });
  for (var d = 0; d < deleteRows.length; d += 1) sheet.deleteRow(deleteRows[d] + 1);
  return updated;
}

var BILLS_COLUMNS = [
  'periodStart', 'periodEnd', 'cutoff', 'units', 'peakKWh', 'offPeakKWh',
  'energyCharge', 'fuelCharge', 'others', 'total', 'fileName', 'savedAt', 'publishedAt',
];

function validDateOnly_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  var parsed = Date.parse(value + 'T00:00:00+08:00');
  return isFinite(parsed) && new Date(parsed + HK_OFFSET_MS_).toISOString().slice(0, 10) === value;
}

function dateOnlyValue_(value) {
  if (isDateValue_(value)) {
    var shifted = new Date(value.getTime() + 12 * 60 * 60 * 1000);
    var iso = shifted.getUTCFullYear() + '-' + pad2_(shifted.getUTCMonth() + 1) + '-' + pad2_(shifted.getUTCDate());
    return validDateOnly_(iso) ? iso : '';
  }
  var text = String(value === undefined || value === null ? '' : value).trim().slice(0, 10);
  return validDateOnly_(text) ? text : '';
}

function chargeOrNull_(value) {
  var number = numberOrNull_(value);
  if (number === null) return null;
  return Math.abs(number) <= 10000000 ? number : null;
}

function normalizedBillInput_(raw) {
  var bill = raw || {};
  var periodStart = dateOnlyValue_(bill.periodStart);
  var periodEnd = dateOnlyValue_(bill.periodEnd);
  if (!periodStart || !periodEnd || periodStart >= periodEnd) throw new Error('Invalid bill period');
  var startMs = Date.parse(periodStart + 'T00:00:00+08:00');
  var endMs = Date.parse(periodEnd + 'T00:00:00+08:00') + 86400000;
  var cutoffIso = String(bill.cutoff || '').trim();
  if (!validIso_(cutoffIso)) throw new Error('Invalid cutoff');
  var cutoffMs = Date.parse(cutoffIso);
  if (cutoffMs < startMs || cutoffMs > endMs) throw new Error('Cutoff outside bill period');
  var units = numberOrNull_(bill.units);
  if (units === null || units <= 0 || units > 1000000) throw new Error('Invalid bill units');
  var peakKWh = numberOrNull_(bill.peakKWh);
  var offPeakKWh = numberOrNull_(bill.offPeakKWh);
  if (peakKWh !== null && offPeakKWh !== null && Math.abs(peakKWh + offPeakKWh - units) > 1.5) {
    throw new Error('Peak and off-peak units do not add up');
  }
  if (peakKWh === null || offPeakKWh === null) {
    peakKWh = null;
    offPeakKWh = null;
  }
  var total = numberOrNull_(bill.total);
  if (total === null || total <= 0 || total > 10000000) throw new Error('Invalid bill total');
  return {
    periodStart: periodStart,
    periodEnd: periodEnd,
    cutoff: new Date(cutoffMs).toISOString(),
    units: units,
    peakKWh: peakKWh,
    offPeakKWh: offPeakKWh,
    energyCharge: chargeOrNull_(bill.energyCharge),
    fuelCharge: chargeOrNull_(bill.fuelCharge),
    others: chargeOrNull_(bill.others),
    total: total,
    fileName: String(bill.fileName || '').trim().slice(0, 200),
    savedAt: new Date().toISOString(),
  };
}

function normalizeStoredBill_(row) {
  var periodStart = dateOnlyValue_(row.periodStart);
  var periodEnd = dateOnlyValue_(row.periodEnd);
  var units = numberOrNull_(row.units);
  var total = numberOrNull_(row.total);
  if (!periodStart || !periodEnd || !(units > 0) || !(total > 0)) return null;
  var peakKWh = numberOrNull_(row.peakKWh);
  var offPeakKWh = numberOrNull_(row.offPeakKWh);
  if (peakKWh === null || offPeakKWh === null) {
    peakKWh = null;
    offPeakKWh = null;
  }
  var cutoff = isoValue_(row.cutoff);
  return {
    periodStart: periodStart,
    periodEnd: periodEnd,
    cutoff: cutoff || '',
    units: units,
    peakKWh: peakKWh,
    offPeakKWh: offPeakKWh,
    energyCharge: numberOrNull_(row.energyCharge),
    fuelCharge: numberOrNull_(row.fuelCharge),
    others: numberOrNull_(row.others),
    total: total,
    fileName: String(row.fileName || '').trim().slice(0, 200),
    savedAt: isoValue_(row.savedAt) || String(row.savedAt || '').trim(),
    publishedAt: isoValue_(row.publishedAt),
  };
}

function readBills_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Bills', BILLS_COLUMNS);
  var rows = readObjects_(sheet, BILLS_COLUMNS);
  var bills = [];
  for (var i = 0; i < rows.length; i += 1) {
    var bill = normalizeStoredBill_(rows[i]);
    if (bill) bills.push(bill);
  }
  bills.sort(function (a, b) { return b.periodEnd.localeCompare(a.periodEnd); });
  return bills;
}

function upsertBill_(bill) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Bills', BILLS_COLUMNS);
  var values = sheet.getDataRange().getValues();
  var header = values.length
    ? values[0].map(function (value) { return String(value || '').trim(); })
    : BILLS_COLUMNS.slice();
  var startCol = header.indexOf('periodStart');
  var endCol = header.indexOf('periodEnd');
  if (startCol === -1 || endCol === -1) throw new Error('Bills header is missing dates');
  var target = -1;
  for (var i = 1; i < values.length; i += 1) {
    if (dateOnlyValue_(values[i][startCol]) !== bill.periodStart) continue;
    if (dateOnlyValue_(values[i][endCol]) !== bill.periodEnd) continue;
    target = i;
  }
  var row = header.map(function (column) {
    var value = bill[column];
    return value === undefined || value === null ? '' : value;
  });
  if (target === -1) sheet.appendRow(row);
  else sheet.getRange(target + 1, 1, 1, row.length).setValues([row]);
  return normalizeStoredBill_(row.reduce(function (object, value, index) {
    object[header[index]] = value;
    return object;
  }, {}));
}

function updateBillPublished_(periodStart, periodEnd, publishedAt) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Bills', BILLS_COLUMNS);
  var values = sheet.getDataRange().getValues();
  var header = values.length
    ? values[0].map(function (value) { return String(value || '').trim(); })
    : BILLS_COLUMNS.slice();
  var startCol = header.indexOf('periodStart');
  var endCol = header.indexOf('periodEnd');
  var publishedCol = header.indexOf('publishedAt');
  if (startCol === -1 || endCol === -1 || publishedCol === -1) {
    throw new Error('Bills header is missing columns');
  }
  for (var i = 1; i < values.length; i += 1) {
    if (dateOnlyValue_(values[i][startCol]) !== periodStart) continue;
    if (dateOnlyValue_(values[i][endCol]) !== periodEnd) continue;
    var rowValues = values[i].slice();
    while (rowValues.length < header.length) rowValues.push('');
    rowValues[publishedCol] = publishedAt || '';
    sheet.getRange(i + 1, 1, 1, header.length).setValues([rowValues]);
    var object = {};
    for (var k = 0; k < header.length; k += 1) object[header[k]] = rowValues[k];
    return normalizeStoredBill_(object);
  }
  throw new Error('Unknown bill period');
}

function readSnapshots_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Snapshots', SNAPSHOTS_COLUMNS);
  return readObjects_(sheet, SNAPSHOTS_COLUMNS).map(function (row) {
    return {
      id: String(row.id || '').trim(),
      capturedAt: isoValue_(row.capturedAt) || String(row.capturedAt || '').trim(),
      driveFileId: String(row.driveFileId || '').trim(),
      driveUrl: String(row.driveUrl || '').trim(),
      width: numberOrNull_(row.width),
      height: numberOrNull_(row.height),
      bytes: numberOrNull_(row.bytes),
      source: String(row.source || '').trim(),
      createdAt: isoValue_(row.createdAt) || String(row.createdAt || '').trim(),
    };
  }).filter(function (row) { return row.id && validIso_(row.capturedAt); });
}

function appendSnapshot_(snapshot) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Snapshots', SNAPSHOTS_COLUMNS);
  var row = headerRow_(sheet).map(function (column) {
    var value = snapshot[column];
    return value === undefined || value === null ? '' : value;
  });
  sheet.appendRow(row);
}

function readPlates_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Plates', PLATES_COLUMNS);
  return readObjects_(sheet, PLATES_COLUMNS).map(function (row) {
    return {
      plate: normalizePlate_(row.plate),
      car: String(row.car || '').trim(),
      active: String(row.active).toUpperCase() !== 'FALSE' && row.active !== false,
    };
  }).filter(function (row) { return row.plate && validCarId_(row.car) && row.active; });
}

var CONFIG_COLUMNS = ['key', 'value', 'updatedAt', 'notes'];
var CONFIG_DEFAULTS = {
  'relay.enabled': 'true',
  'relay.intervalSeconds': '300',
  'relay.imageWidth': '1920',
  'relay.jpegQuality': '3',
  'relay.crop': '',
  'relay.captureTimeoutSeconds': '30',
  'relay.maxQueue': '1000',
  'relay.cleanupIntervalSeconds': '3600',
  'relay.cleanupBatch': '500',
  'snapshot.retentionDays': '30',
  'snapshot.windowMinutes': '10',
  'snapshot.candidateCount': '3',
  'vision.engine': 'plate',
  'vision.minConfidence': '0.8',
  'vision.maxPerSync': '5',
  'vision.vlmModel': '',
  'policy.minSamples': '5',
  'policy.minPrecision': '0.9',
};

function readConfigMap_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Config', CONFIG_COLUMNS);
  var map = {};
  var latest = '';
  var rows = readObjects_(sheet, CONFIG_COLUMNS);
  for (var i = 0; i < rows.length; i += 1) {
    var key = String(rows[i].key || '').trim();
    if (!key) continue;
    map[key] = String(rows[i].value === undefined || rows[i].value === null ? '' : rows[i].value).trim();
    var at = isoValue_(rows[i].updatedAt);
    if (at && at > latest) latest = at;
  }
  return { values: map, updatedAt: latest || new Date().toISOString() };
}

function configValue_(key) {
  var map = readConfigMap_().values;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : CONFIG_DEFAULTS[key];
}

function ensureConfigDefaults_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Config', CONFIG_COLUMNS);
  var rows = readObjects_(sheet, CONFIG_COLUMNS);
  var existing = {};
  for (var i = 0; i < rows.length; i += 1) existing[String(rows[i].key || '').trim()] = true;
  var now = new Date().toISOString();
  for (var key in CONFIG_DEFAULTS) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key) || existing[key]) continue;
    sheet.appendRow([key, CONFIG_DEFAULTS[key], now, 'default']);
  }
}
