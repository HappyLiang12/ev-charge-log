#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http2 from 'node:http2';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(HERE, '.env.tesla.local');
const REFRESH_TOKEN_FILE = join(HERE, '.tesla-refresh-token.local');
const SAVE_REFRESH = process.argv.includes('--save-refresh-token');
loadEnvFile(ENV_FILE);

const AUTH_URL = process.env.TESLA_AUTH_URL || 'https://auth.tesla.com/oauth2/v3/authorize';
const TOKEN_URL = process.env.TESLA_TOKEN_URL || 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const DEFAULT_BASE_URL = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const DEFAULT_REDIRECT_URI = 'http://localhost:8788/callback';
const SCOPE = 'openid offline_access energy_device_data';
const BASE_URL = (process.env.TESLA_FLEET_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const REDIRECT_URI = process.env.TESLA_REDIRECT_URI || DEFAULT_REDIRECT_URI;
const PROBE_DAYS = clampInt(process.env.TESLA_PROBE_DAYS, 90, 1, 3650);
const TIME_ZONE = process.env.TESLA_PROBE_TIME_ZONE || 'Asia/Hong_Kong';
const RAW = process.env.TESLA_PROBE_RAW === '1';
const INSPECT_IDS = process.env.TESLA_PROBE_IDS === '1';
const DOMAIN = process.env.TESLA_DOMAIN || '';
const DOMAIN_DISPLAY = DOMAIN || '<your-user>.github.io';
const CLIENT_ID = process.env.TESLA_CLIENT_ID || '';
const CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET || '';

const redirect = new URL(REDIRECT_URI);
const CALLBACK_PATH = redirect.pathname;
const CALLBACK_HOST = redirect.hostname.replace(/^\[|\]$/g, '');
const PORT = Number(redirect.port || 80);

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function writeRefreshTokenFile(path, token) {
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function errorDetail(json, body) {
  if (json && typeof json === 'object') {
    const response = json.response && typeof json.response === 'object' ? json.response : {};
    const parts = [
      json.error,
      json.error_description,
      json.message,
      response.error,
      response.message,
      response.error_description,
    ].filter(Boolean);
    if (parts.length) return parts.join(': ');
  }
  return String(body || '').replace(/\s+/g, ' ').slice(0, 300);
}

function http2Request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = http2.connect(target.origin);
    let settled = false;
    let status = 0;
    let responseHeaders = {};
    const chunks = [];

    const fail = (error) => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(error);
    };

    client.on('error', fail);
    client.setTimeout(30000, () => {
      fail(new Error(`Timed out: ${method} ${url}`));
    });

    const req = client.request({
      ':method': method,
      ':path': target.pathname + target.search,
      accept: 'application/json',
      'accept-encoding': 'identity',
      'user-agent': 'ev-charge-log-probe/1.0',
      ...headers,
    });

    req.on('response', (headersFromServer) => {
      status = Number(headersFromServer[':status'] || 0);
      responseHeaders = headersFromServer;
    });
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      client.close();

      let buffer = Buffer.concat(chunks);
      const encoding = String(responseHeaders['content-encoding'] || '').toLowerCase();
      try {
        if (encoding.includes('gzip')) buffer = gunzipSync(buffer);
        else if (encoding.includes('deflate')) buffer = inflateSync(buffer);
        else if (encoding.includes('br')) buffer = brotliDecompressSync(buffer);
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ status, headers: responseHeaders, body: buffer.toString('utf8') });
    });
    req.on('error', fail);

    if (body) req.end(body);
    else req.end();
  });
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers, redirect: 'follow' });
  const body = await response.text();
  return { status: response.status, body, json: parseJson(body) };
}

