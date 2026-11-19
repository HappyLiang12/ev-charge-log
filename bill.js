const HK_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function hkDateFromParts(day, month, year) {
  const fullYear = year < 100 ? 2000 + year : year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${fullYear}-${pad2(month)}-${pad2(day)}`;
  const at = Date.parse(`${iso}T00:00:00+08:00`);
  if (!Number.isFinite(at)) return null;
  return iso;
}

function moneyOf(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/[,\s]/g, '').replace('−', '-').replace('$', '');
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function numbersIn(line) {
  const matches = String(line).match(/-?\d[\d,]*(?:\.\d+)?/g) || [];
  return matches.map((text) => Number(text.replace(/,/g, ''))).filter(Number.isFinite);
}

function moneyTokens(line) {
  const matches = String(line).match(/-?\$?\s*\d[\d,]*(?:\.\d{2})?/g) || [];
  return matches
    .filter((match) => /\.\d{2}/.test(match))
    .map((match) => moneyOf(match))
    .filter((value) => value !== null);
}

function isInteger(value) {
  return Number.isInteger(value);
}

function lineWith(lines, pattern) {
  for (const line of lines) {
    if (pattern.test(line)) return line;
  }
  return null;
}

function moneyNear(lines, pattern, span = 2) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!pattern.test(lines[i])) continue;
    for (let offset = 0; offset <= span; offset += 1) {
      const line = lines[i + offset];
      if (!line) break;
      const found = line.match(/-?\$?\s*\d[\d,]*(?:\.\d{2})?/g);
      if (!found) continue;
      for (const match of found) {
        const number = moneyOf(match);
        if (number !== null && /\.\d{2}/.test(match)) return number;
      }
    }
  }
  return null;
}

function parseUsageRow(line, rateHint) {
  if (!line) return null;
  const numbers = numbersIn(line);
  if (numbers.length < 2) return null;
  const rate = numbers.find((value) => !isInteger(value) && (rateHint === undefined || Math.abs(value - rateHint) < 0.5));
  const amount = [...numbers].reverse().find((value) => !isInteger(value) && value !== rate);
  const integers = numbers.filter((value) => isInteger(value) && value >= 0 && value <= 1000000);
  const unit = integers.find((value) => value !== rate && value !== amount);
  if (unit === undefined || amount === undefined) return null;
  return {
    rate: rate === undefined ? null : rate,
    units: unit,
    amount,
  };
}

export function parseBillLines(rawLines) {
  const lines = (rawLines || [])
    .map((line) => String(line || '').normalize('NFKC').replace(/\u00a0/g, ' ').replace(/−/g, '-').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const text = lines.join('\n');

  const periodMatch = text.match(/由\s*(\d{1,2})-(\d{1,2})-(\d{2,4})\s*至\s*(\d{1,2})-(\d{1,2})-(\d{2,4})/);
  if (!periodMatch) throw new Error('搵唔到帳單期（由 … 至 …）');
  const periodStart = hkDateFromParts(Number(periodMatch[1]), Number(periodMatch[2]), Number(periodMatch[3]));
  const periodEnd = hkDateFromParts(Number(periodMatch[4]), Number(periodMatch[5]), Number(periodMatch[6]));
  if (!periodStart || !periodEnd || periodStart >= periodEnd) throw new Error('帳單期日期無效');

  let peakLine = null;
  let offLine = null;
  for (const line of lines) {
    if (!offLine && /非\s*高\s*[峯峰]\s*時\s*段/.test(line)) offLine = line;
    else if (!peakLine && /(高\s*[峯峰])\s*時\s*段/.test(line)) peakLine = line;
  }
  const peak = parseUsageRow(peakLine, 137.5);
  const off = parseUsageRow(offLine, 94.5);

  let subtotalUnits = null;
  for (const line of lines) {
    if (!/小\s*計/.test(line)) continue;
    const found = numbersIn(line).find((value) => isInteger(value) && value > 0 && value <= 1000000);
    if (found !== undefined) { subtotalUnits = found; break; }
  }

  const units = peak && off ? peak.units + off.units : subtotalUnits;
  if (!units) throw new Error('搵唔到總用電度數');

  let energyCharge = null;
  let fuelCharge = null;
  let others = null;
  for (const line of lines) {
    if (!/小\s*計/.test(line)) continue;
    const values = moneyTokens(line);
    const amount = values.length ? values[values.length - 1] : null;
    if (amount === null) continue;
    if (/度/.test(line)) {
      if (fuelCharge === null) fuelCharge = amount;
    } else if (Math.abs(amount) < 100) {
      if (others === null) others = amount;
    } else if (energyCharge === null) {
      energyCharge = amount;
    }
  }
  if (energyCharge === null || fuelCharge === null || others === null) {
    const labelIndex = lines.findIndex((line) => /應\s*繳\s*總\s*數/.test(line));
    if (labelIndex !== -1) {
      for (let i = labelIndex; i < Math.min(lines.length, labelIndex + 3); i += 1) {
        const values = moneyTokens(lines[i]);
        if (values.length !== 3) continue;
        if (energyCharge === null) energyCharge = values[0];
        if (fuelCharge === null) fuelCharge = values[1];
        if (others === null) others = values[2];
        break;
      }
    }
  }
  if (energyCharge === null) energyCharge = moneyNear(lines, /電\s*力\s*費\s*用/);
  if (fuelCharge === null) fuelCharge = moneyNear(lines, /燃\s*料\s*調\s*整\s*費/);
  if (others === null) others = moneyNear(lines, /其\s*他/);
  const componentsSum = energyCharge !== null && fuelCharge !== null
    ? energyCharge + fuelCharge + (others || 0)
    : null;

  let total = moneyNear(lines, /應\s*繳\s*總\s*數/);
  let totalSource = 'parsed';
  if (componentsSum !== null) {
    const labelIndex = lines.findIndex((line) => /應\s*繳\s*總\s*數/.test(line));
    if (labelIndex !== -1) {
      const candidates = [];
      const stop = Math.min(lines.length - 1, labelIndex + 5);
      for (let i = labelIndex; i <= stop; i += 1) {
        const matches = lines[i].match(/-?\$?\s*\d[\d,]*(?:\.\d{2})?/g) || [];
        for (const match of matches) {
          if (!/\.\d{2}/.test(match)) continue;
          const value = moneyOf(match);
          if (value !== null && value > 0) candidates.push(value);
        }
      }
      // A total cannot be smaller than its positive components; allow a small
      // negative "others" and line rounding.
      const plausible = candidates.filter((value) => value + 1.5 >= energyCharge + fuelCharge);
      const pool = plausible.length ? plausible : candidates;
      let best = null;
      for (const value of pool) {
        const delta = Math.abs(value - componentsSum);
        if (!best || delta < best.delta) best = { value, delta };
      }
      if (best) total = best.value;
    }
    if (total === null || total + 1.5 < energyCharge + fuelCharge) {
      total = componentsSum;
      totalSource = 'derived';
    }
  }
  if (total === null || !(total > 0)) throw new Error('搵唔到應繳總數');

  const segments = [];
  const seenSegments = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const dates = lines[i].match(/(\d{1,2})-(\d{1,2})-(\d{2,4})\s*(?:至\s*)?(\d{1,2})-(\d{1,2})-(\d{2,4})/);
    if (!dates) continue;
    const start = hkDateFromParts(Number(dates[1]), Number(dates[2]), Number(dates[3]));
    const end = hkDateFromParts(Number(dates[4]), Number(dates[5]), Number(dates[6]));
    if (!start || !end) continue;
    let tail = lines[i].slice(dates.index + dates[0].length);
    let numbers = numbersIn(tail);
    const hasRate = numbers.some((value) => !isInteger(value) && value > 0 && value < 10);
    const hasAmount = numbers.some((value) => !isInteger(value) && value >= 10);
    if (!hasRate || !hasAmount) {
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 4); j += 1) {
        if (/\d{1,2}-\d{1,2}-\d{2,4}\s*(?:至\s*)?\d{1,2}-\d{1,2}-\d{2,4}/.test(lines[j])) break;
        tail += ' ' + lines[j];
      }
      numbers = numbersIn(tail);
    }
    const integers = numbers.filter((value) => isInteger(value) && value > 0 && value < 1000000);
    const rates = numbers.filter((value) => !isInteger(value) && value > 0 && value < 10);
    const amounts = numbers.filter((value) => !isInteger(value) && value >= 10);
    if (!integers.length || !rates.length || !amounts.length) continue;
    // Sub-period rows read as: billing days, units, rate, amount.
    const segmentUnits = integers.length >= 2 ? integers[1] : integers[0];
    const key = start + '|' + end;
    if (seenSegments.has(key)) continue;
    seenSegments.add(key);
    segments.push({ start, end, units: segmentUnits, amount: amounts[amounts.length - 1] });
  }
  const tail = segments.find((segment) => segment.end === periodEnd && segment.start !== periodStart) || null;

  return {
    periodStart,
    periodEnd,
    units,
    peakKWh: peak ? peak.units : null,
    offPeakKWh: off ? off.units : null,
    energyCharge,
    fuelCharge,
    others,
    total,
    totalSource,
    tail,
  };
}

export function groupPdfTextItems(items) {
  const rows = [];
  for (const item of items || []) {
    const text = String(item && item.str ? item.str : '').trim();
    if (!text) continue;
    const transform = item.transform || [];
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    const width = Number(item.width) || 0;
    const height = Math.abs(Number(transform[3])) || Number(item.height) || 10;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    rows.push({ text, x, y, width, height });
  }
  rows.sort((a, b) => (Math.abs(b.y - a.y) > 2.5 ? b.y - a.y : a.x - b.x));
  const lines = [];
  let current = null;
  for (const row of rows) {
    if (!current || Math.abs(current.y - row.y) > 2.5) {
      if (current) lines.push(current);
      current = { y: row.y, parts: [{ ...row }] };
      continue;
    }
    current.parts.push(row);
  }
  if (current) lines.push(current);
  return lines.map((line) => {
    const parts = line.parts.slice().sort((a, b) => a.x - b.x);
    let text = '';
    let previousEnd = null;
    for (const part of parts) {
      const gap = previousEnd === null ? 0 : part.x - previousEnd;
      const space = previousEnd !== null && gap > Math.max(2, part.height * 0.55) ? ' ' : '';
      text += space + part.text;
      previousEnd = part.x + part.width;
    }
    return text.trim();
  }).filter(Boolean);
}

export async function extractPdfLines(buffer, pdfjsLib) {
  if (!pdfjsLib || typeof pdfjsLib.getDocument !== 'function') {
    throw new Error('PDF 解析元件未載入');
  }
  const document = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  const lines = [];
  for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 3); pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    lines.push(...groupPdfTextItems(content.items));
  }
  return lines;
}

export function defaultCutoff(periodEnd) {
  if (!DATE_RE.test(String(periodEnd || ''))) return null;
  const at = Date.parse(`${periodEnd}T00:00:00+08:00`) + 24 * 60 * 60 * 1000;
  return new Date(at).toISOString();
}

export function inferCutoff(records, bill) {
  const fallback = defaultCutoff(bill.periodEnd);
  const tail = bill.tail;
  if (!tail || !fallback) return { cutoff: fallback, source: 'default' };
  const tailStart = Date.parse(`${tail.start}T00:00:00+08:00`);
  const dayEnd = Date.parse(`${bill.periodEnd}T00:00:00+08:00`) + 24 * 60 * 60 * 1000;
  if (!Number.isFinite(tailStart) || !Number.isFinite(dayEnd)) return { cutoff: fallback, source: 'default' };
  const candidates = new Set([dayEnd]);
  for (const record of records || []) {
    const at = Date.parse(record.startAt);
    if (Number.isFinite(at) && at >= tailStart && at < dayEnd) candidates.add(at);
  }
  let best = null;
  for (const cutoff of candidates) {
    let sum = 0;
    for (const record of records || []) {
      const at = Date.parse(record.startAt);
      if (!Number.isFinite(at) || at < tailStart || at >= cutoff) continue;
      if (record.kWh === null || record.car === 'unassigned') continue;
      sum += record.kWh;
    }
    const delta = Math.abs(sum - tail.units);
    if (!best || delta < best.delta) best = { cutoff, delta, sum };
  }
  if (!best) return { cutoff: fallback, source: 'default' };
  if (best.delta > Math.max(20, tail.units * 0.3)) return { cutoff: fallback, source: 'default' };
  return { cutoff: new Date(best.cutoff).toISOString(), source: 'bill' };
}

export function allocateBill(records, bill, cars, rates, cutoffIso) {
  const cutoff = cutoffIso || bill.cutoff || defaultCutoff(bill.periodEnd);
  const startMs = Date.parse(`${bill.periodStart}T00:00:00+08:00`);
  const cutoffMs = Date.parse(cutoff);
  const names = new Map((cars || []).map((car) => [car.id, car.name]));
  const totals = new Map();
  let loggedKWh = 0;
  let peakKWh = 0;
  let offPeakKWh = 0;
  let estimate = 0;
  const ratesByMonth = new Map((rates || []).map((rate) => [rate.month, rate]));
  for (const record of records || []) {
    if (record.kWh === null || record.kWh === undefined) continue;
    if (!record.car || record.car === 'unassigned') continue;
    const at = Date.parse(record.startAt);
    if (!Number.isFinite(at) || at < startMs || at >= cutoffMs) continue;
    const entry = totals.get(record.car) || { id: record.car, kWh: 0, sessions: 0 };
    entry.kWh += record.kWh;
    entry.sessions += 1;
    totals.set(record.car, entry);
    loggedKWh += record.kWh;
    peakKWh += record.peakKWh || 0;
    offPeakKWh += record.offPeakKWh || 0;
    const month = new Date(Date.parse(record.teslaStartAt || record.startAt) + HK_OFFSET_MS).toISOString().slice(0, 7);
    const rate = ratesByMonth.get(month);
    if (rate && record.peakKWh !== null && record.offPeakKWh !== null) {
      estimate += (record.peakKWh * (rate.basicPeak + rate.fuelAdjustment)
        + record.offPeakKWh * (rate.basicOffPeak + rate.fuelAdjustment)) / 100;
    }
  }
  const rows = [...totals.values()]
    .map((entry) => ({
      ...entry,
      name: names.get(entry.id) || entry.id,
      share: loggedKWh > 0 ? entry.kWh / loggedKWh : 0,
      amount: loggedKWh > 0 ? (entry.kWh / loggedKWh) * bill.total : 0,
    }))
    .sort((a, b) => b.kWh - a.kWh);
  return {
    cutoff,
    loggedKWh,
    peakKWh,
    offPeakKWh,
    estimate,
    rows,
    driftUnitsPct: bill.units > 0 ? (loggedKWh / bill.units - 1) * 100 : null,
    driftEstimatePct: bill.total > 0 && estimate > 0 ? (estimate / bill.total - 1) * 100 : null,
  };
}

function optionalNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeBillRow(row) {
  if (!row) return null;
  const periodStart = String(row.periodStart || '').slice(0, 10);
  const periodEnd = String(row.periodEnd || '').slice(0, 10);
  if (!DATE_RE.test(periodStart) || !DATE_RE.test(periodEnd)) return null;
  const total = Number(row.total);
  const units = Number(row.units);
  if (!(total > 0) || !(units > 0)) return null;
  const cutoff = String(row.cutoff || '').trim();
  return {
    periodStart,
    periodEnd,
    cutoff: Number.isFinite(Date.parse(cutoff)) ? new Date(Date.parse(cutoff)).toISOString() : defaultCutoff(periodEnd),
    units,
    peakKWh: optionalNumber(row.peakKWh),
    offPeakKWh: optionalNumber(row.offPeakKWh),
    energyCharge: optionalNumber(row.energyCharge),
    fuelCharge: optionalNumber(row.fuelCharge),
    others: optionalNumber(row.others),
    total,
    fileName: String(row.fileName || '').trim(),
    savedAt: String(row.savedAt || '').trim(),
  };
}

export function normalizeBillRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeBillRow)
    .filter(Boolean)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
}
