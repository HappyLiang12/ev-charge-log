import {
  formatHkDate,
  formatHkTime,
  parseChargerStatus,
  parseFamilyPayload,
  parseOwnerPayload,
} from './logic.js';

function withParams(apiUrl, params) {
  const url = new URL(apiUrl);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function jsonResponse(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Invalid JSON');
  }
  if (!payload || payload.ok !== true) {
    throw new Error((payload && payload.error) || 'API error');
  }
  return payload;
}

export async function apiGet(apiUrl, params, fetchImpl = fetch) {
  const response = await fetchImpl(withParams(apiUrl, params), {
    method: 'GET',
    redirect: 'follow',
  });
  return jsonResponse(response);
}

export async function apiPost(apiUrl, body, fetchImpl = fetch) {
  const response = await fetchImpl(apiUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
  return jsonResponse(response);
}

export async function fetchFamilyData(apiUrl, car, fetchImpl = fetch) {
  return parseFamilyPayload(await apiGet(apiUrl, { car }, fetchImpl));
}

export async function fetchOwnerData(apiUrl, fetchImpl = fetch) {
  return parseOwnerPayload(await apiGet(apiUrl, { owner: '1' }, fetchImpl));
}

export async function fetchLatestSnapshot(apiUrl, fetchImpl = fetch) {
  const payload = await apiGet(apiUrl, { latest: '1', _: String(Date.now()) }, fetchImpl);
  const raw = payload.snapshot;
  if (!raw || !raw.id) return null;
  const width = Number(raw.width);
  const height = Number(raw.height);
  return {
    id: String(raw.id),
    capturedAt: String(raw.capturedAt || ''),
    driveUrl: String(raw.driveUrl || ''),
    driveFileId: String(raw.driveFileId || ''),
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
    crop: String(raw.crop || ''),
  };
}

export async function fetchChargerStatus(apiUrl, fetchImpl = fetch) {
  return parseChargerStatus(await apiGet(apiUrl, { status: '1' }, fetchImpl));
}

export async function postRecord(apiUrl, record, car, fetchImpl = fetch) {
  return apiPost(apiUrl, {
    id: record.id,
    car,
    startAt: record.startAt,
    date: formatHkDate(record.startAt),
    time: formatHkTime(record.startAt),
  }, fetchImpl);
}

export async function deleteRecord(apiUrl, id, auth, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'delete', id, ...auth }, fetchImpl);
}

export async function syncTesla(apiUrl, auth, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'sync', ...auth }, fetchImpl);
}

export async function assignSession(apiUrl, id, car, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'assign', id, car }, fetchImpl);
}

export async function ignoreSession(apiUrl, id, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'ignore', id }, fetchImpl);
}

export async function reassignSession(apiUrl, id, car, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'reassign', id, car }, fetchImpl);
}

export async function claimSession(apiUrl, car, id, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'claim', car, id }, fetchImpl);
}

export async function refreshRates(apiUrl, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'refreshRates' }, fetchImpl);
}

export async function saveBill(apiUrl, bill, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'bill', bill }, fetchImpl);
}

export async function publishBill(apiUrl, periodStart, periodEnd, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'publishBill', periodStart, periodEnd }, fetchImpl);
}