async function apiGet(path, accessToken) {
  const url = new URL(path, BASE_URL).toString();
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    'user-agent': 'ev-charge-log-probe/1.0',
  };

  console.log(`GET ${url} (HTTP/1.1)`);
  let http1 = null;
  let http1Error = null;
  try {
    http1 = await fetchJson(url, headers);
    if (http1.status === 200 && http1.json) return http1.json;
    if (http1.status !== 404 && http1.status !== 405) {
      throw new Error(`HTTP ${http1.status} ${url}: ${errorDetail(http1.json, http1.body)}`);
    }
  } catch (error) {
    if (/^HTTP \d{3} /.test(error.message)) throw error;
    http1Error = error;
  }

  console.log(`  HTTP/1.1 ${http1 ? `status ${http1.status}` : `error: ${http1Error?.message}`}; trying HTTP/2`);
  const http2Response = await http2Request(url, { headers });
  const http2Json = parseJson(http2Response.body);
  if (http2Response.status !== 200 || !http2Json) {
    const detail = errorDetail(http2Json, http2Response.body)
      || errorDetail(http1?.json, http1?.body)
      || http1Error?.message
      || '';
    throw new Error(`HTTP ${http2Response.status}/${http1?.status || 'network'} ${url}: ${detail}`);
  }
  return http2Json;
}

async function getPartnerToken() {
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    audience: BASE_URL,
    scope: 'openid energy_device_data',
  });
  const response = await http2Request(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const json = parseJson(response.body);
  if (response.status !== 200 || !json || !json.access_token) {
    throw new Error(`Partner token failed (HTTP ${response.status}): ${errorDetail(json, response.body)}`);
  }
  console.log('Partner token acquired; not printed.');
  return json.access_token;
}

async function registerPartner() {
  validateCredentials();
  if (!DOMAIN) throw new Error('Set TESLA_DOMAIN to your public app origin host before --register');
  const keyUrl = `https://${DOMAIN}/.well-known/appspecific/com.tesla.3p.public-key.pem`;

  console.log('Tesla Fleet API partner registration');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Domain: ${DOMAIN}`);
  console.log(`Public key: ${keyUrl}`);

  const keyResponse = await fetch(keyUrl, { redirect: 'follow' });
  const keyText = await keyResponse.text();
  console.log(`Public key HTTP ${keyResponse.status}${keyText.includes('BEGIN PUBLIC KEY') ? ' (PEM found)' : ''}`);
  if (!keyResponse.ok || !keyText.includes('BEGIN PUBLIC KEY')) {
    throw new Error('Public key is not reachable as raw PEM. Fix hosting before registering.');
  }

  const partnerToken = await getPartnerToken();
  const url = new URL('/api/1/partner_accounts', BASE_URL).toString();
  console.log(`POST ${url}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${partnerToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ domain: DOMAIN }),
  });
  const body = await response.text();
  const json = parseJson(body);
  console.log(`Registration HTTP ${response.status}`);
  if (!response.ok) {
    throw new Error(`Registration failed: ${errorDetail(json, body)}`);
  }
  console.log(jsonPreview(json, 2000));

  const verifyUrl = new URL('/api/1/partner_accounts/public_key', BASE_URL);
  verifyUrl.searchParams.set('domain', DOMAIN);
  const verifyResponse = await fetch(verifyUrl, {
    headers: { authorization: `Bearer ${partnerToken}`, accept: 'application/json' },
  });
  const verifyBody = await verifyResponse.text();
  console.log(`Registration verify HTTP ${verifyResponse.status}`);
  if (verifyResponse.ok) console.log(jsonPreview(parseJson(verifyBody), 2000));
  else console.log(`  ${errorDetail(parseJson(verifyBody), verifyBody)}`);

  console.log('Registration complete. Next: npm run probe:tesla');
}

async function safeGet(path, accessToken, label) {
  try {
    return { ok: true, data: await apiGet(path, accessToken) };
  } catch (error) {
    console.log(`  ${label}: ${error.message}`);
    return { ok: false, error };
  }
}

function collectValues(node, predicate, output = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectValues(item, predicate, output);
    return output;
  }
  if (!node || typeof node !== 'object') return output;
  if (predicate(node)) output.push(node);
  for (const value of Object.values(node)) collectValues(value, predicate, output);
  return output;
}

