var LOG_COLUMNS = [
  'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec',
  'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source',
];
var CARS_COLUMNS = ['id', 'name', 'active', 'createdAt'];
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
