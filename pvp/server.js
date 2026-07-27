// DeadZone: Wasteland PvP — authoritative realtime server.
// One GameServer instance runs per room shard (/ws/<room>); it owns the
// simulation: movement, hitscan, damage, pickups, respawns, match flow.
// Clients only send inputs and render snapshots.
import { DurableObject } from 'cloudflare:workers';

// Shared world definition — the same function is embedded verbatim in
// server.js (which may not import local modules). KEEP THE TWO COPIES
// BYTE-IDENTICAL: collision, spawns and pickups must match on both sides.
export function buildWorld() {
  let s = 1337 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const obstacles = []; // axis-aligned boxes {x1,z1,x2,z2,h,kind}
  const add = (cx, cz, w, d, h, kind) =>
    obstacles.push({ x1: cx - w / 2, z1: cz - d / 2, x2: cx + w / 2, z2: cz + d / 2, h, kind });

  const SIZE = 88; // half-extent of the arena

  // perimeter walls
  add(0, -SIZE - 1.5, SIZE * 2 + 6, 3, 7, 'wall');
  add(0, SIZE + 1.5, SIZE * 2 + 6, 3, 7, 'wall');
  add(-SIZE - 1.5, 0, 3, SIZE * 2 + 6, 7, 'wall');
  add(SIZE + 1.5, 0, 3, SIZE * 2 + 6, 7, 'wall');

  // six ruined building shells on a ring, door gaps facing center
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.35;
    const cx = Math.cos(a) * 46, cz = Math.sin(a) * 46;
    const w = 12 + rnd() * 6, d = 10 + rnd() * 5, h = 3.2 + rnd() * 2.2;
    // four walls with a gap in the center-facing one
    add(cx, cz - d / 2, w, 0.9, h, 'ruin');                       // far
    add(cx - w / 2, cz, 0.9, d, h, 'ruin');                       // left
    add(cx + w / 2, cz, 0.9, d, h, 'ruin');                       // right
    const gap = 3.2;
    add(cx - w / 4 - gap / 4, cz + d / 2, w / 2 - gap / 2, 0.9, h, 'ruin'); // near-left
    add(cx + w / 4 + gap / 4, cz + d / 2, w / 2 - gap / 2, 0.9, h, 'ruin'); // near-right
  }

  // central compound: broken cross walls around the middle
  add(0, -8, 16, 1.1, 2.6, 'ruin');
  add(-8, 4, 1.1, 14, 2.6, 'ruin');
  add(9, 6, 10, 1.1, 2.2, 'ruin');

  // cargo containers
  for (let i = 0; i < 14; i++) {
    const cx = (rnd() * 2 - 1) * (SIZE - 14);
    const cz = (rnd() * 2 - 1) * (SIZE - 14);
    if (Math.hypot(cx, cz) < 14) continue;
    add(cx, cz, 6.2, 2.5, 2.6, 'container');
  }

  // low rubble walls (waist height cover)
  for (let i = 0; i < 18; i++) {
    const cx = (rnd() * 2 - 1) * (SIZE - 10);
    const cz = (rnd() * 2 - 1) * (SIZE - 10);
    const horiz = rnd() > 0.5;
    add(cx, cz, horiz ? 5 + rnd() * 3 : 1, horiz ? 1 : 5 + rnd() * 3, 1.1, 'rubble');
  }

  // rocks
  for (let i = 0; i < 16; i++) {
    const cx = (rnd() * 2 - 1) * (SIZE - 6);
    const cz = (rnd() * 2 - 1) * (SIZE - 6);
    const r = 1 + rnd() * 2.2;
    add(cx, cz, r, r, 0.8 + rnd() * 1.6, 'rock');
  }

  // spawn points: outer ring
  const spawns = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.15;
    spawns.push({ x: Math.cos(a) * 70, z: Math.sin(a) * 70 });
  }

  // pickups: weapons near the middle, health on the ring
  const pickups = [
    { id: 0, type: 'shotgun', x: 0, z: 16 },
    { id: 1, type: 'shotgun', x: -40, z: -38 },
    { id: 2, type: 'longshot', x: 0, z: -16 },
    { id: 3, type: 'longshot', x: 42, z: 40 },
    { id: 4, type: 'health', x: -60, z: 0 },
    { id: 5, type: 'health', x: 60, z: 0 },
    { id: 6, type: 'health', x: 0, z: 60 },
    { id: 7, type: 'health', x: 0, z: -60 },
  ];

  return { size: SIZE, obstacles, spawns, pickups };
}