export function findEnergySites(payload) {
  const sites = new Map();
  const candidates = collectValues(payload, (node) => (
    node.energy_site_id !== undefined && node.energy_site_id !== null
  ));

  for (const node of candidates) {
    const key = String(node.energy_site_id);
    const site = sites.get(key) || {
      energy_site_id: node.energy_site_id,
      hasWallConnector: false,
    };
    for (const field of ['site_name', 'resource_type', 'id', 'device_type', 'asset_type', 'product_type']) {
      if (node[field] !== undefined && node[field] !== null) site[field] = node[field];
    }
    if (Array.isArray(node.wall_connectors) && node.wall_connectors.length) {
      site.hasWallConnector = true;
    }
    const types = [node.resource_type, node.device_type, node.asset_type, node.product_type]
      .filter(Boolean)
      .join(' ');
    if (/wall[\s_-]*connector/i.test(types)) site.hasWallConnector = true;
    sites.set(key, site);
  }

  return [...sites.values()];
}

function looksLikeSession(item) {
  return Object.keys(item).some((key) => (
    /(^|_)(start|end|energy|session|charge)/i.test(key)
  ));
}

export function collectChargeSessions(payload) {
  const arrays = [];

  function visit(node) {
    if (Array.isArray(node)) {
      if (node.length
        && node.every((item) => item && typeof item === 'object' && !Array.isArray(item))
        && node.some(looksLikeSession)) {
        arrays.push(node);
      }
      node.forEach(visit);
      return;
    }
    if (node && typeof node === 'object') {
      Object.values(node).forEach(visit);
    }
  }

  visit(payload);
  if (!arrays.length) return [];
  arrays.sort((a, b) => b.length - a.length);
  return arrays[0];
}

function scalarText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'value', 'id', 'uuid', 'name']) {
      if (value[key] !== undefined && value[key] !== null) return scalarText(value[key]);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

function secondsOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    for (const key of ['seconds', 'value']) {
      const parsed = secondsOf(value[key]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function energyWhOf(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object') {
    for (const key of ['value', 'wh', 'energy_added_wh', 'watt_hours']) {
      if (value[key] !== undefined && value[key] !== null) return energyWhOf(value[key]);
    }
  }
  return 0;
}

function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds)) return '(unknown)';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(seconds * 1000));
}

