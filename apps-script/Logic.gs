var HK_OFFSET_MS_ = 8 * 60 * 60 * 1000;
var DEFAULT_PEAK_START_ = '16:00';
var DEFAULT_PEAK_END_ = '23:00';
var PEAK_FACTOR_STEPS_ = [0, 0.25, 0.5, 0.75, 1];
var PEAK_FACTOR_NON_BINARY_COST_ = 16;
var PEAK_FIT_MIN_RMSE_ = 4;
var PEAK_FIT_IMPROVEMENT_RATIO_ = 0.5;

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

function clampedPeakFactor_(value) {
  if (value === null || value === undefined || value === '') return 1;
  var factor = Number(value);
  if (!isFinite(factor)) return 1;
  return Math.max(0, Math.min(1, factor));
}

function splitPeakKwh_(startIso, durationSec, kwh, peakStart, peakEnd, factor) {
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
  var peakKWh = energy * (peakSeconds / duration) * clampedPeakFactor_(factor);
  return { peakKWh: round6_(peakKWh), offPeakKWh: round6_(energy - peakKWh) };
}

function carPeakFactorMap_(cars) {
  var map = {};
  for (var i = 0; i < (cars || []).length; i += 1) {
    var car = cars[i];
    if (!car || !car.id) continue;
    map[car.id] = clampedPeakFactor_(car.peakFactor);
  }
  return map;
}

function peakFactorFor_(factors, carId) {
  if (!factors || !Object.prototype.hasOwnProperty.call(factors, carId)) return 1;
  return clampedPeakFactor_(factors[carId]);
}

function predictedPeakKWh_(byCar, factors) {
  var total = 0;
  for (var carId in byCar) {
    if (Object.prototype.hasOwnProperty.call(byCar, carId)) {
      total += byCar[carId] * peakFactorFor_(factors, carId);
    }
  }
  return total;
}

function peakFitLoss_(periods, factors) {
  var sse = 0;
  var nonBinary = 0;
  for (var i = 0; i < periods.length; i += 1) {
    var diff = predictedPeakKWh_(periods[i].byCar, factors) - periods[i].actualPeakKWh;
    sse += diff * diff;
  }
  for (var carId in factors) {
    if (Object.prototype.hasOwnProperty.call(factors, carId)) {
      var factor = factors[carId];
      if (factor > 0 && factor < 1) nonBinary += 1;
    }
  }
  return {
    sse: sse,
    rmse: Math.sqrt(sse / Math.max(1, periods.length)),
    score: sse + nonBinary * PEAK_FACTOR_NON_BINARY_COST_,
  };
}

