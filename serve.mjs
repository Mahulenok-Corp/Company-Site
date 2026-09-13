#!/usr/bin/env node
/**
 * Локальный предпросмотр собранного сайта (папка dist/).
 *   node serve.mjs            → http://localhost:8080
 *   PORT=3000 node serve.mjs  → другой порт
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT) || 8080;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

if (!existsSync(root)) {
  console.error('Папки dist/ нет. Сначала соберите сайт: node configure.mjs');
  process.exit(1);
}

createServer(async (req, res) => {
  const send = (status, body, type = types['.html']) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) return send(403, 'Forbidden', types['.txt']);
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
    send(200, await readFile(file), types[extname(file).toLowerCase()] || 'application/octet-stream');
  } catch {
    const notFound = await readFile(join(root, '404.html')).catch(() => 'Not found');
    send(404, notFound);
  }
}).listen(port, () => console.log(`Предпросмотр: http://localhost:${port}/   (Ctrl+C — остановить)`));