export function summarizeSessionIdentifiers(sessions) {
  const groups = new Map();

  for (const session of sessions) {
    const targetId = scalarText(session?.target_id) || '(missing)';
    const din = scalarText(session?.din) || '(missing)';
    const key = `${targetId}\u0000${din}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        targetId,
        din,
        count: 0,
        firstStartSeconds: null,
        lastStartSeconds: null,
        totalEnergyWh: 0,
      };
      groups.set(key, group);
    }

    group.count += 1;
    const start = secondsOf(session?.charge_start_time);
    if (start !== null) {
      if (group.firstStartSeconds === null || start < group.firstStartSeconds) {
        group.firstStartSeconds = start;
      }
      if (group.lastStartSeconds === null || start > group.lastStartSeconds) {
        group.lastStartSeconds = start;
      }
    }
    group.totalEnergyWh += energyWhOf(session?.energy_added_wh);
  }

  const sortedGroups = [...groups.values()].sort((a, b) => (
    b.count - a.count
    || a.targetId.localeCompare(b.targetId)
    || a.din.localeCompare(b.din)
  ));

  return {
    sessionCount: sessions.length,
    uniqueTargetIds: [...new Set(sortedGroups.map((group) => group.targetId))],
    uniqueDins: [...new Set(sortedGroups.map((group) => group.din))],
    groups: sortedGroups,
  };
}

function printSessionIdentifiers(sessions) {
  const summary = summarizeSessionIdentifiers(sessions);
  console.log(`  identifier summary: ${summary.sessionCount} session(s), ${summary.uniqueTargetIds.length} target_id(s), ${summary.uniqueDins.length} din(s)`);
  for (const group of summary.groups.slice(0, 20)) {
    console.log(`  - target_id=${group.targetId} din=${group.din} sessions=${group.count} first=${formatTimestamp(group.firstStartSeconds)} last=${formatTimestamp(group.lastStartSeconds)} energy=${(group.totalEnergyWh / 1000).toFixed(1)}kWh`);
  }
  if (summary.groups.length > 20) {
    console.log(`  ... ${summary.groups.length - 20} more group(s) not shown`);
  }
}

export function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|authorization|cookie/i.test(key)) {
      output[key] = '[redacted]';
    } else if (/vin/i.test(key) && typeof item === 'string') {
      output[key] = item.length > 4 ? `***${item.slice(-4)}` : '***';
    } else if (/address|latitude|longitude|(^|_)location($|_)|email|phone|contact_(info|email|phone)/i.test(key)) {
      output[key] = '[redacted]';
    } else {
      output[key] = redactSensitive(item);
    }
  }
  return output;
}

function hasWallConnectorMarkers(value) {
  const text = JSON.stringify(value || '').toLowerCase();
  return text.includes('wall_connector')
    || text.includes('wall connector')
    || text.includes('wall_box')
    || text.includes('wallbox');
}

function jsonPreview(value, maxLength = 6000) {
  return JSON.stringify(redactSensitive(value), null, 2).slice(0, maxLength);
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function setupText() {
  return `Missing TESLA_CLIENT_ID or TESLA_CLIENT_SECRET.

Tesla side setup:
1. Sign in at https://developer.tesla.com/dashboard and enable MFA.
2. Create a Fleet API application as "Just for me".
3. Allowed origins: ${redirect.origin} and https://${DOMAIN_DISPLAY}
4. Allowed redirect URI: ${REDIRECT_URI}
5. Grant type: Authorization Code.
6. Scopes: Energy Product Information (energy_device_data).
7. Host the public key at https://${DOMAIN_DISPLAY}/.well-known/appspecific/com.tesla.3p.public-key.pem
8. Add a payment method and a small billing limit; with no payment method the limit is 0.
9. After approval, copy the Client ID and Client Secret.

Local setup:
Create tools/.env.tesla.local with:
TESLA_CLIENT_ID=your_client_id
TESLA_CLIENT_SECRET=your_client_secret
TESLA_DOMAIN=your-user.github.io

Do not paste the secret into chat and do not commit that file.`;
}

function printUsage() {
  console.log(`Usage:
  npm run probe:tesla
  npm run probe:tesla -- --register

Read-only Fleet API probe. It lists products, charger live status, and charge
history. It never writes to the Sheet, and it saves tokens locally only when
--save-refresh-token is given.

--register  Register TESLA_DOMAIN with Tesla Fleet API (writes account config).
--save-refresh-token  Save a new Tesla refresh token locally (mode 600).

Optional environment variables:
  TESLA_REDIRECT_URI       default ${DEFAULT_REDIRECT_URI}
  TESLA_FLEET_BASE_URL     default ${DEFAULT_BASE_URL}
  TESLA_DOMAIN             public app origin host (required for --register; e.g. your-user.github.io)
  TESLA_PROBE_DAYS         default 90
  TESLA_PROBE_TIME_ZONE    default Asia/Hong_Kong
  TESLA_PROBE_RAW=1        print sanitized raw JSON responses
  TESLA_PROBE_IDS=1        print unique target_id/din groups

The redirect URI in Tesla's app must match TESLA_REDIRECT_URI exactly.`);
}

function validateCredentials() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(setupText());
  }
}

function validateConfig() {
  if (redirect.protocol !== 'http:') {
    throw new Error('The local probe only supports an http:// redirect URI.');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(CALLBACK_HOST)) {
    throw new Error('The redirect URI must use localhost, 127.0.0.1, or ::1.');
  }
  validateCredentials();
}

