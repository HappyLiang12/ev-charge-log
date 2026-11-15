var TESLA_TOKEN_URL_ = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
var DEFAULT_TESLA_BASE_URL_ = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
var TESLA_SCOPE_ = 'openid offline_access energy_device_data';
var TESLA_MAX_LOOKBACK_DAYS_ = 90;
var TESLA_INIT_LOOKBACK_DAYS_ = 30;

function scriptProperty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function teslaBaseUrl_() {
  return (scriptProperty_('TESLA_BASE_URL') || DEFAULT_TESLA_BASE_URL_).replace(/\/+$/, '');
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
      audience: teslaBaseUrl_(),
      scope: TESLA_SCOPE_,
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

function teslaGet_(path, params, retried) {
  var url = teslaBaseUrl_() + path;
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
  if (status === 401 && !retried) {
    PropertiesService.getScriptProperties().deleteProperty('TESLA_ACCESS_TOKEN');
    return teslaGet_(path, params, true);
  }
  if (status === 401 || status === 403) {
    throw new Error('Tesla authorization expired; re-run the local setup tool');
  }
  if (status < 200 || status >= 300) {
    throw new Error('Tesla API ' + status + ' for ' + path);
  }
  return JSON.parse(response.getContentText());
}

function wallConnectorSiteIds_(node, found) {
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i += 1) wallConnectorSiteIds_(node[i], found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  if (node.energy_site_id !== undefined && node.energy_site_id !== null
      && node.resource_type === 'wall_connector') {
    found[node.energy_site_id] = true;
  }
  var keys = Object.keys(node);
  for (var k = 0; k < keys.length; k += 1) wallConnectorSiteIds_(node[keys[k]], found);
  return found;
}

function discoverSiteId_() {
  var props = PropertiesService.getScriptProperties();
  var configured = props.getProperty('TESLA_SITE_ID');
  if (configured) return configured;
  var payload = teslaGet_('/api/1/products', {});
  var found = wallConnectorSiteIds_(payload.response || payload, {});
  var siteIds = Object.keys(found);
  if (siteIds.length === 1) {
    props.setProperty('TESLA_SITE_ID', siteIds[0]);
    return siteIds[0];
  }
  throw new Error(
    'Expected exactly one Tesla Wall Connector energy site (resource_type=wall_connector)'
    + ' in /api/1/products, found ' + siteIds.length + '; set the TESLA_SITE_ID Script Property',
  );
}

function looksLikeSession_(item) {
  var keys = Object.keys(item);
  for (var i = 0; i < keys.length; i += 1) {
    if (/(^|_)(start|end|energy|session|charge)/i.test(keys[i])) return true;
  }
  return false;
}

function collectChargeSessions_(payload) {
  var arrays = [];

  function visit(node) {
    if (Array.isArray(node)) {
      var allObjects = node.length > 0;
      for (var i = 0; i < node.length && allObjects; i += 1) {
        if (!node[i] || typeof node[i] !== 'object' || Array.isArray(node[i])) allObjects = false;
      }
      if (allObjects) {
        for (var j = 0; j < node.length; j += 1) {
          if (looksLikeSession_(node[j])) {
            arrays.push(node);
            break;
          }
        }
      }
      for (var m = 0; m < node.length; m += 1) visit(node[m]);
      return;
    }
    if (node && typeof node === 'object') {
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k += 1) visit(node[keys[k]]);
    }
  }

  visit(payload);
  if (!arrays.length) return [];
  arrays.sort(function (a, b) { return b.length - a.length; });
  return arrays[0];
}

function scalarText_(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    var keys = ['text', 'value', 'id', 'uuid', 'name'];
    for (var i = 0; i < keys.length; i += 1) {
      if (value[keys[i]] !== undefined && value[keys[i]] !== null) return scalarText_(value[keys[i]]);
    }
    try {
      return JSON.stringify(value);
    } catch (ignored) {
      return '';
    }
  }
  return String(value);
}