function fitPeakFactors_(periods, currentFactors) {
  var usable = (periods || []).filter(function (period) {
    return period && isFinite(Number(period.actualPeakKWh)) && period.byCar;
  });
  var carIds = [];
  var seen = {};
  for (var i = 0; i < usable.length; i += 1) {
    for (var carId in usable[i].byCar) {
      if (!Object.prototype.hasOwnProperty.call(usable[i].byCar, carId)) continue;
      if (!(Number(usable[i].byCar[carId]) > 0) || seen[carId]) continue;
      seen[carId] = true;
      carIds.push(carId);
    }
  }
  carIds.sort();
  var current = {};
  for (var c = 0; c < carIds.length; c += 1) {
    current[carIds[c]] = peakFactorFor_(currentFactors, carIds[c]);
  }
  var currentLoss = peakFitLoss_(usable, current);
  if (!usable.length || !carIds.length) {
    return {
      applied: false,
      factors: current,
      currentRmse: round6_(currentLoss.rmse),
      bestRmse: round6_(currentLoss.rmse),
      billsUsed: usable.length,
      periods: [],
    };
  }

  var best = null;
  function consider(factors) {
    var loss = peakFitLoss_(usable, factors);
    if (!best) {
      best = { factors: factors, loss: loss };
      return;
    }
    if (loss.score < best.loss.score - 1e-9) {
      best = { factors: factors, loss: loss };
      return;
    }
    if (loss.score > best.loss.score + 1e-9) return;
    if (loss.sse < best.loss.sse - 1e-9) {
      best = { factors: factors, loss: loss };
      return;
    }
    if (loss.sse > best.loss.sse + 1e-9) return;
    var changed = 0;
    var bestChanged = 0;
    for (var k = 0; k < carIds.length; k += 1) {
      if (factors[carIds[k]] !== current[carIds[k]]) changed += 1;
      if (best.factors[carIds[k]] !== current[carIds[k]]) bestChanged += 1;
    }
    if (changed < bestChanged) best = { factors: factors, loss: loss };
  }

  if (carIds.length <= 4) {
    var combo = {};
    var walk = function (index) {
      if (index === carIds.length) {
        var copy = {};
        for (var k = 0; k < carIds.length; k += 1) copy[carIds[k]] = combo[carIds[k]];
        consider(copy);
        return;
      }
      for (var v = 0; v < PEAK_FACTOR_STEPS_.length; v += 1) {
        combo[carIds[index]] = PEAK_FACTOR_STEPS_[v];
        walk(index + 1);
      }
    };
    walk(0);
  } else {
    var factors = {};
    for (var f = 0; f < carIds.length; f += 1) factors[carIds[f]] = current[carIds[f]];
    var rounds = 0;
    var improved = true;
    while (improved && rounds < 3) {
      improved = false;
      rounds += 1;
      for (var g = 0; g < carIds.length; g += 1) {
        var carId = carIds[g];
        var bestValue = factors[carId];
        var bestLoss = peakFitLoss_(usable, factors);
        for (var s = 0; s < PEAK_FACTOR_STEPS_.length; s += 1) {
          var trial = {};
          for (var t = 0; t < carIds.length; t += 1) trial[carIds[t]] = factors[carIds[t]];
          trial[carId] = PEAK_FACTOR_STEPS_[s];
          var trialLoss = peakFitLoss_(usable, trial);
          if (trialLoss.score < bestLoss.score - 1e-9) {
            bestValue = trial[carId];
            bestLoss = trialLoss;
          }
        }
        if (bestValue !== factors[carId]) {
          factors[carId] = bestValue;
          improved = true;
        }
      }
    }
    best = { factors: factors, loss: peakFitLoss_(usable, factors) };
  }

  var apply = currentLoss.rmse >= PEAK_FIT_MIN_RMSE_
    && best.loss.rmse <= currentLoss.rmse * PEAK_FIT_IMPROVEMENT_RATIO_;
  var applied = apply ? best.factors : current;
  var output = [];
  for (var p = 0; p < usable.length; p += 1) {
    output.push({
      label: usable[p].label || '',
      actualPeakKWh: Number(usable[p].actualPeakKWh),
      predictedPeakKWh: round6_(predictedPeakKWh_(usable[p].byCar, applied)),
    });
  }
  return {
    applied: apply,
    factors: applied,
    currentRmse: round6_(currentLoss.rmse),
    bestRmse: round6_(best.loss.rmse),
    billsUsed: usable.length,
    periods: output,
  };
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

function billAllocation_(bill, records, cars) {
  var startMs = Date.parse(bill.periodStart + 'T00:00:00+08:00');
  var cutoffMs = Date.parse(bill.cutoff);
  if (!isFinite(startMs) || !isFinite(cutoffMs)) throw new Error('Invalid bill period');
  var names = {};
  for (var i = 0; i < (cars || []).length; i += 1) {
    var car = cars[i];
    if (car && car.id) names[car.id] = car.name || car.id;
  }
  var totals = {};
  var loggedKWh = 0;
  var unassignedCount = 0;
  var unassignedKWh = 0;
  for (var r = 0; r < (records || []).length; r += 1) {
    var record = records[r];
    var at = Date.parse(record.startAt);
    if (!isFinite(at) || at < startMs || at >= cutoffMs) continue;
    if (record.car === 'unassigned') {
      unassignedCount += 1;
      unassignedKWh += Math.max(0, Number(record.kWh) || 0);
      continue;
    }
    if (record.kWh === null || record.kWh === undefined) continue;
    if (!record.car) continue;
    var energy = Math.max(0, Number(record.kWh) || 0);
    if (!totals[record.car]) totals[record.car] = { id: record.car, kWh: 0, sessions: 0 };
    totals[record.car].kWh += energy;
    totals[record.car].sessions += 1;
    loggedKWh += energy;
  }
  var rows = [];
  for (var carId in totals) {
    if (!Object.prototype.hasOwnProperty.call(totals, carId)) continue;
    var entry = totals[carId];
    rows.push({
      id: entry.id,
      name: names[entry.id] || entry.id,
      kWh: round6_(entry.kWh),
      sessions: entry.sessions,
      share: loggedKWh > 0 ? round6_(entry.kWh / loggedKWh) : 0,
      amount: loggedKWh > 0 ? round6_(entry.kWh / loggedKWh * Number(bill.total || 0)) : 0,
    });
  }
  rows.sort(function (a, b) { return b.kWh - a.kWh; });
  return {
    loggedKWh: round6_(loggedKWh),
    unassignedCount: unassignedCount,
    unassignedKWh: round6_(unassignedKWh),
    rows: rows,
  };
}

function normalizePlate_(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function nearestSnapshot_(startIso, snapshots, windowMs) {
  var target = Date.parse(startIso);
  if (isNaN(target)) return null;
  var best = null;
  var bestDelta = Infinity;
  for (var i = 0; i < (snapshots || []).length; i += 1) {
    var row = snapshots[i];
    var at = Date.parse(row.capturedAt);
    if (isNaN(at)) continue;
    var delta = Math.abs(at - target);
    if (delta > windowMs) continue;
    if (delta < bestDelta || (delta === bestDelta && best && String(row.id) < String(best.id))) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}