function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    const host = CALLBACK_HOST === 'localhost' ? '127.0.0.1' : CALLBACK_HOST;
    const onError = (error) => {
      server.removeListener('error', onError);
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${PORT} is busy. Stop the other process or change TESLA_REDIRECT_URI and the Tesla app redirect URI together.`));
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.listen({ port: PORT, host }, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

async function waitForAuthCode() {
  const state = randomBytes(24).toString('hex');
  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt_missing_scopes', 'true');

  return new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer((req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Method not allowed');
        return;
      }

      const url = new URL(req.url || '/', REDIRECT_URI);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      if (error) {
        finish();
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h1>授權失敗</h1><p>請返去終端機睇錯誤訊息。</p>');
        reject(new Error(`Authorization failed: ${error}${errorDescription ? ` - ${errorDescription}` : ''}`));
        return;
      }
      if (returnedState !== state) {
        finish();
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h1>驗證失敗</h1><p>OAuth state 不一致。</p>');
        reject(new Error('OAuth state mismatch; no token was requested.'));
        return;
      }
      if (!code) {
        finish();
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h1>沒有授權碼</h1>');
        reject(new Error('Tesla callback did not include a code.'));
        return;
      }

      finish();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>授權完成</h1><p>可以關閉此分頁，返去終端機睇結果。</p>');
      resolve(code);
    });

    const timer = setTimeout(() => {
      finish();
      reject(new Error('Timed out waiting for the Tesla callback (5 minutes).'));
    }, 5 * 60 * 1000);
    timer.unref();

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
    }

    server.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    listenLoopback(server)
      .then(() => {
        console.log(`Waiting for callback at ${REDIRECT_URI}`);
        console.log('Open this URL in your browser to authorize:');
        console.log(authUrl.toString());
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function exchangeCode(code) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    audience: BASE_URL,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  });

  const response = await http2Request(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const json = parseJson(response.body);
  if (response.status !== 200 || !json || !json.access_token) {
    throw new Error(`Token exchange failed (HTTP ${response.status}): ${errorDetail(json, response.body)}`);
  }

  console.log(`Token acquired; granted scope: ${json.scope || '(not returned)'}; expires in ${json.expires_in || '?'}s.`);
  if (json.refresh_token) {
    console.log(SAVE_REFRESH
      ? 'Refresh token received; saving locally.'
      : 'Refresh token received but not saved (read-only probe).');
  }
  printTokenClaims(json.access_token);
  return json;
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function printTokenClaims(token) {
  const claims = decodeJwtPayload(token);
  if (!claims) {
    console.log('Token claims: unavailable (not a JWT).');
    return;
  }
  const audience = Array.isArray(claims.aud) ? claims.aud.join(', ') : claims.aud;
  const scopes = Array.isArray(claims.scp) ? claims.scp.join(' ') : claims.scp;
  console.log(`Token claims: aud=${audience || '(none)'} scp=${scopes || '(none)'} ou_code=${claims.ou_code || '(none)'}`);
  if (scopes && !scopes.includes('energy_device_data')) {
    console.log('Warning: energy_device_data is not in the token scopes.');
  }
}

async function getChargeHistory(siteId, accessToken) {
  const end = new Date();
  const start = new Date(end.getTime() - PROBE_DAYS * 86400000);
  const ranges = [
    { start_date: ymd(start), end_date: ymd(end) },
    { start_date: start.toISOString(), end_date: end.toISOString() },
  ];
  let lastError = null;

  for (const range of ranges) {
    const params = new URLSearchParams({
      kind: 'charge',
      ...range,
      time_zone: TIME_ZONE,
    });
    const path = `/api/1/energy_sites/${encodeURIComponent(String(siteId))}/telemetry_history?${params}`;
    try {
      const data = await apiGet(path, accessToken);
      const sessions = collectChargeSessions(data);
      console.log(`  charge history: ${sessions.length} session(s) in the last ${PROBE_DAYS} day(s).`);
      if (sessions.length) {
        const fields = [...new Set(sessions.flatMap((session) => Object.keys(session)))];
        console.log(`  session fields: ${fields.join(', ')}`);
        console.log(jsonPreview(sessions.slice(0, 3), 4000));
        if (INSPECT_IDS) printSessionIdentifiers(sessions);
      } else {
        console.log('  No sessions in range. This does not prove the charger is missing; set TESLA_PROBE_DAYS=365 and rerun.');
      }
      if (RAW) console.log(jsonPreview(data));
      return { ok: true, sessions };
    } catch (error) {
      lastError = error;
      if (!/HTTP 400|HTTP 422/.test(error.message)) break;
    }
  }

  console.log(`  charge history: ${lastError ? lastError.message : 'unknown error'}`);
  return { ok: false, error: lastError };
}

async function main() {
  if (process.argv.includes('--help')) {
    printUsage();
    return;
  }
  if (SAVE_REFRESH && process.argv.includes('--register')) {
    throw new Error('Use either --register or --save-refresh-token, not both.');
  }
  if (process.argv.includes('--register')) {
    await registerPartner();
    return;
  }

  validateConfig();
  console.log('Tesla Fleet API read-only probe');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  console.log(`Scope: ${SCOPE}`);
  console.log(`Charge history: last ${PROBE_DAYS} day(s), time_zone=${TIME_ZONE}`);

  const code = await waitForAuthCode();
  const token = await exchangeCode(code);

  if (SAVE_REFRESH) {
    if (!token.refresh_token) {
      throw new Error('Tesla did not return a refresh token. Revoke the app grant in the Tesla account and retry.');
    }
    writeRefreshTokenFile(REFRESH_TOKEN_FILE, token.refresh_token);
    console.log(`Refresh token saved to ${REFRESH_TOKEN_FILE} (mode 600).`);
    console.log('Do not commit this file. Copy the value into Apps Script Script Properties as TESLA_REFRESH_TOKEN.');
    return;
  }

  const region = await safeGet('/api/1/users/region', token.access_token, 'users/region');
  if (region.ok) {
    console.log(`  user region: ${JSON.stringify(redactSensitive(region.data)).slice(0, 600)}`);
  }

  let products;
  try {
    products = await apiGet('/api/1/products', token.access_token);
  } catch (error) {
    console.log(`\n/api/1/products failed: ${error.message}`);
    console.log('The token was accepted, but the products endpoint is unavailable. Check:');
    console.log('- the app was created as "Just for me", not a business app');
    console.log('- the app has the Energy Product Information (energy_device_data) scope');
    console.log('- the app is approved and its plan includes energy endpoints');
    console.log('- the token audience matches the region (HK should use the NA base URL)');
    process.exitCode = 4;
    return;
  }
  const sites = findEnergySites(products);

  console.log(`\nEnergy sites found in /products: ${sites.length}`);
  for (const site of sites) {
    const parts = [`energy_site_id=${site.energy_site_id}`];
    if (site.site_name) parts.push(`site_name=${site.site_name}`);
    if (site.resource_type) parts.push(`resource_type=${site.resource_type}`);
    if (site.device_type) parts.push(`device_type=${site.device_type}`);
    parts.push(`wall_connector=${site.hasWallConnector ? 'yes' : 'not marked'}`);
    console.log(`- ${parts.join(' ')}`);
  }

  if (RAW) console.log(jsonPreview(products));

  if (!sites.length) {
    console.log('\nNo energy_site_id was returned. Check that the Wall Connector is linked to the same Tesla account, online, and that the app has energy_device_data scope.');
    console.log(jsonPreview(products));
    process.exitCode = 2;
    return;
  }

  let wallConnectorConfirmed = sites.some((site) => site.hasWallConnector);

  for (const site of sites) {
    const siteId = site.energy_site_id;
    const encodedSiteId = encodeURIComponent(String(siteId));
    console.log(`\nChecking energy_site_id=${siteId}`);

    const live = await safeGet(`/api/1/energy_sites/${encodedSiteId}/charger_live_status`, token.access_token, 'charger_live_status');
    if (live.ok) {
      const keys = Object.keys(live.data || {});
      console.log(`  charger_live_status keys: ${keys.join(', ') || '(empty)'}`);
      if (hasWallConnectorMarkers(live.data)) wallConnectorConfirmed = true;
      if (RAW) console.log(jsonPreview(live.data));
    }

    const siteInfo = await safeGet(`/api/1/energy_sites/${encodedSiteId}/site_info`, token.access_token, 'site_info');
    if (siteInfo.ok) {
      if (hasWallConnectorMarkers(siteInfo.data)) wallConnectorConfirmed = true;
      if (RAW) console.log(jsonPreview(siteInfo.data));
    }

    const history = await getChargeHistory(siteId, token.access_token);
    if (history.ok && history.sessions.length) wallConnectorConfirmed = true;
  }

  if (wallConnectorConfirmed) {
    console.log('\nResult: Wall Connector is visible through the official Fleet API.');
    console.log('Probe complete. No Sheet rows or local token files were written.');
  } else {
    console.log('\nResult: Energy site is visible, but no explicit Wall Connector marker or charge session was found.');
    console.log('Run with TESLA_PROBE_DAYS=365 and TESLA_PROBE_RAW=1 to inspect the full response.');
    process.exitCode = 3;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error(`\nProbe failed: ${error.message}`);
    process.exitCode = 1;
  });
}
