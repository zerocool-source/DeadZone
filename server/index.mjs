#!/usr/bin/env node
// DeadZone dedicated server — self-hosted, no third-party platform.
//
//   node server/index.mjs            # play at http://localhost:8080
//   node server/index.mjs --port 9000
//   PORT=9000 node server/index.mjs
//
// Serves the game over HTTP and runs the SAME authoritative simulation the
// hosted build uses: pvp/server.js exports `GameServer`, written against the
// Cloudflare Durable Object shape. The only thing that class needs from the
// platform is a base class to extend and a socket that looks like a browser
// WebSocket, so this file supplies both and nothing else changes.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', 'pvp');

const argv = process.argv.slice(2);
const argPort = argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : null;
const PORT = parseInt(argPort || process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

// ---- load the game rules, swapping the platform base class for a plain one --
const src = await readFile(join(ROOT, 'server.js'), 'utf8');
const patched = src.replace(
  /import\s*\{\s*DurableObject\s*\}\s*from\s*['"]cloudflare:workers['"];?/,
  'class DurableObject { constructor() {} }');
if (patched === src) {
  console.error('server/index.mjs: could not find the cloudflare:workers import in pvp/server.js');
  process.exit(1);
}
const { GameServer } = await import(
  'data:text/javascript;base64,' + Buffer.from(patched).toString('base64'));

// ---- rooms -----------------------------------------------------------------
const rooms = new Map();
function roomFor(id) {
  if (!rooms.has(id)) rooms.set(id, { game: new GameServer(null, null), sockets: new Set() });
  return rooms.get(id);
}

// ---- static files ----------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.csv': 'text/csv', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url || '/').split('?')[0]);
    if (path === '/' || path === '') path = '/index.html';
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, rooms: rooms.size,
        players: [...rooms.values()].reduce((n, r) => n + r.sockets.size, 0),
      }));
      return;
    }
    // contain every request inside pvp/ — no traversal out of the game folder
    const file = resolve(join(ROOT, normalize(path)));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const info = await stat(file);
    if (info.isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      // assets are content-addressed by name here, so keep the browser honest
      'Cache-Control': path === '/index.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

// ---- websockets: /ws/<room> ------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const m = (req.url || '').match(/^\/ws\/([\w-]{1,32})/);
  if (!m) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, conn => {
    const room = roomFor(m[1]);
    // the rules module speaks the browser WebSocket shape: send + close
    const adapter = {
      send: data => { if (conn.readyState === 1) conn.send(data); },
      close: () => conn.close(),
    };
    room.sockets.add(conn);
    conn.on('message', data => {
      try { room.game.onMessage(adapter, { data: data.toString() }); }
      catch (err) { console.error(`[${m[1]}] message error:`, err.message); }
    });
    const drop = () => {
      room.sockets.delete(conn);
      try { room.game.onClose(adapter); } catch {}
      // reclaim the room once the last player leaves so memory does not creep
      if (room.sockets.size === 0) {
        setTimeout(() => { if (room.sockets.size === 0) rooms.delete(m[1]); }, 30000);
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const lan = lanAddresses();
  console.log('');
  console.log('  DEADZONE dedicated server');
  console.log('  ─────────────────────────');
  console.log(`  play here      http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  on your LAN    http://${ip}:${PORT}`);
  console.log(`  health check   http://localhost:${PORT}/health`);
  console.log('');
  console.log('  Everyone who opens the SAME ?room=<name> lands in the same match.');
  console.log('  Ctrl+C to stop.');
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nshutting down…');
    for (const room of rooms.values()) for (const c of room.sockets) c.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
