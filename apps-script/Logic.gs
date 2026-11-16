var HK_OFFSET_MS_ = 8 * 60 * 60 * 1000;
var DEFAULT_PEAK_START_ = '16:00';
var DEFAULT_PEAK_END_ = '23:00';

function pad2_(value) {
  return ('0' + value).slice(-2);
}

function round6_(value) {
  return Math.round(value * 1e6) / 1e6;
}

function numberOrNull_(value) {
  if (value === null || value === undefined || value === '') return null;
  var n = Number(value);
  return isFinite(n) ? n : null;
}

function validIso_(value) {
  return typeof value === 'string' && !isNaN(Date.parse(value));
}

function validMonth_(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function validCarId_(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value);
}

function hkDateString_(iso) {
  var d = new Date(Date.parse(iso) + HK_OFFSET_MS_);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

function hkTimeString_(iso) {
  var d = new Date(Date.parse(iso) + HK_OFFSET_MS_);
  return pad2_(d.getUTCHours()) + ':' + pad2_(d.getUTCMinutes());
}

function hkMonth_(iso) {
  return hkDateString_(iso).slice(0, 7);
}

function parseHm_(value) {
  var match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function overlapPeakSeconds_(startSec, endSec, peakStartSec, peakEndSec) {
  if (endSec <= startSec || peakStartSec === peakEndSec) return 0;
  if (peakStartSec < peakEndSec) {
    return Math.max(0, Math.min(endSec, peakEndSec) - Math.max(startSec, peakStartSec));
  }
  return Math.max(0, Math.min(endSec, 86400) - Math.max(startSec, peakStartSec))
    + Math.max(0, Math.min(endSec, peakEndSec) - Math.max(startSec, 0));
}

function splitPeakKwh_(startIso, durationSec, kwh, peakStart, peakEnd) {
  var duration = Math.max(0, Math.floor(Number(durationSec) || 0));
  var energy = Math.max(0, Number(kwh) || 0);
  if (!energy) return { peakKWh: 0, offPeakKWh: 0 };
  if (!duration || !validIso_(startIso)) {
    return { peakKWh: 0, offPeakKWh: round6_(energy) };
  }
  var startMinutes = parseHm_(peakStart);
  var endMinutes = parseHm_(peakEnd);
  var peakStartSec = (startMinutes == null ? parseHm_(DEFAULT_PEAK_START_) : startMinutes) * 60;
  var peakEndSec = (endMinutes == null ? parseHm_(DEFAULT_PEAK_END_) : endMinutes) * 60;
  var localStart = Date.parse(startIso) + HK_OFFSET_MS_;
  var localEnd = localStart + duration * 1000;
  var cursor = localStart;
  var peakSeconds = 0;
  while (cursor < localEnd) {
    var dayStart = Math.floor(cursor / 86400000) * 86400000;
    var dayEnd = dayStart + 86400000;
    var segmentEnd = Math.min(localEnd, dayEnd);
    var sodStart = (cursor - dayStart) / 1000;
    var sodEnd = (segmentEnd - dayStart) / 1000;
    peakSeconds += overlapPeakSeconds_(sodStart, sodEnd, peakStartSec, peakEndSec);
    cursor = segmentEnd;
  }
  var peakKWh = energy * (peakSeconds / duration);
  return { peakKWh: round6_(peakKWh), offPeakKWh: round6_(energy - peakKWh) };
}

function manualCandidatesForSession_(session, manualRows, options) {
  var start = Date.parse(session && (session.startAt || session.teslaStartAt));
  if (isNaN(start)) return [];
  var end = Date.parse(session && (session.endAt || session.teslaEndAt));
  if (isNaN(end) && Number(session && session.durationSec) > 0) {
    end = start + Number(session.durationSec) * 1000;
  }
  var hasEnd = !isNaN(end);
  if (hasEnd && end < start) end = start;
  var opts = options || {};
  var earlyMs = opts.earlyMs == null ? 120 * 60 * 1000 : Math.max(0, Number(opts.earlyMs) || 0);
  var lateMs = opts.lateMs == null ? 30 * 60 * 1000 : Math.max(0, Number(opts.lateMs) || 0);
  var fallbackWindowMs = opts.fallbackWindowMs == null
    ? 30 * 60 * 1000
    : Math.max(0, Number(opts.fallbackWindowMs) || 0);
  var candidates = [];
  for (var i = 0; i < (manualRows || []).length; i++) {
    var row = manualRows[i];
    if (!row || row.source !== 'manual' || !row.car || row.car === 'unassigned') continue;
    if (row.kWh != null || row.teslaKey) continue;
    var manualStart = Date.parse(row.startAt);
    if (isNaN(manualStart)) continue;
    var distance;
    if (hasEnd) {
      if (manualStart < start - earlyMs || manualStart > end + lateMs) continue;
      if (manualStart < start) distance = start - manualStart;
      else if (manualStart > end) distance = manualStart - end;
      else distance = 0;
    } else {
      distance = Math.abs(manualStart - start);
      if (distance > fallbackWindowMs) continue;
    }
    candidates.push({ row: row, distance: distance });
  }
  candidates.sort(function (a, b) {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return String(a.row.id) < String(b.row.id) ? -1 : (String(a.row.id) > String(b.row.id) ? 1 : 0);
  });
  return candidates;
}

function closestManualForSession_(session, manualRows, options) {
  var candidates = manualCandidatesForSession_(session, manualRows, options);
  if (!candidates.length) return { candidate: null, ambiguous: false };
  var cars = {};
  for (var i = 0; i < candidates.length; i += 1) cars[candidates[i].row.car] = true;
  if (Object.keys(cars).length > 1) return { candidate: null, ambiguous: true };
  return { candidate: candidates[0].row, ambiguous: false };
}

function normalizeClpText_(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function parseFuelAdjustmentPage_(text) {
  var source = normalizeClpText_(text);
  var current = source.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*1\s*日起[，,\s]*燃料調整費為[^\d]{0,20}(\d+(?:\.\d+)?)\s*港仙/);
  if (!current) return { current: null, rows: [] };
  var year = Number(current[1]);
  var month = Number(current[2]);
  var cents = Number(current[3]);
  if (month < 1 || month > 12 || cents < 0 || cents > 200) return { current: null, rows: [] };
  var section = '';
  var sectionStart = source.indexOf('每月燃料調整費');
  if (sectionStart !== -1) {
    var rest = source.slice(sectionStart);
    // Trailing text after the current-rate sentence must not extend the table:
    // bound it at the sentence, a following yearly table, or the next section.
    var stop = rest.search(/\d{4}年\d{1,2}月\d{1,2}日起|本月調整計算|\d{4}年每月燃料調整費|備註|由\d{4}年/);
    section = stop === -1 ? rest : rest.slice(0, stop);
  }
  var months = [];
  var monthMatches = section.matchAll(/(\d{1,2})月/g);
  for (var m = monthMatches.next(); !m.done; m = monthMatches.next()) {
    months.push(Number(m.value[1]));
  }
  var values = [];
  var valueMatches = section.matchAll(/(?:^|\n)\s*(\d{1,3}(?:\.\d+)?)\*?\s*(?=\n|$)/g);
  for (var v = valueMatches.next(); !v.done; v = valueMatches.next()) {
    values.push(Number(v.value[1]));
  }
  if (months.length !== values.length) return { current: null, rows: [] };
  var rows = [];
  var count = Math.min(months.length, values.length);
  var byMonth = {};
  var order = [];
  for (var i = 0; i < count; i++) {
    var monthKey = year + '-' + pad2_(months[i]);
    if (Object.prototype.hasOwnProperty.call(byMonth, monthKey)) continue;
    byMonth[monthKey] = values[i];
    order.push(monthKey);
  }
  var key = year + '-' + pad2_(month);
  byMonth[key] = cents;
  if (order.indexOf(key) === -1) order.push(key);
  for (var j = 0; j < order.length; j++) {
    rows.push({ month: order[j], fuelAdjustment: byMonth[order[j]] });
  }
  return { current: { month: key, fuelAdjustment: cents }, rows: rows };
}

function parseTariffPage_(text) {
  var source = normalizeClpText_(text);
  var off = source.match(/(?:^|\n)\s*非高峰用電時間[\s\S]{0,500}?(\d{1,3}\.\d+)/);
  var peak = source.match(/(?:^|\n)\s*高峰用電時間[\s\S]{0,500}?(\d{1,3}\.\d+)/);
  if (!off || !peak) return null;
  return {
    basicOffPeak: Number(off[1]),
    basicPeak: Number(peak[1]),
    peakStart: DEFAULT_PEAK_START_,
    peakEnd: DEFAULT_PEAK_END_,
  };
}

function validateParsedRates_(fuel, tariff) {
  var current = fuel && fuel.current;
  var rows = (fuel && fuel.rows) || [];
  if (!current || !tariff || !rows.length) throw new Error('CLP rate parse failed');
  if (!validMonth_(current.month)) throw new Error('CLP fuel month is invalid');
  if (!isFinite(current.fuelAdjustment) || current.fuelAdjustment < 0 || current.fuelAdjustment > 200) {
    throw new Error('CLP fuel adjustment is outside 0-200 cents');
  }
  if (!isFinite(tariff.basicOffPeak) || tariff.basicOffPeak <= 0 || tariff.basicOffPeak > 500) {
    throw new Error('CLP off-peak rate is outside 0-500 cents');
  }
  if (!isFinite(tariff.basicPeak) || tariff.basicPeak <= 0 || tariff.basicPeak > 500) {
    throw new Error('CLP peak rate is outside 0-500 cents');
  }
  if (tariff.basicPeak <= tariff.basicOffPeak) {
    throw new Error('CLP peak rate must exceed off-peak');
  }
  if (rows.length > 12) throw new Error('CLP fuel table has too many months');
  var seen = {};
  var hasCurrent = false;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!validMonth_(row.month) || Object.prototype.hasOwnProperty.call(seen, row.month)) {
      throw new Error('CLP fuel table has an invalid or duplicate month');
    }
    if (!isFinite(row.fuelAdjustment) || row.fuelAdjustment < 0 || row.fuelAdjustment > 200) {
      throw new Error('CLP fuel adjustment is outside 0-200 cents');
    }
    seen[row.month] = true;
    if (row.month === current.month) {
      hasCurrent = true;
      if (row.fuelAdjustment !== current.fuelAdjustment) {
        throw new Error('CLP fuel table does not match the current month');
      }
    }
  }
  if (!hasCurrent) throw new Error('CLP fuel table is missing the current month');
  return true;
}
