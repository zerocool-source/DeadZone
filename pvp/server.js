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
const WALK = 5.2, SPRINT = 7.6, CROUCH_SPEED = 2.5;  // m/s
const STEP_DIST = 2.1;              // metres of travel per footstep event
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
// Difficulty = mechanics. How fast the bot can slew its aim (turn, rad/s), how
// tight a cone it needs before it pulls the trigger (tol), how much its hands
// shake (jitter), how long it takes to react, how well it leads a runner.
const BOT_DIFFS = [
  { react: 620, reactJit: 400, turn: 2.7, gain: 6.5, tol: 0.090, jitter: 0.030,
    burst: 3, burstJit: 2, rest: 520, restJit: 460, lead: 0.35, head: 0.02, nade: 0.4 },
  { react: 380, reactJit: 270, turn: 4.5, gain: 8.5, tol: 0.052, jitter: 0.016,
    burst: 5, burstJit: 3, rest: 380, restJit: 320, lead: 0.70, head: 0.12, nade: 0.6 },
  { react: 210, reactJit: 170, turn: 7.0, gain: 11.0, tol: 0.030, jitter: 0.008,
    burst: 7, burstJit: 4, rest: 260, restJit: 240, lead: 1.00, head: 0.28, nade: 0.8 },
];
// Personality = intent. dist/band is the engagement envelope the bot tries to
// hold, hold is how happy it is to plant instead of dancing around.
const BOT_PERSONAS = [
  { dist: 11, band: 5,  cover: 0.20, flank: 0.15, crouchAt: 34, nade: 0.5, hold: 0.15 }, // pusher
  { dist: 23, band: 7,  cover: 0.72, flank: 0.60, crouchAt: 20, nade: 0.9, hold: 0.45 }, // cover user
  { dist: 38, band: 12, cover: 0.85, flank: 0.10, crouchAt: 15, nade: 0.6, hold: 0.80 }, // camper
];
const S_ROAM = 0, S_ENGAGE = 1, S_COVER = 2, S_RETREAT = 3, S_SEARCH = 4;
const BOT_SIGHT = 80;    // metres a bot can acquire a target at
const BOT_PROBE = 2.6;   // whisker length used to steer around geometry
const BOT_CLEAR = PLAYER_R + 0.3;         // radius a bot wants to keep free
const AVOID_A = [0.62, 1.2, 1.9, 2.7];    // avoidance turns, tried both ways
const TAU = Math.PI * 2;
// shortest signed angle into [-PI, PI)
function angWrap(a) { return a - TAU * Math.floor((a + Math.PI) / TAU); }
const GRENADE_FUSE = 2.2, GRENADE_RADIUS = 7, GRENADE_DMG = 85, GRENADE_CD = 8000;
const WEAPONS = {
  rifle:    { dmg: 16, rpm: 540, range: 80,  pellets: 1, spread: 0.022, mag: 30, reload: 1.8 },
  shotgun:  { dmg: 9,  rpm: 85,  range: 24,  pellets: 8, spread: 0.09,  mag: 6,  reload: 2.4 },
  longshot: { dmg: 70, rpm: 45,  range: 130, pellets: 1, spread: 0.003, mag: 5,  reload: 2.6 },
};

