// Local netcode harness: runs pvp/server.js's GameServer on Node with a
// real WebSocket bridge + static file server, mimicking the platform's
// /ws/<room> routing. Dev-only; not shipped in the game zip.
import http from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { WebSocketServer } from 'ws';

const root = new URL('../pvp', import.meta.url).pathname;
const PORT = parseInt(process.argv[2] || '8920', 10);

// load server.js with the cloudflare import stubbed
const src = await readFile(join(root, 'server.js'), 'utf8');
const patched = src.replace(
  "import { DurableObject } from 'cloudflare:workers';",
  'class DurableObject { constructor() {} }');
const mod = await import('data:text/javascript;base64,' + Buffer.from(patched).toString('base64'));
const rooms = new Map();
const gameFor = room => {
  if (!rooms.has(room)) rooms.set(room, new mod.GameServer(null, null));
  return rooms.get(room);
};

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.csv': 'text/csv' };
const server = http.createServer(async (req, res) => {
  // test-only debug hooks (never shipped: this harness is dev tooling)
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/debug/teleport') {
    const gs = gameFor(u.searchParams.get('room'));
    for (const p of gs.byId.values()) {
      if (p.name === u.searchParams.get('name')) {
        p.x = +u.searchParams.get('x'); p.z = +u.searchParams.get('z'); p.y = 0;
      }
    }
    res.writeHead(200); res.end('ok'); return;
  }
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const data = await readFile(join(root, p));
    res.writeHead(200, { 'Content-Type': mime[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const m = req.url.match(/\/ws\/([\w-]+)/);
  if (!m) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, conn => {
    const gs = gameFor(m[1]);
    const adapter = {
      send: d => { if (conn.readyState === 1) conn.send(d); },
      close: () => conn.close(),
    };
    conn.on('message', d => gs.onMessage(adapter, { data: d.toString() }));
    conn.on('close', () => gs.onClose(adapter));
  });
});

server.listen(PORT, () => console.log('local-net on http://localhost:' + PORT));
