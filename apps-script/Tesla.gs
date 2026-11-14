var TESLA_TOKEN_URL_ = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
var DEFAULT_TESLA_BASE_URL_ = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
var TESLA_MAX_LOOKBACK_DAYS_ = 90;

function scriptProperty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function refreshAccessToken_() {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('TESLA_ACCESS_TOKEN');
  var expiry = Number(props.getProperty('TESLA_TOKEN_EXPIRY') || 0);
  if (cached && expiry > Date.now() + 5 * 60 * 1000) return cached;
  var response = UrlFetchApp.fetch(TESLA_TOKEN_URL_, {
    method: 'post',
    payload: {
      grant_type: 'refresh_token',
      client_id: props.getProperty('TESLA_CLIENT_ID'),
      client_secret: props.getProperty('TESLA_CLIENT_SECRET'),
      refresh_token: props.getProperty('TESLA_REFRESH_TOKEN'),
    },
    muteHttpExceptions: true,
  });
  var status = response.getResponseCode();
  var body = response.getContentText();
  if (status < 200 || status >= 300) {
    var error = '';
    try { error = JSON.parse(body).error || ''; } catch (ignored) { error = ''; }
    throw new Error('Tesla token refresh failed (' + status + ')' + (error ? ': ' + error : ''));
  }
  var data = JSON.parse(body);
  if (!data.access_token) throw new Error('Tesla token refresh returned no access_token');
  props.setProperty('TESLA_ACCESS_TOKEN', data.access_token);
  props.setProperty('TESLA_TOKEN_EXPIRY', String(Date.now() + (Number(data.expires_in) || 3600) * 1000));
  if (data.refresh_token) props.setProperty('TESLA_REFRESH_TOKEN', data.refresh_token);
  return data.access_token;
}

function teslaGet_(path, params) {
  var base = scriptProperty_('TESLA_BASE_URL') || DEFAULT_TESLA_BASE_URL_;
  var url = base.replace(/\/$/, '') + path;
  var query = [];
  for (var key in params || {}) {
    if (Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined && params[key] !== null) {
      query.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
    }
  }
  if (query.length) url += '?' + query.join('&');
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + refreshAccessToken_() },
    muteHttpExceptions: true,
  });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error('Tesla API ' + status + ' for ' + path);
  }
  return JSON.parse(response.getContentText());
}

function discoverSiteId_() {
  var props = PropertiesService.getScriptProperties();
  var configured = props.getProperty('TESLA_SITE_ID');
  if (configured) return configured;
  var payload = teslaGet_('/api/1/products', {});
  var products = payload.response || [];
  for (var i = 0; i < products.length; i += 1) {
    var product = products[i];
    if (product.energy_site_id) {
      props.setProperty('TESLA_SITE_ID', String(product.energy_site_id));
      return String(product.energy_site_id);
    }
  }
  throw new Error('No Tesla Wall Connector energy site found');
}

function fetchSessions_(siteId, startIso, endIso) {
  var payload = teslaGet_(
    '/api/1/energy_sites/' + encodeURIComponent(siteId) + '/telemetry_history',
    {
      kind: 'charge',
      start_date: startIso,
      end_date: endIso,
      time_zone: 'Asia/Hong_Kong',
    },
  );
  var data = payload.response || {};
  var rows = data.telemetry_history || data.data || [];
  var sessions = [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var start = row.start_date_time || row.start_date || row.start_time;
    if (!validIso_(start)) continue;
    var startAt = new Date(start).toISOString();
    var duration = Number(row.duration != null ? row.duration : row.duration_s);
    if (!isFinite(duration) || duration <= 0) continue;
    var energy = Number(row.charge_energy_added != null ? row.charge_energy_added : row.energy_added);
    if (!isFinite(energy)) continue;
    var targetId = String(row.target_id || '');
    var din = String(row.din || '');
    var endAt = validIso_(row.end_date_time)
      ? new Date(row.end_date_time).toISOString()
      : new Date(Date.parse(startAt) + duration * 1000).toISOString();
    sessions.push({
      teslaKey: (din || targetId) + ':' + Math.floor(Date.parse(startAt) / 1000),
      startAt: startAt,
      endAt: endAt,
      durationSec: duration,
      kWh: energy,
      targetId: targetId,
      din: din,
    });
  }
  return sessions;
}

function selectRateRow_(month, rates) {
  var best = null;
  for (var i = 0; i < rates.length; i += 1) {
    var rate = rates[i];
    if (rate.month === month) return rate;
    if (rate.month < month && (!best || rate.month > best.month)) best = rate;
  }
  return best;
}

