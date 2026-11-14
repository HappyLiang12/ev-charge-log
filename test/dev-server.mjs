import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const port = Number(process.env.PORT || 8787);
const apiUrl = process.env.SMOKE_API_URL || `http://127.0.0.1:${port}/api`;
const records = [];
const delayMs = Number(process.env.SMOKE_DELAY_MS || 0);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api') {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, records });
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        if (data.action === 'delete') {
          const index = records.findIndex((record) => record.id === data.id);
          if (index >= 0) records.splice(index, 1);
          sendJson(res, 200, { ok: true });
          return;
        }
        if (!records.some((record) => record.id === data.id)) {
          records.push({ id: data.id, startAt: data.startAt });
        }
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid payload' });
      }
      return;
    }
  }

  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (path === '/config.js') {
    res.writeHead(200, { 'Content-Type': types['.js'] });
    res.end(`window.APP_CONFIG = { API_URL: '${apiUrl}', SHEET_URL: '' };\n`);
    return;
  }

  try {
    const filePath = normalize(join(root, path));
    if (!filePath.startsWith(`${root}/`)) throw new Error('forbidden');
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dev server: http://127.0.0.1:${port}`);
  console.log(`mock API:  ${apiUrl}`);
});