// --- tuning (mirror of client constants; server values are authoritative)
const TICK_MS = 50;                 // 20 Hz simulation + snapshots
const WALK = 5.2, SPRINT = 7.6;     // m/s
const GRAV = -22, JUMP_V = 7.5;
const PLAYER_R = 0.45;
const KILL_TARGET = 15;
const RESPAWN_S = 3;
const INTERMISSION_S = 8;
const PICKUP_RESPAWN_S = 25;
const MAX_PLAYERS = 8;
// bots keep rooms alive: fill to TARGET_COMBATANTS, retire as humans join
const TARGET_COMBATANTS = 4;
const BOT_NAMES = ['VULTURE', 'JACKAL', 'RUST', 'ASH', 'CROW', 'HOLLOW', 'GRIM'];
const BOT_DIFFS = [
  { aimErr: 0.10, react: 900, burst: 3 },   // easy
  { aimErr: 0.055, react: 550, burst: 5 },  // normal
  { aimErr: 0.03, react: 320, burst: 7 },   // hard
];
const GRENADE_FUSE = 2.2, GRENADE_RADIUS = 7, GRENADE_DMG = 85, GRENADE_CD = 8000;
const WEAPONS = {
  rifle:    { dmg: 16, rpm: 540, range: 80,  pellets: 1, spread: 0.022, mag: 30, reload: 1.8 },
  shotgun:  { dmg: 9,  rpm: 85,  range: 24,  pellets: 8, spread: 0.09,  mag: 6,  reload: 2.4 },
  longshot: { dmg: 70, rpm: 45,  range: 130, pellets: 1, spread: 0.003, mag: 5,  reload: 2.6 },
};

// ray vs AABB (slab), returns t or Infinity; boxes rise from y=0 to h
function rayBox(ox, oy, oz, dx, dy, dz, b) {
  let tmin = 0, tmax = Infinity;
  const axes = [[ox, dx, b.x1, b.x2], [oy, dy, 0, b.h], [oz, dz, b.z1, b.z2]];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return Infinity; continue; }
    let t1 = (lo - o) / d, t2 = (hi - o) / d;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

// ray vs sphere, returns t or Infinity
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return Infinity;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return Infinity;
  return tca - Math.sqrt(r * r - d2);
}