// ray vs AABB (slab), returns t or Infinity; boxes rise from y=0 to h.
// Unrolled per axis: this is the hottest function on the server (hitscan and
// every bot line-of-sight query), so it must not allocate.
function rayBox(ox, oy, oz, dx, dy, dz, b) {
  let tmin = 0, tmax = Infinity, t1, t2, t;
  if (dx > -1e-9 && dx < 1e-9) { if (ox < b.x1 || ox > b.x2) return Infinity; }
  else {
    t1 = (b.x1 - ox) / dx; t2 = (b.x2 - ox) / dx;
    if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (dy > -1e-9 && dy < 1e-9) { if (oy < 0 || oy > b.h) return Infinity; }
  else {
    t1 = (0 - oy) / dy; t2 = (b.h - oy) / dy;
    if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (dz > -1e-9 && dz < 1e-9) { if (oz < b.z1 || oz > b.z2) return Infinity; }
  else {
    t1 = (b.z1 - oz) / dz; t2 = (b.z2 - oz) / dz;
    if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
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

    // Bounding sphere per obstacle (cx, cy, cz, r) — lets a LOS ray reject most
    // boxes in ~10 ops instead of running the full slab test on all of them.
    const obs = this.world.obstacles;
    this.obSph = new Float64Array(obs.length * 4);
    for (let i = 0, j = 0; i < obs.length; i++, j += 4) {
      const b = obs[i];
      const hx = (b.x2 - b.x1) / 2, hy = b.h / 2, hz = (b.z2 - b.z1) / 2;
      this.obSph[j] = b.x1 + hx; this.obSph[j + 1] = hy; this.obSph[j + 2] = b.z1 + hz;
      this.obSph[j + 3] = Math.sqrt(hx * hx + hy * hy + hz * hz);
    }
    // AI navigation data, built lazily on the first bot tick
    this.cover = null;
    this.roam = null;
    // scratch: bot AI runs 20x/s for up to 7 bots, so it must not allocate
    this._sa = { x: 0, y: 0, z: 0 };
    this._dir = [0, 0, 0];
    this._ci = new Int32Array(6);
    this._cs = new Float64Array(6);
    this._sx = 0; this._sz = 0;
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
      // one random skill x personality combination per bot
      p.ai = {
        per: BOT_PERSONAS[(Math.random() * BOT_PERSONAS.length) | 0],
        state: S_ROAM, targetId: 0, vis: false, lostAt: -9999, lx: 0, lz: 0,
        // aim: current smoothed angles + angular velocity + tremor + overshoot
        aimYaw: p.yaw, aimPitch: 0, avY: 0, avP: 0, over: 0, overAt: 0,
        jy: 0, jp: 0, jyT: 0, jpT: 0, jitAt: 0, errY: 9, errP: 9,
        turnMul: 0.85 + Math.random() * 0.35, phase: Math.random() * TAU,
        fireAt: 0, nextShotAt: 0, burstLeft: 0, aimHead: false,
        // staggered so the expensive work of 7 bots never lands on one tick
        reacqAt: Math.random() * 300, coverAt: Math.random() * 900,
        nadeAt: Math.random() * 900,
        hurtAt: -9999, lastHp: p.hp,
        hasWp: false, wpX: 0, wpZ: 0, wpAt: 0,
        coverX: 0, coverZ: 0, coverLow: 0, coverUntil: 0,
        peek: false, peekAt: 0, peekSide: 1,
        searchUntil: 0, sweepAt: 0, sweepYaw: 0,
        strafe: Math.random() < 0.5 ? -1 : 1, strafeAt: 0,
        flank: 0, flankUntil: 0, jumpAt: 0,
        avoidA: 0, avoidUntil: 0, avoidSide: Math.random() < 0.5 ? -1 : 1,
        stuck: 0, lastX: p.x, lastZ: p.z, sprinter: Math.random() < 0.5,
      };
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

  // is the segment origin -> origin + dir*dist blocked by world geometry?
  segBlocked(ox, oy, oz, dx, dy, dz, dist) {
    const sph = this.obSph, obs = this.world.obstacles;
    for (let i = 0, j = 0; i < obs.length; i++, j += 4) {
      const r = sph[j + 3];
      const lx = sph[j] - ox, ly = sph[j + 1] - oy, lz = sph[j + 2] - oz;
      const tca = lx * dx + ly * dy + lz * dz;
      if (tca < -r || tca > dist + r) continue;            // behind, or past the end
      if (lx * lx + ly * ly + lz * lz - tca * tca > r * r) continue;  // misses the sphere
      if (rayBox(ox, oy, oz, dx, dy, dz, obs[i]) < dist) return true;
    }
    return false;
  }

  // line of sight between two players' eye positions
  los(a, b) {
    const ox = a.x, oy = a.y + 1.55, oz = a.z;
    let dx = b.x - ox, dy = (b.y + 1.2) - oy, dz = b.z - oz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return true;
    dx /= dist; dy /= dist; dz /= dist;
    return !this.segBlocked(ox, oy, oz, dx, dy, dz, dist);
  }

  // ---- bot navigation data (static world → built once per room) -----------
  ensureNav() {
    if (this.cover) return;
    const OFF = 1.2, S = this.world.size;
    const cx = [], cz = [], chi = [];
    for (const b of this.world.obstacles) {
      if (b.kind === 'wall' || b.h < 0.9) continue;   // arena shell / ankle height
      const tall = b.h >= 1.7 ? 1 : 0;
      const mx = (b.x1 + b.x2) / 2, mz = (b.z1 + b.z2) / 2;
      for (let k = 0; k < 8; k++) {
        // corners then edge midpoints, pushed OFF metres outside the box
        const x = k === 0 || k === 2 ? b.x1 - OFF : k === 1 || k === 3 ? b.x2 + OFF
          : k === 4 || k === 5 ? mx : k === 6 ? b.x1 - OFF : b.x2 + OFF;
        const z = k === 0 || k === 1 ? b.z1 - OFF : k === 2 || k === 3 ? b.z2 + OFF
          : k === 4 ? b.z1 - OFF : k === 5 ? b.z2 + OFF : mz;
        if (Math.abs(x) > S - 1.5 || Math.abs(z) > S - 1.5) continue;
        if (this.blocked(x, z, PLAYER_R + 0.35)) continue;
        cx.push(x); cz.push(z); chi.push(tall);
      }
    }
    this.cover = {
      n: cx.length, x: Float32Array.from(cx), z: Float32Array.from(cz),
      hi: Uint8Array.from(chi),
    };
    // patrol targets: spawn ring, pickups, and an inner ring through the middle
    const roam = [];
    for (const s of this.world.spawns) roam.push(s.x, s.z);
    for (const pk of this.world.pickups) roam.push(pk.x, pk.z);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      roam.push(Math.cos(a) * 26, Math.sin(a) * 26);
    }
    this.roam = Float64Array.from(roam);
  }

  // does a disc of radius r at (x,z) overlap any obstacle? (bots cannot climb,
  // so height is irrelevant for pathing)
  blocked(x, z, r) {
    const r2 = r * r;
    for (const b of this.world.obstacles) {
      const nx = x < b.x1 ? b.x1 : (x > b.x2 ? b.x2 : x);
      const nz = z < b.z1 ? b.z1 : (z > b.z2 ? b.z2 : z);
      const dx = x - nx, dz = z - nz;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  // whisker probe: three overlapping discs along a direction
  pathClear(x, z, dx, dz, len) {
    const s = len / 3;
    return !this.blocked(x + dx * s, z + dz * s, BOT_CLEAR)
      && !this.blocked(x + dx * s * 2, z + dz * s * 2, BOT_CLEAR)
      && !this.blocked(x + dx * len, z + dz * len, BOT_CLEAR);
  }

  // nearest active pickup index of a class ('health' or 'weapon'), or -1
  nearestPickup(p, kind, maxD) {
    let best = -1, bestD = maxD;
    for (let i = 0; i < this.pickups.length; i++) {
      const pk = this.pickups[i];
      if (!pk.active) continue;
      if (kind === 'health' ? pk.type !== 'health' : pk.type === 'health') continue;
      const d = Math.hypot(pk.x - p.x, pk.z - p.z);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ---- bot AI -------------------------------------------------------------
  // nearest visible enemy, sticky toward the one already being fought
  botAcquire(p) {
    let best = null, bestScore = -Infinity;
    for (const o of this.byId.values()) {
      if (o === p || o.hp <= 0) continue;
      const dx = o.x - p.x, dz = o.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > BOT_SIGHT * BOT_SIGHT) continue;
      let sc = -Math.sqrt(d2);
      if (o.id === p.ai.targetId) sc += 12;
      if (o.hp < 40) sc += 10;
      if (sc <= bestScore) continue;
      if (!this.los(p, o)) continue;
      bestScore = sc; best = o;
    }
    return best;
  }

  // pick a spot that breaks line of sight from (tx,tz); bounded scan, then at
  // most six LOS rays. Returns true and stores it on the bot's ai.
  pickCover(p, tx, tz) {
    const c = this.cover, ai = p.ai;
    if (!c || c.n === 0) return false;
    const idx = this._ci, sco = this._cs, K = idx.length;
    let m = 0;
    let ax = p.x - tx, az = p.z - tz;
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;                                  // away from the threat
    for (let i = 0; i < c.n; i++) {
      const dx = c.x[i] - p.x, dz = c.z[i] - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 169 || d2 < 1.5) continue;                // 1.2 .. 13 m from here
      const tdx = c.x[i] - tx, tdz = c.z[i] - tz;
      if (tdx * tdx + tdz * tdz < 49) continue;          // not in the enemy's lap
      const s = (dx * ax + dz * az) * 0.6 - Math.sqrt(d2) * 0.5 + (c.hi[i] ? 1.5 : 0);
      if (m < K) {
        let j = m++;
        while (j > 0 && sco[j - 1] < s) { sco[j] = sco[j - 1]; idx[j] = idx[j - 1]; j--; }
        sco[j] = s; idx[j] = i;
      } else if (s > sco[K - 1]) {
        let j = K - 1;
        while (j > 0 && sco[j - 1] < s) { sco[j] = sco[j - 1]; idx[j] = idx[j - 1]; j--; }
        sco[j] = s; idx[j] = i;
      }
    }
    const sa = this._sa;
    for (let k = 0; k < m; k++) {
      const i = idx[k];
      sa.x = c.x[i]; sa.y = 0.2; sa.z = c.z[i];          // chest height at the point
      if (this.losPoint(tx, 1.55, tz, sa)) continue;      // still exposed there
      ai.coverX = c.x[i]; ai.coverZ = c.z[i]; ai.coverLow = c.hi[i] ? 0 : 1;
      return true;
    }
    return false;
  }

  // steer a desired world direction around geometry; result in _sx/_sz
  steer(p, dx, dz, now) {
    const ai = p.ai;
    if (now < ai.avoidUntil) {
      // stay committed to the turn for a moment, otherwise bots shuffle
      const ca = Math.cos(ai.avoidA), sa = Math.sin(ai.avoidA);
      const rx = dx * ca - dz * sa, rz = dx * sa + dz * ca;
      if (this.pathClear(p.x, p.z, rx, rz, BOT_PROBE)) { this._sx = rx; this._sz = rz; return; }
      ai.avoidUntil = 0;
    }
    if (this.pathClear(p.x, p.z, dx, dz, BOT_PROBE)) { this._sx = dx; this._sz = dz; return; }
    for (let i = 0; i < AVOID_A.length; i++) {
      for (let s = 0; s < 2; s++) {
        const a = AVOID_A[i] * (s === 0 ? ai.avoidSide : -ai.avoidSide);
        const ca = Math.cos(a), sa = Math.sin(a);
        const rx = dx * ca - dz * sa, rz = dx * sa + dz * ca;
        if (!this.pathClear(p.x, p.z, rx, rz, BOT_PROBE)) continue;
        ai.avoidA = a; ai.avoidUntil = now + 320;
        this._sx = rx; this._sz = rz;
        return;
      }
    }
    this._sx = -dx; this._sz = -dz;   // boxed in: back out
  }

  // turn the aim toward (yawT,pitchT) at a limited rate, with tremor and a
  // small flick overshoot. Leaves the residual error in ai.errY/errP.
  aimToward(p, dt, yawT, pitchT, now) {
    const ai = p.ai, d = p.diff;
    if (now >= ai.jitAt) {
      ai.jitAt = now + 140 + Math.random() * 260;
      ai.jyT = (Math.random() - 0.5) * 2 * d.jitter;
      ai.jpT = (Math.random() - 0.5) * 2 * d.jitter * 0.7;
    }
    const k = Math.min(1, dt * 6);
    ai.jy += (ai.jyT - ai.jy) * k;
    ai.jp += (ai.jpT - ai.jp) * k;

    let dy = angWrap(yawT + ai.jy + ai.over - ai.aimYaw);
    if (Math.abs(dy) > 0.5 && now >= ai.overAt) {
      ai.over = (dy > 0 ? 1 : -1) * (0.02 + Math.random() * 0.06);
      ai.overAt = now + 500;
      dy = angWrap(yawT + ai.jy + ai.over - ai.aimYaw);
    }
    ai.over -= ai.over * Math.min(1, dt * 4);
    const maxV = d.turn * ai.turnMul;
    let want = dy * d.gain;
    if (want > maxV) want = maxV; else if (want < -maxV) want = -maxV;
    ai.avY += (want - ai.avY) * Math.min(1, dt * 14);
    ai.aimYaw = angWrap(ai.aimYaw + ai.avY * dt);

    const maxP = maxV * 0.8;
    let wantP = (pitchT + ai.jp - ai.aimPitch) * d.gain;
    if (wantP > maxP) wantP = maxP; else if (wantP < -maxP) wantP = -maxP;
    ai.avP += (wantP - ai.avP) * Math.min(1, dt * 14);
    ai.aimPitch += ai.avP * dt;
    if (ai.aimPitch > 1.2) ai.aimPitch = 1.2;
    else if (ai.aimPitch < -1.2) ai.aimPitch = -1.2;

    ai.errY = Math.abs(angWrap(yawT - ai.aimYaw));
    ai.errP = Math.abs(pitchT - ai.aimPitch);
    p.yaw = ai.aimYaw; p.pitch = ai.aimPitch;
  }

  // lob a grenade at (tx,tz); the vertical share of the throw vector is tuned
  // against SPEED/GRAV/fuse in throwGrenade + tickGrenades
  botNade(p, tx, tz, dist) {
    let dx = tx - p.x, dz = tz - p.z;
    const h = Math.hypot(dx, dz);
    if (h < 1e-3) return;
    dx /= h; dz /= h;
    const sa = this._sa;
    sa.x = p.x + dx * 2.5; sa.y = 1.0; sa.z = p.z + dz * 2.5;
    if (!this.losPoint(p.x, p.y + 1.5, p.z, sa)) return;   // would bounce back
    let s = (dist - 8.8) / 20;
    if (s < 0) s = 0; else if (s > 0.62) s = 0.62;
    const c = Math.sqrt(1 - s * s), v = this._dir;
    v[0] = dx * c; v[1] = s; v[2] = dz * c;
    this.throwGrenade(p, v);
  }

  botThink(p, dt, now) {
    this.ensureNav();
    const ai = p.ai, d = p.diff, per = ai.per, inp = p.input;
    inp.mx = 0; inp.mz = 0; inp.sprint = false; inp.jump = false; inp.crouch = false;

    if (p.hp < ai.lastHp) { ai.hurtAt = now; ai.reacqAt = 0; }   // took a hit
    ai.lastHp = p.hp;

    // --- target: sticky while visible, staggered re-acquire otherwise
    let tgt = ai.targetId ? this.byId.get(ai.targetId) : null;
    if (tgt && (tgt.hp <= 0 || tgt === p)) { tgt = null; ai.targetId = 0; }
    let vis = tgt ? this.los(p, tgt) : false;
    if (!vis && now >= ai.reacqAt) {
      ai.reacqAt = now + 240 + Math.random() * 260;
      const nt = this.botAcquire(p);
      if (nt) { tgt = nt; vis = true; }
    }
    if (vis) {
      const fresh = tgt.id !== ai.targetId;
      if (fresh || !ai.vis) {
        const full = d.react + Math.random() * d.reactJit;
        ai.fireAt = now + (fresh || now - ai.lostAt > 800 ? full : full * 0.35);
        ai.burstLeft = 0;
        ai.aimHead = Math.random() < d.head;
        if (fresh) {
          ai.flank = Math.random() < per.flank ? (Math.random() < 0.5 ? -1 : 1) : 0;
          ai.flankUntil = now + 2200 + Math.random() * 2800;
        }
      }
      ai.targetId = tgt.id;
      ai.lx = tgt.x; ai.lz = tgt.z;
    } else if (ai.vis) {
      ai.lostAt = now;
    }
    ai.vis = vis;
    const dist = tgt ? Math.hypot(tgt.x - p.x, tgt.z - p.z) : 0;

    // --- state machine
    let st = ai.state;
    const hurt = now - ai.hurtAt < 1500;
    // 55 m cap: a medkit on the far side of the arena is not worth the walk
    const healI = p.hp < 70 ? this.nearestPickup(p, 'health', 55) : -1;
    if (p.hp <= 35 && healI >= 0) {
      st = S_RETREAT;
    } else if (st === S_RETREAT) {
      st = vis ? S_ENGAGE : (tgt ? S_SEARCH : S_ROAM);
      if (st === S_SEARCH) ai.searchUntil = now + 2500;
    }
    if (st !== S_RETREAT) {
      if (st === S_COVER && (!tgt || now >= ai.coverUntil)) st = vis ? S_ENGAGE : S_ROAM;
      if (st !== S_COVER) {
        if (vis) {
          st = S_ENGAGE;
          // reloading or bleeding: the tactical types break contact
          if (now >= ai.coverAt && (p.reloading > 0 || hurt)) {
            const ok = Math.random() < per.cover && this.pickCover(p, tgt.x, tgt.z);
            ai.coverAt = now + (ok ? 5000 : 1400);
            if (ok) {
              st = S_COVER;
              ai.coverUntil = now + 3000 + Math.random() * 3000;
              ai.peek = false;
              ai.peekAt = now + 700 + Math.random() * 700;
              ai.peekSide = Math.random() < 0.5 ? -1 : 1;
            }
          }
        } else if (tgt && now - ai.lostAt < 7000) {
          if (st !== S_SEARCH) { st = S_SEARCH; ai.searchUntil = now + 3000 + Math.random() * 2500; }
          else if (now >= ai.searchUntil) { st = S_ROAM; ai.targetId = 0; tgt = null; }
        } else {
          if (st !== S_ROAM) ai.hasWp = false;
          st = S_ROAM; ai.targetId = 0; tgt = null;
        }
      }
    }
    ai.state = st;

    // --- what the state wants: a move vector, a facing, and firing rights
    let mvx = 0, mvz = 0, mvScale = 0;
    let gx = 0, gz = 0, stopAt = 0, hasGoal = false;
    let faceMove = true, fireOk = false, crouch = false, sprint = false;
    let yawT = ai.aimYaw, pitchT = 0;

    if (st === S_ENGAGE && tgt) {
      const ux = (tgt.x - p.x) / (dist || 1), uz = (tgt.z - p.z) / (dist || 1);
      let want = per.dist;
      if (p.weapon === 'shotgun') want = Math.min(want, 9);
      else if (p.weapon === 'longshot') want = Math.max(want, 30);
      let radial = 0;
      if (dist > want + per.band) radial = 1;
      else if (dist < want - per.band) radial = -1;
      if (now >= ai.strafeAt) { ai.strafe = -ai.strafe; ai.strafeAt = now + 700 + Math.random() * 1300; }
      if (ai.flank && now < ai.flankUntil && dist > 7) {
        // swing wide instead of walking straight down the sightline
        const a = ai.flank * 1.25, ca = Math.cos(a), sa = Math.sin(a);
        mvx = ux * ca - uz * sa; mvz = ux * sa + uz * ca; mvScale = 1;
      } else {
        const lat = (1 - per.hold) * (radial === 0 ? 0.9 : 0.5) * ai.strafe;
        mvx = ux * radial - uz * lat;
        mvz = uz * radial + ux * lat;
        const l = Math.hypot(mvx, mvz);
        if (l > 1e-3) { mvx /= l; mvz /= l; mvScale = Math.min(1, l); }
      }
      fireOk = true; faceMove = false;
      crouch = radial === 0 && dist > per.crouchAt;
      // LOS is measured standing: don't duck behind waist-high rubble and then
      // shoot into it — a human would notice and stay up
      if (crouch && !this.losPoint(p.x, p.y + 1.1, p.z, tgt)) crouch = false;
      // sprint only to close a big gap, and never mid-burst
      sprint = radial > 0 && dist > want + 14 && (now < ai.fireAt || now < ai.nextShotAt);
      if (radial > 0 && dist > 6 && dist < 22 && now >= ai.jumpAt && Math.random() < 0.03) {
        inp.jump = true; ai.jumpAt = now + 2200 + Math.random() * 3500;
      }
    } else if (st === S_COVER) {
      if (now >= ai.peekAt) {
        ai.peek = !ai.peek;
        ai.peekAt = now + (ai.peek ? 900 + Math.random() * 900 : 800 + Math.random() * 1000);
      }
      if (p.reloading > 0) ai.peek = false;              // finish the reload down
      gx = ai.coverX; gz = ai.coverZ;
      if (ai.peek && tgt) {
        // lean out perpendicular to the cover -> threat line
        let nx = tgt.x - ai.coverX, nz = tgt.z - ai.coverZ;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;
        gx += -nz * ai.peekSide * 1.2; gz += nx * ai.peekSide * 1.2;
      }
      hasGoal = true; stopAt = 0.5;
      const toCover = Math.hypot(gx - p.x, gz - p.z);
      sprint = toCover > 6;
      crouch = !ai.peek && toCover < 1.5;
      fireOk = ai.peek;
      if (tgt) {
        faceMove = false;                                 // watch the threat's lane
        yawT = Math.atan2(-(ai.lx - p.x), -(ai.lz - p.z));
      }
    } else if (st === S_RETREAT) {
      const pk = healI >= 0 ? this.pickups[healI] : null;   // guarded: see above
      if (pk) { gx = pk.x; gz = pk.z; hasGoal = true; stopAt = 0.8; sprint = true; }
      fireOk = vis && dist < 20;
      if (fireOk) faceMove = false;
    } else if (st === S_SEARCH) {
      gx = ai.lx; gz = ai.lz; hasGoal = true; stopAt = 2.2;
      const toLast = Math.hypot(gx - p.x, gz - p.z);
      sprint = toLast > 10 && per.hold < 0.5;
      if (toLast <= stopAt) {
        // arrived: sweep the area in discrete head turns
        if (now >= ai.sweepAt) {
          ai.sweepAt = now + 800 + Math.random() * 900;
          ai.sweepYaw = angWrap(ai.aimYaw + (Math.random() < 0.5 ? -1 : 1) * (0.7 + Math.random() * 0.8));
        }
        yawT = ai.sweepYaw; faceMove = false;
      }
    } else {
      // ROAM: heal first, then grab a better gun, otherwise patrol
      if (!ai.hasWp || now >= ai.wpAt ||
          (p.x - ai.wpX) * (p.x - ai.wpX) + (p.z - ai.wpZ) * (p.z - ai.wpZ) < 6) {
        ai.hasWp = true; ai.wpAt = now + 14000;
        let i = healI >= 0 && p.hp < 70 ? healI : -1;
        if (i < 0 && p.weapon === 'rifle') i = this.nearestPickup(p, 'weapon', 55);
        if (i >= 0) { ai.wpX = this.pickups[i].x; ai.wpZ = this.pickups[i].z; }
        else {
          const r = this.roam, k = ((Math.random() * (r.length >> 1)) | 0) << 1;
          ai.wpX = r[k]; ai.wpZ = r[k + 1];
        }
      }
      gx = ai.wpX; gz = ai.wpZ; hasGoal = true; stopAt = 1.2;
      sprint = ai.sprinter;
    }

    if (hasGoal) {
      const ddx = gx - p.x, ddz = gz - p.z;
      const dl = Math.hypot(ddx, ddz);
      if (dl > stopAt) { mvx = ddx / dl; mvz = ddz / dl; mvScale = 1; }
      else { mvScale = 0; sprint = false; }
    }

    // --- steer around geometry, then aim, then convert to local input
    if (mvScale > 0.01) {
      this.steer(p, mvx, mvz, now);
      mvx = this._sx; mvz = this._sz;
    }
    inp.crouch = crouch;

    if (tgt && vis && !faceMove) {
      // lead the target a little: bullets are hitscan, this just reads as intent
      const lead = Math.min(0.25, dist / 200) * d.lead;
      const ddx = (tgt.x + tgt.vx * lead) - p.x;
      const ddz = (tgt.z + tgt.vz * lead) - p.z;
      const flat = Math.hypot(ddx, ddz) || 1e-3;
      const aimY = tgt.y + (tgt.input.crouch ? 0.72 : (ai.aimHead ? 1.6 : 1.05));
      yawT = Math.atan2(-ddx, -ddz);
      pitchT = Math.atan2(aimY - (p.y + (crouch ? 1.1 : 1.55)), flat);
    } else if (faceMove && mvScale > 0.01) {
      yawT = angWrap(Math.atan2(-mvx, -mvz) + Math.sin(now / 1400 + ai.phase) * 0.35);
    }
    this.aimToward(p, dt, yawT, pitchT, now);

    if (mvScale > 0.01) {
      const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
      // inverse of the movement transform in tick(): right = (cos,-sin)
      inp.mx = (mvx * cos - mvz * sin) * mvScale;
      inp.mz = (-mvx * sin - mvz * cos) * mvScale;
      inp.sprint = sprint && !crouch && !(fireOk && vis);   // never sprint and shoot
    }

    // --- shooting: only inside the aim cone, in bursts, after the reaction.
    // faceMove states aim down their path, so they must never pull the trigger.
    const w = WEAPONS[p.weapon];
    if (fireOk && !faceMove && vis && tgt && this.phase === 'play' && now >= ai.fireAt &&
        now >= ai.nextShotAt && p.reloading <= 0 && p.mag > 0 && dist < w.range * 0.9 &&
        ai.errY < d.tol && ai.errP < d.tol * 1.6) {
      if (ai.burstLeft <= 0) {
        ai.burstLeft = p.weapon === 'rifle' ? d.burst + ((Math.random() * d.burstJit) | 0)
          : (p.weapon === 'shotgun' ? 2 : 1);
      }
      const cp = Math.cos(ai.aimPitch), v = this._dir;
      v[0] = -Math.sin(ai.aimYaw) * cp;
      v[1] = Math.sin(ai.aimPitch);
      v[2] = -Math.cos(ai.aimYaw) * cp;
      const before = p.lastFire;
      this.fire(p, v);
      if (p.lastFire !== before && --ai.burstLeft <= 0) {
        ai.nextShotAt = now + d.rest + Math.random() * d.restJit;
        ai.aimHead = Math.random() < d.head;
      }
    }

    // --- reload discipline: top up when nobody has eyes on us
    if (p.reloading <= 0 && p.mag < w.mag * 0.3 && (!vis || st === S_COVER || dist > 45)) {
      p.reloading = w.reload;
      this.events.push(['reload', p.id]);
    }

    // --- grenades: flush out cover, or soften a mid-range fight
    if (tgt && now >= ai.nadeAt && this.phase === 'play') {
      ai.nadeAt = now + 900;
      const gx2 = vis ? tgt.x : ai.lx, gz2 = vis ? tgt.z : ai.lz;
      const gd = Math.hypot(gx2 - p.x, gz2 - p.z);
      const known = vis || now - ai.lostAt < 3000;
      // 26 m is about as far as the arc + roll reaches before the fuse ends
      if (known && gd > 12 && gd < 26 && now - (p.lastNade || 0) >= GRENADE_CD &&
          Math.random() < per.nade * d.nade * (vis ? 0.35 : 1)) {
        this.botNade(p, gx2, gz2, gd);
      }
    }

    // --- stuck watchdog: wanted to move but did not, so ditch the plan
    if (mvScale > 0.1) {
      const sdx = p.x - ai.lastX, sdz = p.z - ai.lastZ;
      if (sdx * sdx + sdz * sdz < 0.0009) ai.stuck += dt; else ai.stuck = 0;
    } else ai.stuck = 0;
    ai.lastX = p.x; ai.lastZ = p.z;
    if (ai.stuck > 1.2) {
      ai.stuck = 0; ai.hasWp = false; ai.strafe = -ai.strafe;
      ai.avoidSide = -ai.avoidSide;
      ai.avoidA = ai.avoidSide * (1.6 + Math.random());
      ai.avoidUntil = now + 700;
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
    return !this.segBlocked(x, y, z, dx, dy, dz, dist);
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
      p.input.crouch = !!m.cr;
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
      px: 0, pz: 0, vx: 0, vz: 0,        // last tick position + planar velocity
      hp: 100, kills: 0, deaths: 0,
      weapon: 'rifle', mag: WEAPONS.rifle.mag, reloading: 0,
      respawn: 0, lastFire: 0,
      input: { mx: 0, mz: 0, sprint: false, jump: false, crouch: false },
      speedNorm: 0, stepAcc: 0, airborne: false,
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
    // the only teleport in the sim: reset velocity tracking and any bot plan
    p.px = p.x; p.pz = p.z; p.vx = 0; p.vz = 0;
    const ai = p.ai;
    if (ai) {
      ai.state = S_ROAM; ai.targetId = 0; ai.vis = false; ai.hasWp = false;
      ai.aimYaw = p.yaw; ai.aimPitch = 0; ai.avY = 0; ai.avP = 0; ai.over = 0;
      ai.burstLeft = 0; ai.stuck = 0; ai.lastX = p.x; ai.lastZ = p.z;
      ai.lastHp = 100; ai.hurtAt = -9999; ai.lostAt = -9999; ai.avoidUntil = 0;
    }
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
    this.events.push(['shot', p.id, p.weapon, [+dx.toFixed(2), +dy.toFixed(2), +dz.toFixed(2)]]);

    const ox = p.x, oy = p.y + (p.input.crouch ? 1.1 : 1.55), oz = p.z;
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
        const low = o.input.crouch;                       // crouching = smaller target
        const tb = raySphere(ox, oy, oz, rx, ry, rz, o.x, o.y + (low ? 0.68 : 1.0), o.z, low ? 0.48 : 0.55);
        const th = raySphere(ox, oy, oz, rx, ry, rz, o.x, o.y + (low ? 1.15 : 1.62), o.z, 0.3);
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
      const { mx, mz, sprint, jump, crouch } = p.input;
      const l = Math.hypot(mx, mz);
      const grounded = p.y === 0;
      let moved = 0;
      if (l > 0.01) {
        const nx = mx / Math.max(1, l), nz = mz / Math.max(1, l);
        const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
        const wx = nx * cos - nz * sin;
        const wz = -nx * sin - nz * cos;
        // crouch beats sprint; sprint only counts moving forward-ish
        const sp = crouch ? CROUCH_SPEED : (sprint ? SPRINT : WALK);
        const stepX = wx * sp * dt, stepZ = wz * sp * dt;
        p.x += stepX;
        p.z += stepZ;
        moved = Math.hypot(stepX, stepZ);
        p.speedNorm = Math.min(1, sp * Math.min(1, l) / SPRINT);
      } else {
        p.speedNorm = 0;
      }
      // footsteps: one event per STEP_DIST travelled on the ground
      if (grounded && moved > 0) {
        p.stepAcc += moved;
        const need = crouch ? STEP_DIST * 1.6 : STEP_DIST;
        if (p.stepAcc >= need) { p.stepAcc = 0; this.events.push(['step', p.id]); }
      }
      // jump + gravity (ground is y=0 everywhere)
      if (jump && grounded) p.vy = JUMP_V;
      if (p.y > 0 || p.vy > 0) {
        p.vy += GRAV * dt;
        p.y = Math.max(0, p.y + p.vy * dt);
        if (p.y === 0) p.vy = 0;
      }
      if (p.airborne && p.y === 0) this.events.push(['land', p.id]);
      p.airborne = p.y > 0.05;
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

      // planar velocity from the actual post-collision delta (bots lead with it)
      p.vx = (p.x - p.px) / dt; p.vz = (p.z - p.pz) / dt;
      p.px = p.x; p.pz = p.z;

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
      // row: [0]id [1]x [2]y [3]z [4]yaw [5]pitch [6]hp [7]kills [8]deaths
      //      [9]weapon [10]mag [11]reloading [12]name [13]speed0..1
      //      [14]flags(1 sprint, 2 crouch, 4 bot, 8 airborne)
      p: [...this.byId.values()].map(p => [
        p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
        +p.yaw.toFixed(3), +p.pitch.toFixed(3),
        p.hp, p.kills, p.deaths, p.weapon, p.mag,
        +(p.reloading > 0), p.name,
        +p.speedNorm.toFixed(2),
        (p.input.sprint ? 1 : 0) | (p.input.crouch ? 2 : 0) |
        (p.bot ? 4 : 0) | (p.airborne ? 8 : 0),
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
