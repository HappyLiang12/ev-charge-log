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

function closestManualCandidate_(sessionStartIso, manualRows, windowMs) {
  var target = Date.parse(sessionStartIso);
  if (isNaN(target)) return null;
  var best = null;
  var bestDelta = Infinity;
  for (var i = 0; i < (manualRows || []).length; i++) {
    var row = manualRows[i];
    if (!row || row.source !== 'manual' || !row.car || row.car === 'unassigned') continue;
    if (row.kWh != null || row.teslaKey) continue;
    var start = Date.parse(row.startAt);
    if (isNaN(start)) continue;
    var delta = Math.abs(start - target);
    if (delta > windowMs) continue;
    if (delta < bestDelta || (delta === bestDelta && best && String(row.id) < String(best.id))) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}

function parseFuelAdjustmentPage_(text) {
  var source = String(text || '').replace(/\*\*/g, '');
  var current = source.match(/(\d{4})年(\d{1,2})月1日起，燃料調整費為每度電([\d.]+)港仙/);
  if (!current) return { current: null, rows: [] };
  var year = Number(current[1]);
  var month = Number(current[2]);
  var cents = Number(current[3]);
  var section = '';
  var sectionStart = source.indexOf('每月燃料調整費');
  if (sectionStart !== -1) {
    var rest = source.slice(sectionStart);
    // Trailing text after the current-rate sentence must not extend the table:
    // bound it at the sentence, a following yearly table, or the next section.
    var stop = rest.search(/\d{4}年\d{1,2}月\d{1,2}日起|本月調整計算|\d{4}年每月燃料調整費/);
    section = stop === -1 ? rest : rest.slice(0, stop);
  }
  var months = [];
  var monthMatches = section.matchAll(/(\d{1,2})月/g);
  for (var m = monthMatches.next(); !m.done; m = monthMatches.next()) {
    months.push(Number(m.value[1]));
  }
  var values = [];
  var valueMatches = section.matchAll(/(?:^|\n)\s*(\d{2}\.\d)\*?\s*(?=\n|$)/g);
  for (var v = valueMatches.next(); !v.done; v = valueMatches.next()) {
    values.push(Number(v.value[1]));
  }
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
  var source = String(text || '');
  var off = source.match(/(?:^|\n)\s*非高峰用電時間[\s\S]{0,300}?(\d{2,3}\.\d)/);
  var peak = source.match(/(?:^|\n)\s*高峰用電時間[\s\S]{0,300}?(\d{2,3}\.\d)/);
  if (!off || !peak) return null;
  return {
    basicOffPeak: Number(off[1]),
    basicPeak: Number(peak[1]),
    peakStart: DEFAULT_PEAK_START_,
    peakEnd: DEFAULT_PEAK_END_,
  };
}