function secondsOf_(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    var keys = ['seconds', 'value'];
    for (var i = 0; i < keys.length; i += 1) {
      var nested = secondsOf_(value[keys[i]]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function energyWhOf_(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object') {
    var keys = ['value', 'wh', 'energy_added_wh', 'watt_hours'];
    for (var i = 0; i < keys.length; i += 1) {
      if (value[keys[i]] !== undefined && value[keys[i]] !== null) return energyWhOf_(value[keys[i]]);
    }
  }
  return 0;
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
  var rows = collectChargeSessions_(payload);
  var sessions = [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var startSeconds = secondsOf_(row.charge_start_time);
    var durationSec = secondsOf_(row.charge_duration);
    var energyWh = energyWhOf_(row.energy_added_wh);
    if (startSeconds === null || !isFinite(startSeconds)) continue;
    if (durationSec === null || !(durationSec > 0)) continue;
    if (!(energyWh > 0)) continue;
    var startMs = startSeconds * 1000;
    var targetId = scalarText_(row.target_id);
    var din = scalarText_(row.din);
    sessions.push({
      teslaKey: (din || targetId) + ':' + Math.floor(startSeconds),
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(startMs + durationSec * 1000).toISOString(),
      durationSec: durationSec,
      kWh: round6_(energyWh / 1000),
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

function tinyHash_(text) {
  var hash = 5381;
  for (var i = 0; i < text.length; i += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function teslaRecordId_(session) {
  return 'tesla-' + Math.floor(Date.parse(session.startAt) / 1000) + '-' + tinyHash_(session.teslaKey);
}

function normalizeChargerLive_(payload) {
  var root = payload && payload.response ? payload.response : (payload || {});
  var connectors = root.wall_connectors || root.wallConnectors || [];
  var boxes = root.wall_boxes || root.wallBoxes || [];
  var list = connectors.length ? connectors : boxes;
  var item = list[0] || {};
  var powerW = numberOrNull_(item.wall_connector_power);
  if (powerW === null) powerW = numberOrNull_(item.charger_power_watts);
  if (powerW === null) powerW = numberOrNull_(item.charger_power);
  if (powerW === null) powerW = numberOrNull_(item.power);
  var energyWh = numberOrNull_(item.session_energy_wh);
  if (energyWh === null) energyWh = numberOrNull_(item.charge_energy_added_wh);
  if (energyWh === null) energyWh = numberOrNull_(item.energy_added_wh);
  if (energyWh === null) energyWh = numberOrNull_(item.wall_connector_energy_wh);
  if (energyWh === null) energyWh = numberOrNull_(item.energy_wh);
  var state = item.wall_connector_state;
  if (state === undefined || state === null) state = item.charger_state;
  if (state === undefined || state === null) state = '';
  var power = powerW === null ? 0 : Math.max(0, powerW);
  return {
    charging: power > 50 || /charg/i.test(String(state)),
    powerW: power,
    energyWh: energyWh === null ? null : Math.max(0, energyWh),
    state: String(state),
    available: list.length > 0,
    keys: Object.keys(item),
    sampledAt: new Date().toISOString(),
  };
}

function chargerLiveStatus_() {
  var siteId = discoverSiteId_();
  var payload = teslaGet_(
    '/api/1/energy_sites/' + encodeURIComponent(siteId) + '/charger_live_status',
    {},
  );
  return normalizeChargerLive_(payload);
}

function syncTesla_(allowInitialWindow) {
  var props = PropertiesService.getScriptProperties();
  var records = readLog_();
  var ignored = new Set(readIgnored_());
  var manualRows = records.filter(function (record) {
    return record.source === 'manual' && record.car && record.car !== 'unassigned'
      && record.kWh === null && !record.teslaKey;
  });
  var cursor = props.getProperty('SYNC_CURSOR');
  var syncFrom = props.getProperty('SYNC_FROM');
  var now = new Date();
  var lookback = new Date(now.getTime() - TESLA_MAX_LOOKBACK_DAYS_ * 86400000);
  var windowMs = Number(props.getProperty('MATCH_WINDOW_MINUTES') || 30) * 60 * 1000;

  var lower = null;
  if (cursor && validIso_(cursor)) {
    lower = new Date(Math.max(Date.parse(cursor) - 2 * 86400000, lookback.getTime()));
  } else if (syncFrom && validIso_(syncFrom)) {
    lower = new Date(Math.max(Date.parse(syncFrom), lookback.getTime()));
  } else if (manualRows.length) {
    var earliest = manualRows.reduce(function (min, row) {
      return Math.min(min, Date.parse(row.startAt));
    }, Infinity);
    lower = new Date(Math.max(earliest - 2 * 86400000, lookback.getTime()));
  }
  if (!lower && allowInitialWindow) {
    lower = new Date(now.getTime() - TESLA_INIT_LOOKBACK_DAYS_ * 86400000);
  }
  if (!lower) {
    return {
      matched: 0,
      unassigned: 0,
      fetched: 0,
      skipped: true,
      reconciled: 0,
      skippedExisting: 0,
      skippedIgnored: 0,
      pendingManual: manualRows.length,
    };
  }

  // The fetch must succeed before any Sheet write; a failure surfaces with Log intact.
  var siteId = discoverSiteId_();
  var sessions = fetchSessions_(siteId, lower.toISOString(), now.toISOString());

  var reconciled = 0;
  var unassignedRows = records.filter(function (record) {
    return record.source === 'tesla' && record.car === 'unassigned' && record.teslaKey && record.kWh != null;
  });
  for (var u = 0; u < unassignedRows.length; u += 1) {
    var unassignedRow = unassignedRows[u];
    var candidate = closestManualCandidate_(
      unassignedRow.teslaStartAt || unassignedRow.startAt,
      manualRows,
      windowMs,
    );
    if (!candidate) continue;
    var updated = updateLog_(candidate.id, {
      kWh: unassignedRow.kWh,
      durationSec: unassignedRow.durationSec,
      teslaStartAt: unassignedRow.teslaStartAt,
      teslaEndAt: unassignedRow.teslaEndAt,
      peakKWh: unassignedRow.peakKWh,
      offPeakKWh: unassignedRow.offPeakKWh,
      teslaKey: unassignedRow.teslaKey,
      source: 'tesla+manual',
    });
    if (!updated) continue;
    deleteLog_(unassignedRow.id);
    candidate.kWh = updated.kWh;
    candidate.durationSec = updated.durationSec;
    candidate.teslaStartAt = updated.teslaStartAt;
    candidate.teslaEndAt = updated.teslaEndAt;
    candidate.peakKWh = updated.peakKWh;
    candidate.offPeakKWh = updated.offPeakKWh;
    candidate.teslaKey = updated.teslaKey;
    candidate.source = updated.source;
    var candidateIndex = manualRows.indexOf(candidate);
    if (candidateIndex >= 0) manualRows.splice(candidateIndex, 1);
    var unassignedIndex = records.indexOf(unassignedRow);
    if (unassignedIndex >= 0) records.splice(unassignedIndex, 1);
    reconciled += 1;
  }

  var knownKeys = {};
  for (var k = 0; k < records.length; k += 1) {
    if (records[k].teslaKey) knownKeys[records[k].teslaKey] = true;
  }

  var rates = readRates_();
  var matched = 0;
  var unassigned = 0;
  var skippedExisting = 0;
  var skippedIgnored = 0;

  for (var i = 0; i < sessions.length; i += 1) {
    var session = sessions[i];
    if (ignored.has(session.teslaKey)) {
      skippedIgnored += 1;
      continue;
    }
    if (knownKeys[session.teslaKey]) {
      skippedExisting += 1;
      continue;
    }
    var rate = selectRateRow_(hkMonth_(session.startAt), rates);
    var peakStart = rate ? rate.peakStart : DEFAULT_PEAK_START_;
    var peakEnd = rate ? rate.peakEnd : DEFAULT_PEAK_END_;
    var split = splitPeakKwh_(session.startAt, session.durationSec, session.kWh, peakStart, peakEnd);
    var manual = closestManualCandidate_(session.startAt, manualRows, windowMs);
    if (manual) {
      var filled = updateLog_(manual.id, {
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
      if (filled) {
        knownKeys[session.teslaKey] = true;
        var index = manualRows.indexOf(manual);
        if (index >= 0) manualRows.splice(index, 1);
        matched += 1;
        continue;
      }
    }
    appendLog_({
      id: teslaRecordId_(session),
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
    knownKeys[session.teslaKey] = true;
    unassigned += 1;
  }

  props.setProperty('SYNC_CURSOR', now.toISOString());
  return {
    matched: matched,
    unassigned: unassigned,
    fetched: sessions.length,
    skipped: false,
    reconciled: reconciled,
    skippedExisting: skippedExisting,
    skippedIgnored: skippedIgnored,
    pendingManual: manualRows.length,
  };
}