function syncTesla_() {
  var props = PropertiesService.getScriptProperties();
  var records = readLog_();
  var ignored = new Set(readIgnored_());
  var manualRows = records.filter(function (record) {
    return record.source === 'manual' && record.kWh === null && !record.teslaKey;
  });
  var cursor = props.getProperty('SYNC_CURSOR');
  var syncFrom = props.getProperty('SYNC_FROM');
  var now = new Date();
  var lookback = new Date(now.getTime() - TESLA_MAX_LOOKBACK_DAYS_ * 86400000);
  var windowMs = Number(props.getProperty('MATCH_WINDOW_MINUTES') || 30) * 60 * 1000;

  // A driver can record a start after an earlier sync already imported the
  // Tesla session as unassigned. Reconcile those rows without another fetch.
  var reconciled = 0;
  var unassignedRows = records.filter(function (record) {
    return record.car === 'unassigned' && record.teslaKey && record.kWh != null;
  });
  for (var u = 0; u < unassignedRows.length; u += 1) {
    var candidate = closestManualCandidate_(
      unassignedRows[u].teslaStartAt || unassignedRows[u].startAt,
      manualRows,
      windowMs,
    );
    if (!candidate) continue;
    updateLog_(unassignedRows[u].id, {
      car: candidate.car,
      startAt: candidate.startAt,
      date: candidate.date,
      time: candidate.time,
      source: 'tesla+manual',
    });
    deleteLog_(candidate.id);
    var candidateIndex = manualRows.indexOf(candidate);
    if (candidateIndex >= 0) manualRows.splice(candidateIndex, 1);
    reconciled += 1;
  }

  var lower;
  if (cursor && validIso_(cursor)) {
    lower = new Date(Math.max(Date.parse(cursor) - 2 * 86400000, lookback.getTime()));
  } else if (syncFrom && validIso_(syncFrom)) {
    lower = new Date(Math.max(Date.parse(syncFrom), lookback.getTime()));
  } else if (manualRows.length) {
    var earliest = manualRows.reduce(function (min, row) {
      return Math.min(min, Date.parse(row.startAt));
    }, Infinity);
    lower = new Date(Math.max(earliest - 2 * 86400000, lookback.getTime()));
  } else {
    return { matched: reconciled, unassigned: 0, fetched: 0, skipped: true };
  }

  var siteId = discoverSiteId_();
  var sessions = fetchSessions_(siteId, lower.toISOString(), now.toISOString());
  var rates = readRates_();
  var matched = reconciled;
  var unassigned = 0;
  var highest = cursor && validIso_(cursor) ? Date.parse(cursor) : 0;

  for (var i = 0; i < sessions.length; i += 1) {
    var session = sessions[i];
    highest = Math.max(highest, Date.parse(session.startAt));
    if (ignored.has(session.teslaKey)) continue;
    var duplicate = false;
    for (var d = 0; d < records.length; d += 1) {
      if (records[d].teslaKey === session.teslaKey) { duplicate = true; break; }
    }
    if (duplicate) continue;
    var rate = selectRateRow_(hkMonth_(session.startAt), rates);
    var peakStart = rate ? rate.peakStart : DEFAULT_PEAK_START_;
    var peakEnd = rate ? rate.peakEnd : DEFAULT_PEAK_END_;
    var split = splitPeakKwh_(session.startAt, session.durationSec, session.kWh, peakStart, peakEnd);
    var manual = closestManualCandidate_(session.startAt, manualRows, windowMs);
    if (manual) {
      updateLog_(manual.id, {
        car: manual.car,
        startAt: manual.startAt,
        date: manual.date,
        time: manual.time,
        kWh: session.kWh,
        durationSec: session.durationSec,
        teslaStartAt: session.startAt,
        teslaEndAt: session.endAt,
        peakKWh: split.peakKWh,
        offPeakKWh: split.offPeakKWh,
        teslaKey: session.teslaKey,
        source: 'tesla+manual',
      });
      var index = manualRows.indexOf(manual);
      if (index >= 0) manualRows.splice(index, 1);
      matched += 1;
    } else {
      appendLog_({
        id: 'tesla-' + Math.floor(Date.parse(session.startAt) / 1000),
        car: 'unassigned',
        startAt: session.startAt,
        date: hkDateString_(session.startAt),
        time: hkTimeString_(session.startAt),
        kWh: session.kWh,
        durationSec: session.durationSec,
        teslaStartAt: session.startAt,
        teslaEndAt: session.endAt,
        peakKWh: split.peakKWh,
        offPeakKWh: split.offPeakKWh,
        teslaKey: session.teslaKey,
        source: 'tesla',
      });
      unassigned += 1;
    }
  }

  props.setProperty(
    'SYNC_CURSOR',
    new Date(Math.max(highest, lookback.getTime())).toISOString(),
  );
  return { matched: matched, unassigned: unassigned, fetched: sessions.length, skipped: false };
}
