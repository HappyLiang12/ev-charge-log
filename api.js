import {
  formatHkDate,
  formatHkTime,
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

export async function fetchOwnerData(apiUrl, ownerKey, fetchImpl = fetch) {
  return parseOwnerPayload(await apiGet(apiUrl, { owner: ownerKey }, fetchImpl));
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

export async function assignSession(apiUrl, ownerKey, id, car, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'assign', ownerKey, id, car }, fetchImpl);
}

export async function claimSession(apiUrl, car, id, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'claim', car, id }, fetchImpl);
}

export async function ignoreSession(apiUrl, ownerKey, id, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'ignore', ownerKey, id }, fetchImpl);
}

export async function refreshRates(apiUrl, ownerKey, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'refreshRates', ownerKey }, fetchImpl);
}