export class GameServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.world = buildWorld();
    this.players = new Map();      // ws -> player
    this.byId = new Map();         // id -> player
    this.pickups = this.world.pickups.map(p => ({ ...p, active: true, respawnAt: 0 }));
    this.events = [];              // transient, flushed with each snapshot
    this.phase = 'play';           // play | over
    this.winner = null;
    this.phaseEndsAt = 0;
    this.nextId = 1;
    this.timer = null;
    this.grenades = [];
  }

  // ---- bots ---------------------------------------------------------------
  humanCount() { return this.players.size; }
  botCount() { return [...this.byId.values()].filter(p => p.bot).length; }

  balanceBots() {
    const want = Math.max(0, Math.min(TARGET_COMBATANTS - this.humanCount(),
      MAX_PLAYERS - this.humanCount()));
    let have = this.botCount();
    while (have < want) {
      const used = new Set([...this.byId.values()].map(p => p.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || ('BOT' + this.nextId);
      const p = this.spawnPlayer(name);
      p.bot = true;
      p.diff = BOT_DIFFS[(Math.random() * BOT_DIFFS.length) | 0];
      p.ai = { wp: null, targetId: 0, sawAt: 0, burstLeft: 0, nextShotAt: 0, stuck: 0, lastX: p.x, lastZ: p.z, strafe: 1 };
      this.byId.set(p.id, p);
      this.events.push(['join', p.id, p.name]);
      have++;
    }
    while (have > want) {
      const bot = [...this.byId.values()].find(p => p.bot);
      if (!bot) break;
      this.byId.delete(bot.id);
      this.events.push(['leave', bot.id, bot.name]);
      have--;
    }
  }

  // line of sight between two players' eye positions
  los(a, b) {
    const ox = a.x, oy = a.y + 1.55, oz = a.z;
    let dx = b.x - ox, dy = (b.y + 1.2) - oy, dz = b.z - oz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return true;
    dx /= dist; dy /= dist; dz /= dist;
    for (const bx of this.world.obstacles) {
      if (rayBox(ox, oy, oz, dx, dy, dz, bx) < dist) return false;
    }
    return true;
  }

  botThink(p, dt, now) {
    const ai = p.ai;
    // acquire nearest visible enemy
    let target = this.byId.get(ai.targetId);
    if (!target || target.hp <= 0 || target.id === p.id) { target = null; ai.targetId = 0; }
    if (!target || Math.random() < 0.05) {
      let bestD = 65;
      for (const o of this.byId.values()) {
        if (o === p || o.hp <= 0) continue;
        const d = Math.hypot(o.x - p.x, o.z - p.z);
        if (d < bestD && this.los(p, o)) { bestD = d; target = o; }
      }
      if (target && ai.targetId !== target.id) {
        ai.targetId = target.id;
        ai.sawAt = now;
        ai.burstLeft = 0;
      }
    }

    if (target && this.los(p, target)) {
      // face target (with per-difficulty wobble), strafe, fire in bursts
      const dx = target.x - p.x, dz = target.z - p.z;
      const dist = Math.hypot(dx, dz);
      p.yaw = Math.atan2(-dx, -dz);
      p.input.mx = ai.strafe * (dist < 30 ? 0.7 : 0.25);
      p.input.mz = dist > 22 ? 0.8 : (dist < 9 ? -0.5 : 0);
      p.input.sprint = dist > 30;
      if (Math.random() < 0.01) ai.strafe = -ai.strafe;
      if (now - ai.sawAt > p.diff.react && now >= ai.nextShotAt && this.phase === 'play') {
        const ex = (Math.random() - 0.5) * 2 * p.diff.aimErr * (1 + dist / 60);
        const ey = (Math.random() - 0.5) * 2 * p.diff.aimErr;
        const dy = (target.y + 1.1) - (p.y + 1.55);
        const len = Math.hypot(dx, dy, dz);
        this.fire(p, [dx / len + ex, dy / len + ey, dz / len + ex * 0.5]);
        if (--ai.burstLeft <= 0) {
          ai.burstLeft = p.diff.burst;
          ai.nextShotAt = now + 420 + Math.random() * 500;
        }
      }
    } else {
      // roam: walk toward a waypoint (spawns/pickups), re-pick when reached/stuck
      if (!ai.wp || Math.hypot(ai.wp.x - p.x, ai.wp.z - p.z) < 3) {
        const pool = [...this.world.spawns, ...this.world.pickups];
        ai.wp = pool[(Math.random() * pool.length) | 0];
      }
      const dx = ai.wp.x - p.x, dz = ai.wp.z - p.z;
      p.yaw = Math.atan2(-dx, -dz);
      p.input.mx = 0; p.input.mz = 0.85; p.input.sprint = Math.random() < 0.4;
      // stuck detection: barely moved for ~1.5s → new waypoint + sidestep
      if (Math.hypot(p.x - ai.lastX, p.z - ai.lastZ) < 0.4 * dt * 10) ai.stuck += dt;
      else ai.stuck = 0;
      ai.lastX = p.x; ai.lastZ = p.z;
      if (ai.stuck > 1.5) { ai.wp = null; ai.stuck = 0; p.yaw += Math.PI / 2; }
    }
  }

  // ---- grenades -----------------------------------------------------------
  throwGrenade(p, d) {
    const now = Date.now();
    if (p.hp <= 0 || this.phase !== 'play') return;
    if (now - (p.lastNade || 0) < GRENADE_CD) return;
    if (!Array.isArray(d) || d.length !== 3 || d.some(v => !Number.isFinite(v))) return;
    let [dx, dy, dz] = d;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    dx /= len; dy /= len; dz /= len;
    p.lastNade = now;
    const SPEED = 16;
    this.grenades.push({
      x: p.x + dx * 0.6, y: p.y + 1.5, z: p.z + dz * 0.6,
      vx: dx * SPEED, vy: dy * SPEED + 3.5, vz: dz * SPEED,
      fuse: GRENADE_FUSE, owner: p.id,
    });
    this.events.push(['nade', p.id]);
  }

  tickGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      g.vy += GRAV * dt;
      g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
      if (g.y <= 0.12 && g.vy < 0) { g.y = 0.12; g.vy = -g.vy * 0.45; g.vx *= 0.7; g.vz *= 0.7; }
      // wall bounce: push out of AABBs, reflect the bigger axis velocity
      for (const b of this.world.obstacles) {
        if (g.y > b.h) continue;
        const nx = Math.max(b.x1, Math.min(g.x, b.x2));
        const nz = Math.max(b.z1, Math.min(g.z, b.z2));
        const ddx = g.x - nx, ddz = g.z - nz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < 0.04 && d2 > 1e-9) {
          const dist = Math.sqrt(d2);
          g.x = nx + (ddx / dist) * 0.2; g.z = nz + (ddz / dist) * 0.2;
          if (Math.abs(ddx) > Math.abs(ddz)) g.vx = -g.vx * 0.5; else g.vz = -g.vz * 0.5;
        }
      }
      const S = this.world.size;
      g.x = Math.max(-S + 0.3, Math.min(S - 0.3, g.x));
      g.z = Math.max(-S + 0.3, Math.min(S - 0.3, g.z));
      if (g.fuse <= 0) {
        this.grenades.splice(i, 1);
        this.events.push(['boom', +g.x.toFixed(1), +g.y.toFixed(1), +g.z.toFixed(1)]);
        const owner = this.byId.get(g.owner);
        for (const o of this.byId.values()) {
          if (o.hp <= 0) continue;
          const d = Math.hypot(o.x - g.x, (o.y + 1) - g.y, o.z - g.z);
          if (d > GRENADE_RADIUS) continue;
          // half damage through walls
          const blocked = !this.losPoint(g.x, Math.max(0.4, g.y), g.z, o);
          const dmg = Math.round(GRENADE_DMG * (1 - d / GRENADE_RADIUS) * (blocked ? 0.35 : 1));
          if (dmg <= 0) continue;
          o.hp -= dmg;
          this.events.push(['hit', g.owner, o.id, dmg, 0]);
          if (o.hp <= 0 && owner && owner !== o) this.onKill(owner, o);
          else if (o.hp <= 0) { o.hp = 0; o.deaths++; o.respawn = RESPAWN_S; this.events.push(['kill', o.id, o.id, 'grenade']); }
        }
      }
    }
  }

  losPoint(x, y, z, o) {
    let dx = o.x - x, dy = (o.y + 1) - y, dz = o.z - z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return true;
    dx /= dist; dy /= dist; dz /= dist;
    for (const b of this.world.obstacles) {
      if (rayBox(x, y, z, dx, dy, dz, b) < dist) return false;
    }
    return true;
  }

  fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, ws] = Object.values(pair);
    ws.accept();
    ws.addEventListener('message', e => this.onMessage(ws, e));
    ws.addEventListener('close', () => this.onClose(ws));
    ws.addEventListener('error', () => this.onClose(ws));
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws, e) {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const p = this.players.get(ws);

    if (m.t === 'j' && !p) {                         // join
      if (this.players.size >= MAX_PLAYERS) {
        try { ws.send(JSON.stringify({ t: 'full' })); ws.close(); } catch {}
        return;
      }
      const player = this.spawnPlayer(String(m.name || '').slice(0, 14) || 'DRIFTER');
      this.players.set(ws, player);
      this.byId.set(player.id, player);
      this.events.push(['join', player.id, player.name]);
      try {
        ws.send(JSON.stringify({ t: 'w', id: player.id, killTarget: KILL_TARGET }));
      } catch {}
      this.balanceBots();
      this.startTicking();
      return;
    }
    if (!p) return;

    if (m.t === 'i') {                               // input state
      const num = v => (Number.isFinite(v) ? v : 0);
      p.input.mx = Math.max(-1, Math.min(1, num(m.mx)));
      p.input.mz = Math.max(-1, Math.min(1, num(m.mz)));
      p.input.sprint = !!m.sp;
      p.input.jump = !!m.jp;
      p.yaw = num(m.yaw) % (Math.PI * 2);
      p.pitch = Math.max(-1.55, Math.min(1.55, num(m.pitch)));
    } else if (m.t === 'f') {                        // fire
      this.fire(p, m.d);
    } else if (m.t === 'g') {                        // grenade
      this.throwGrenade(p, m.d);
    } else if (m.t === 'r') {                        // reload
      const w = WEAPONS[p.weapon];
      if (p.hp > 0 && !p.reloading && p.mag < w.mag) {
        p.reloading = w.reload;
        this.events.push(['reload', p.id]);
      }
    }
  }

  onClose(ws) {
    const p = this.players.get(ws);
    if (p) {
      this.players.delete(ws);
      this.byId.delete(p.id);
      this.events.push(['leave', p.id, p.name]);
    }
    if (this.players.size === 0) {
      // room empty: drop bots and stop the clock
      for (const b of [...this.byId.values()]) if (b.bot) this.byId.delete(b.id);
      this.grenades = [];
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    } else {
      this.balanceBots();
    }
  }

  startTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  spawnPlayer(name) {
    const p = {
      id: this.nextId++, name,
      x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0,
      hp: 100, kills: 0, deaths: 0,
      weapon: 'rifle', mag: WEAPONS.rifle.mag, reloading: 0,
      respawn: 0, lastFire: 0,
      input: { mx: 0, mz: 0, sprint: false, jump: false },
    };
    this.placeAtSpawn(p);
    return p;
  }

  placeAtSpawn(p) {
    // furthest spawn from living enemies
    let best = this.world.spawns[0], bestD = -1;
    for (const s of this.world.spawns) {
      let d = Infinity;
      for (const o of this.byId.values()) {
        if (o === p || o.hp <= 0) continue;
        d = Math.min(d, Math.hypot(s.x - o.x, s.z - o.z));
      }
      if (d === Infinity) d = Math.random() * 100; // empty room: any spawn
      if (d > bestD) { bestD = d; best = s; }
    }
    p.x = best.x; p.z = best.z; p.y = 0; p.vy = 0;
    p.yaw = Math.atan2(-best.x, -best.z); // face the center
  }

  fire(p, d) {
    if (p.hp <= 0 || p.reloading > 0 || this.phase !== 'play') return;
    const w = WEAPONS[p.weapon];
    const now = Date.now();
    if (now - p.lastFire < (60000 / w.rpm) * 0.9) return;   // server-side rate cap
    if (p.mag <= 0) return;
    if (!Array.isArray(d) || d.length !== 3 || d.some(v => !Number.isFinite(v))) return;
    let [dx, dy, dz] = d;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    dx /= len; dy /= len; dz /= len;
    p.lastFire = now;
    p.mag--;
    this.events.push(['shot', p.id, p.weapon]);

    const ox = p.x, oy = p.y + 1.55, oz = p.z;
    for (let n = 0; n < w.pellets; n++) {
      const jx = dx + (Math.random() - 0.5) * 2 * w.spread;
      const jy = dy + (Math.random() - 0.5) * 2 * w.spread;
      const jz = dz + (Math.random() - 0.5) * 2 * w.spread;
      const jl = Math.hypot(jx, jy, jz);
      const rx = jx / jl, ry = jy / jl, rz = jz / jl;

      let wallT = w.range;
      for (const b of this.world.obstacles) {
        const t = rayBox(ox, oy, oz, rx, ry, rz, b);
        if (t < wallT) wallT = t;
      }
      let hit = null, hitT = wallT, head = false;
      for (const o of this.byId.values()) {
        if (o === p || o.hp <= 0) continue;
        const tb = raySphere(ox, oy, oz, rx, ry, rz, o.x, o.y + 1.0, o.z, 0.55);
        const th = raySphere(ox, oy, oz, rx, ry, rz, o.x, o.y + 1.62, o.z, 0.3);
        const t = Math.min(tb, th);
        if (t < hitT) { hitT = t; hit = o; head = th < tb; }
      }
      if (hit) {
        const dmg = Math.round(w.dmg * (head ? 1.5 : 1));
        hit.hp -= dmg;
        this.events.push(['hit', p.id, hit.id, dmg, +head]);
        if (hit.hp <= 0) this.onKill(p, hit);
      }
    }
    if (p.mag === 0) { p.reloading = w.reload; this.events.push(['reload', p.id]); }
  }

  onKill(killer, victim) {
    victim.hp = 0;
    victim.deaths++;
    victim.respawn = RESPAWN_S;
    killer.kills++;
    this.events.push(['kill', killer.id, victim.id, killer.weapon]);
    if (killer.kills >= KILL_TARGET && this.phase === 'play') {
      this.phase = 'over';
      this.winner = killer.name;
      this.phaseEndsAt = Date.now() + INTERMISSION_S * 1000;
      this.events.push(['end', killer.id, killer.name]);
    }
  }

  tick() {
    const dt = TICK_MS / 1000;
    const now = Date.now();

    for (const p of this.byId.values()) {
      if (p.bot && p.hp > 0) this.botThink(p, dt, now);
    }
    this.tickGrenades(dt);

    // match reset
    if (this.phase === 'over' && now >= this.phaseEndsAt) {
      this.phase = 'play';
      this.winner = null;
      for (const p of this.byId.values()) {
        p.kills = 0; p.deaths = 0; p.hp = 100; p.respawn = 0;
        p.weapon = 'rifle'; p.mag = WEAPONS.rifle.mag; p.reloading = 0;
        this.placeAtSpawn(p);
      }
      for (const pk of this.pickups) { pk.active = true; pk.respawnAt = 0; }
      this.events.push(['restart']);
    }

    for (const p of this.byId.values()) {
      // respawn countdown
      if (p.hp <= 0) {
        p.respawn -= dt;
        if (p.respawn <= 0) {
          p.hp = 100; p.weapon = 'rifle'; p.mag = WEAPONS.rifle.mag; p.reloading = 0;
          this.placeAtSpawn(p);
          this.events.push(['spawn', p.id]);
        }
        continue;
      }
      // reload
      if (p.reloading > 0) {
        p.reloading -= dt;
        if (p.reloading <= 0) { p.reloading = 0; p.mag = WEAPONS[p.weapon].mag; }
      }
      // movement: rotate input into world space, integrate, collide
      const { mx, mz, sprint, jump } = p.input;
      const l = Math.hypot(mx, mz);
      if (l > 0.01) {
        const nx = mx / Math.max(1, l), nz = mz / Math.max(1, l);
        const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
        const wx = nx * cos - nz * sin;
        const wz = -nx * sin - nz * cos;
        const sp = sprint ? SPRINT : WALK;
        p.x += wx * sp * dt;
        p.z += wz * sp * dt;
      }
      // jump + gravity (ground is y=0 everywhere)
      if (jump && p.y === 0) p.vy = JUMP_V;
      if (p.y > 0 || p.vy > 0) {
        p.vy += GRAV * dt;
        p.y = Math.max(0, p.y + p.vy * dt);
        if (p.y === 0) p.vy = 0;
      }
      // collide with obstacles (circle vs AABB in XZ, only below box top)
      for (const b of this.world.obstacles) {
        if (p.y > b.h - 0.2) continue;
        const nx = Math.max(b.x1, Math.min(p.x, b.x2));
        const nz = Math.max(b.z1, Math.min(p.z, b.z2));
        const ddx = p.x - nx, ddz = p.z - nz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < PLAYER_R * PLAYER_R && d2 > 1e-9) {
          const dist = Math.sqrt(d2);
          p.x = nx + (ddx / dist) * PLAYER_R;
          p.z = nz + (ddz / dist) * PLAYER_R;
        } else if (d2 <= 1e-9) {
          p.x = b.x2 + PLAYER_R; // degenerate: shove out east
        }
      }
      // arena bounds
      const S = this.world.size;
      p.x = Math.max(-S + 0.6, Math.min(S - 0.6, p.x));
      p.z = Math.max(-S + 0.6, Math.min(S - 0.6, p.z));

      // pickups
      for (const pk of this.pickups) {
        if (!pk.active) {
          if (now >= pk.respawnAt) pk.active = true;
          continue;
        }
        if (Math.hypot(pk.x - p.x, pk.z - p.z) < 1.4 && p.y < 1) {
          if (pk.type === 'health') {
            if (p.hp >= 100) continue;
            p.hp = Math.min(100, p.hp + 50);
          } else {
            p.weapon = pk.type;
            p.mag = WEAPONS[pk.type].mag;
            p.reloading = 0;
          }
          pk.active = false;
          pk.respawnAt = now + PICKUP_RESPAWN_S * 1000;
          this.events.push(['pickup', p.id, pk.type]);
        }
      }
    }

    // snapshot
    const snap = JSON.stringify({
      t: 's',
      now,
      ph: this.phase,
      win: this.winner,
      endsIn: this.phase === 'over' ? Math.max(0, this.phaseEndsAt - now) : 0,
      p: [...this.byId.values()].map(p => [
        p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
        +p.yaw.toFixed(3), +p.pitch.toFixed(3),
        p.hp, p.kills, p.deaths, p.weapon, p.mag,
        +(p.reloading > 0), p.name,
      ]),
      pk: this.pickups.map(pk => [pk.id, +pk.active]),
      g: this.grenades.map(g => [+g.x.toFixed(2), +g.y.toFixed(2), +g.z.toFixed(2)]),
      ev: this.events,
    });
    this.events = [];
    for (const ws of this.players.keys()) {
      try { ws.send(snap); } catch {}
    }
  }
}
