import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../analysis');
const R = '4883545741242523653';
http
  .createServer((_req, res) => {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(dir, R + '.html'), 'utf8'));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  })
  .listen(7799, '127.0.0.1');
