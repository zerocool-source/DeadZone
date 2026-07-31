// DeadZone: Wasteland PvP — client. Renders snapshots from the
// authoritative server, predicts the local player, and turns input
// (keyboard+mouse / touch / gamepad) into command messages.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import * as WORLD from './world.js';
import { STR } from './strings.js';

const buildWorld = WORLD.buildWorld;

// --- constants (mirror server.js; server is authoritative) ---------------
const WALK = 5.2, SPRINT = 7.6, CROUCH_SPEED = 2.5, GRAV = -22, JUMP_V = 7.5, PLAYER_R = 0.45;
const WEAPONS = {
  // range/pellets/spread mirror server.js — used only for local impact FX.
  rifle:    { rpm: 540, mag: 30, auto: true,  vmSize: 1.0,  range: 80,  pellets: 1, spread: 0.022 },
  shotgun:  { rpm: 85,  mag: 6,  auto: false, vmSize: 1.15, range: 24,  pellets: 8, spread: 0.09 },
  longshot: { rpm: 45,  mag: 5,  auto: false, vmSize: 1.3,  range: 130, pellets: 1, spread: 0.003 },
  pistol:   { rpm: 300, mag: 12, auto: false, vmSize: 0.62, range: 45,  pellets: 1, spread: 0.028 },
};
const EYE = 1.55;
// Must stay just over one server tick (50 ms): the buffer only holds two
// snapshots, so anything larger parks the lerp factor at 0 and remotes snap.
const INTERP_DELAY = 60; // ms behind live for remote interpolation
const FOV_BASE = 75, FOV_ADS = 55, FOV_SPRINT = 79;

// FORMULA palette
const COL = {
  sky: 0x8a8474, fog: 0x8a8474, ground: 0x5c5a50, groundVar: 0x51544a,
  wall: 0x62625e, ruin: 0x6a675f, container: 0x6e4a33, rubble: 0x585650,
  rock: 0x4f4f4b, accent: 0x57e389, skin: 0xb8b3a2, cloth: 0x3a3d35,
  // kinds introduced with the level rebuild — only ever seen if their model 404s
  barrier: 0x7d7b72, car: 0x4a463f, crate: 0x6b5334, barrel: 0x6d452e,
  tower: 0x6b675c, building: 0x6a675f,
};

// Shared scratch objects — nothing in the frame loop may allocate.
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _mx = new THREE.Matrix4();
const _axisY = new THREE.Vector3(0, 1, 0);
const _planeN = new THREE.Vector3(0, 0, 1);
const _qGunFlip = new THREE.Quaternion().setFromAxisAngle(_axisY, Math.PI);

const $ = id => document.getElementById(id);
const fmt = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

// --- static UI strings ----------------------------------------------------
$('js-title').textContent = STR.title;
$('js-sub').textContent = STR.subtitle;
$('join-btn').textContent = STR.play;
$('name-input').placeholder = STR.enterName;
$('name-input').value = localStorage.getItem('dz_name') || '';
$('btn-fire').textContent = STR.touchFire;
$('btn-jump').textContent = STR.touchJump;
$('btn-reload').textContent = STR.touchReload;
$('btn-nade').textContent = STR.touchNade;
$('btn-swap').textContent = STR.touchSwap;
$('btn-ads').textContent = STR.touchAds;

// --- renderer / scene ------------------------------------------------------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(COL.fog, 0.009);
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 900);
scene.add(camera);
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); addEventListener('orientationchange', resize); resize();

scene.add(new THREE.HemisphereLight(0xb0a890, 0x3a382e, 0.9));
const sun = new THREE.DirectionalLight(0xe8d9b0, 1.5);
sun.position.set(180, 220, -140);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x8a8478, 0.3));

// --- sky, sun disc, clouds, mountains (all fog-exempt, pre-hazed) ----------
const cloudSprites = [];
{
  // gradient sky dome: sickly amber horizon into cold grey-blue zenith
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 4; skyCanvas.height = 256;
  const sctx = skyCanvas.getContext('2d');
  const grad = sctx.createLinearGradient(0, 256, 0, 0);
  grad.addColorStop(0.0, '#b3a487');   // below horizon haze
  grad.addColorStop(0.42, '#a89a80');  // horizon band
  grad.addColorStop(0.62, '#8b8a7e');
  grad.addColorStop(1.0, '#5f6a74');   // zenith
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, 4, 256);
  const skyTex = new THREE.CanvasTexture(skyCanvas);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  const skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(800, 24, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }));
  skyDome.renderOrder = -3;
  scene.add(skyDome);

  // sun disc + glow, matched to the directional light
  const sunCanvas = document.createElement('canvas');
  sunCanvas.width = sunCanvas.height = 128;
  const g2 = sunCanvas.getContext('2d');
  const rg = g2.createRadialGradient(64, 64, 4, 64, 64, 64);
  rg.addColorStop(0, 'rgba(255,244,214,1)');
  rg.addColorStop(0.18, 'rgba(255,236,190,0.95)');
  rg.addColorStop(0.45, 'rgba(240,214,150,0.35)');
  rg.addColorStop(1, 'rgba(230,205,150,0)');
  g2.fillStyle = rg;
  g2.fillRect(0, 0, 128, 128);
  const sunTex = new THREE.CanvasTexture(sunCanvas);
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sunTex, transparent: true, fog: false, depthWrite: false }));
  sunSprite.scale.set(220, 220, 1);
  sunSprite.position.set(540, 480, -420); // along the light direction
  scene.add(sunSprite);

  // soft procedural cloud billboards drifting on the wind
  const cloudCanvas = document.createElement('canvas');
  cloudCanvas.width = 256; cloudCanvas.height = 128;
  const cctx = cloudCanvas.getContext('2d');
  for (let i = 0; i < 22; i++) {
    const cx = 40 + Math.random() * 176, cy = 45 + Math.random() * 40;
    const r = 18 + Math.random() * 34;
    const rg2 = cctx.createRadialGradient(cx, cy, 2, cx, cy, r);
    rg2.addColorStop(0, 'rgba(216,210,196,0.16)');
    rg2.addColorStop(1, 'rgba(216,210,196,0)');
    cctx.fillStyle = rg2;
    cctx.beginPath(); cctx.arc(cx, cy, r, 0, 7); cctx.fill();
  }
  const cloudTex = new THREE.CanvasTexture(cloudCanvas);
  for (let i = 0; i < 16; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: cloudTex, transparent: true, fog: false, depthWrite: false,
      opacity: 0.5 + Math.random() * 0.4 }));
    const a = Math.random() * Math.PI * 2;
    const r = 180 + Math.random() * 420;
    sp.position.set(Math.cos(a) * r, 90 + Math.random() * 130, Math.sin(a) * r);
    const s = 140 + Math.random() * 220;
    sp.scale.set(s, s * 0.42, 1);
    sp.userData.drift = 1.2 + Math.random() * 2.2;
    scene.add(sp);
    cloudSprites.push(sp);
  }

  // mountain ring on the horizon: low-poly ridges, pre-blended into haze
  let ms = 777 >>> 0;
  const mrnd = () => ((ms = (ms * 1664525 + 1013904223) >>> 0) / 4294967296);
  const mountains = new THREE.Group();
  const near = new THREE.Color(0x6e6a5e), far = new THREE.Color(0x8d8878);
  for (let i = 0; i < 42; i++) {
    const a = (i / 42) * Math.PI * 2 + mrnd() * 0.12;
    const ring = mrnd();
    const dist = 300 + ring * 320;
    const h = 40 + mrnd() * 120 * (0.5 + ring * 0.8);
    const w = 90 + mrnd() * 160;
    const geo = new THREE.ConeGeometry(w, h, 4 + ((mrnd() * 3) | 0), 1);
    const col = near.clone().lerp(far, ring * 0.85 + mrnd() * 0.15);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, fog: false, flatShading: true }));
    m.position.set(Math.cos(a) * dist, h / 2 - 6, Math.sin(a) * dist);
    m.rotation.y = mrnd() * Math.PI;
    mountains.add(m);
  }
  mountains.renderOrder = -2;
  scene.add(mountains);

  // outer wasteland floor so the horizon gap under the mountains reads as land
  const outer = new THREE.Mesh(new THREE.CircleGeometry(760, 48),
    new THREE.MeshBasicMaterial({ color: 0x99917c, fog: false }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.4;
  outer.renderOrder = -3;
  scene.add(outer);
}

// --- tracers -----------------------------------------------------------------
const tracerPool = [];
function addTracer(from, dir, len = 46) {
  let t = tracerPool.find(t => !t.mesh.visible);
  if (!t) {
    if (tracerPool.length >= 24) return;
    const geo = new THREE.CylinderGeometry(0.015, 0.015, 1, 4, 1, true);
    geo.translate(0, 0.5, 0);
    geo.rotateX(Math.PI / 2); // length along +Z so lookAt aims it
    const mesh = new THREE.Mesh(geo,
      new THREE.MeshBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.85, fog: false, depthWrite: false }));
    mesh.visible = false;
    scene.add(mesh);
    t = { mesh, until: 0 };
    tracerPool.push(t);
  }
  t.mesh.position.copy(from);
  t.mesh.lookAt(from.clone().addScaledVector(dir, 10));
  t.mesh.scale.set(1, 1, len);
  t.mesh.visible = true;
  t.mesh.material.opacity = 0.85;
  t.until = performance.now() + 90;
}
function updateTracers(now) {
  for (const t of tracerPool) {
    if (!t.mesh.visible) continue;
    t.mesh.material.opacity = Math.max(0, (t.until - now) / 90) * 0.85;
    if (now > t.until) t.mesh.visible = false;
  }
}

// --- impact FX: bullet holes (1 instanced draw call) + dust puffs -----------
const DECAL_MAX = 48;
let decalIdx = 0;
const decalMesh = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(16, 16, 1, 16, 16, 15);
  g.addColorStop(0, 'rgba(10,9,8,0.95)');
  g.addColorStop(0.5, 'rgba(26,22,18,0.55)');
  g.addColorStop(1, 'rgba(34,29,22,0)');
  x.fillStyle = g; x.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, opacity: 0.95, fog: true,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, DECAL_MAX);
  im.frustumCulled = false;
  _mx.makeScale(0, 0, 0);
  for (let i = 0; i < DECAL_MAX; i++) im.setMatrixAt(i, _mx);
  im.instanceMatrix.needsUpdate = true;
  scene.add(im);
  return im;
})();
function addDecal(px, py, pz, nx, ny, nz, size) {
  _v1.set(nx, ny, nz);
  _q1.setFromUnitVectors(_planeN, _v1);
  _q2.setFromAxisAngle(_planeN, Math.random() * 6.283);
  _q1.multiply(_q2);
  _v2.set(px + nx * 0.02, py + ny * 0.02, pz + nz * 0.02);
  const s = size * (0.75 + Math.random() * 0.6);
  _v3.set(s, s, s);
  _mx.compose(_v2, _q1, _v3);
  decalMesh.setMatrixAt(decalIdx, _mx);
  decalIdx = (decalIdx + 1) % DECAL_MAX;
  decalMesh.instanceMatrix.needsUpdate = true;
}

const PUFF_MAX = 10;
const puffPool = [];
let puffRR = 0, puffTex = null;
function getPuffTex() {
  if (puffTex) return puffTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 2, 32, 32, 31);
  g.addColorStop(0, 'rgba(214,203,178,0.85)');
  g.addColorStop(0.45, 'rgba(196,184,158,0.4)');
  g.addColorStop(1, 'rgba(186,174,150,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  puffTex = new THREE.CanvasTexture(c);
  return puffTex;
}
function addPuff(x, y, z, size) {
  let p = null;
  for (let i = 0; i < puffPool.length; i++) if (!puffPool[i].sp.visible) { p = puffPool[i]; break; }
  if (!p) {
    if (puffPool.length < PUFF_MAX) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getPuffTex(), transparent: true, depthWrite: false, fog: true }));
      sp.visible = false;
      scene.add(sp);
      p = { sp, t: 0, size: 1 };
      puffPool.push(p);
    } else {
      p = puffPool[puffRR++ % PUFF_MAX]; // recycle oldest slot
    }
  }
  p.sp.position.set(x, y, z);
  p.size = size;
  p.t = 0;
  p.sp.visible = true;
  p.sp.material.opacity = 0.8;
  p.sp.scale.setScalar(size * 0.5);
}
function updatePuffs(dt) {
  for (let i = 0; i < puffPool.length; i++) {
    const p = puffPool[i];
    if (!p.sp.visible) continue;
    p.t += dt / 0.42;
    if (p.t >= 1) { p.sp.visible = false; continue; }
    p.sp.scale.setScalar(p.size * (0.5 + p.t * 1.8));
    p.sp.material.opacity = 0.8 * (1 - p.t) * (1 - p.t);
    p.sp.position.y += dt * 0.35;
  }
}

// ray vs axis-aligned obstacle box; writes the entry-face normal into _rayN
const _rayN = { x: 0, y: 1, z: 0 };
function rayBoxN(ox, oy, oz, dx, dy, dz, b) {
  let tmin = 0, tmax = Infinity, axis = -1, sign = 1;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? ox : a === 1 ? oy : oz;
    const d = a === 0 ? dx : a === 1 ? dy : dz;
    const lo = a === 0 ? b.x1 : a === 1 ? 0 : b.z1;
    const hi = a === 0 ? b.x2 : a === 1 ? b.h : b.z2;
    if (d > -1e-9 && d < 1e-9) { if (o < lo || o > hi) return Infinity; continue; }
    let t1 = (lo - o) / d, t2 = (hi - o) / d;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) { tmin = t1; axis = a; sign = d > 0 ? -1 : 1; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  _rayN.x = axis === 0 ? sign : 0;
  _rayN.y = axis === 1 ? sign : (axis === -1 ? 1 : 0);
  _rayN.z = axis === 2 ? sign : 0;
  return tmin;
}
function raySphereT(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return Infinity;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return Infinity;
  return tca - Math.sqrt(r * r - d2);
}
// Cosmetic only: the server owns hit resolution. We just want a wall puff when
// the shot clearly went into geometry rather than into a body.
function localImpact(dirx, diry, dirz) {
  const w = WEAPONS[me.weapon] || WEAPONS.rifle;
  const ox = me.x, oy = me.y + me.eye - 0.05, oz = me.z;
  const rays = w.pellets > 1 ? 3 : 1;
  for (let n = 0; n < rays; n++) {
    let rx = dirx, ry = diry, rz = dirz;
    if (rays > 1) {
      rx += (Math.random() - 0.5) * 2 * w.spread;
      ry += (Math.random() - 0.5) * 2 * w.spread;
      rz += (Math.random() - 0.5) * 2 * w.spread;
      const l = Math.hypot(rx, ry, rz) || 1;
      rx /= l; ry /= l; rz /= l;
    }
    let enemyT = Infinity;
    for (const r of remotes.values()) {
      if (!r.alive) continue;
      const p = r.group.position;
      const t = raySphereT(ox, oy, oz, rx, ry, rz, p.x, p.y + 1.05, p.z, 0.75);
      if (t < enemyT) enemyT = t;
    }
    let bestT = w.range, nx = 0, ny = 1, nz = 0;
    for (let i = 0; i < world.obstacles.length; i++) {
      const t = rayBoxN(ox, oy, oz, rx, ry, rz, world.obstacles[i]);
      if (t < bestT && t > 0.4) { bestT = t; nx = _rayN.x; ny = _rayN.y; nz = _rayN.z; }
    }
    if (ry < -1e-4) { // dirt at y=0, plus any deck the shot crosses first
      const tg = -oy / ry;
      if (tg < bestT && tg > 0.4) { bestT = tg; nx = 0; ny = 1; nz = 0; }
      for (let i = 0; i < wPlatforms.length; i++) {
        const pl = wPlatforms[i];
        const tp = (pl.y - oy) / ry;
        if (tp <= 0.4 || tp >= bestT) continue;
        const hx = ox + rx * tp, hz = oz + rz * tp;
        if (hx < pl.x1 || hx > pl.x2 || hz < pl.z1 || hz > pl.z2) continue;
        bestT = tp; nx = 0; ny = 1; nz = 0;
      }
    }
    if (bestT >= w.range || bestT >= enemyT) continue;
    const hx = ox + rx * bestT, hy = oy + ry * bestT, hz = oz + rz * bestT;
    addDecal(hx, hy, hz, nx, ny, nz, 0.2);
    addPuff(hx + nx * 0.08, hy + ny * 0.08, hz + nz * 0.08, 0.6);
  }
}

// --- textures ---------------------------------------------------------------
// Basecolor (+ optional normal) out of ./assets/textures, shared between every
// material that asks for the same file. Materials are always created with a
// usable flat colour and only upgraded from the load callback: handing a
// material a map that never arrives renders the surface black.
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
const _texLoader = new THREE.TextureLoader();
const _texDone = new Map(); // file -> Texture
const _texWait = new Map(); // file -> pending callbacks
function loadTex(file, srgb, onOk) {
  const done = _texDone.get(file);
  if (done) { onOk(done); return; }
  const waiting = _texWait.get(file);
  if (waiting) { waiting.push(onOk); return; }
  _texWait.set(file, [onOk]);
  _texLoader.load(`./assets/textures/${file}.jpg`, tex => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = MAX_ANISO; // grazing angles on the ground are the whole game
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    _texDone.set(file, tex);
    const cbs = _texWait.get(file) || [];
    _texWait.delete(file);
    for (const cb of cbs) cb(tex);
  }, undefined, () => { _texWait.delete(file); });
}
// <name>.jpg as basecolor, <name>_n.jpg as normal. The two are independent so a
// missing normal map still leaves us the diffuse.
function texturize(mat, name, onBase) {
  loadTex(name, true, t => {
    mat.map = t; mat.needsUpdate = true;
    if (onBase) onBase(t);
  });
  loadTex(name + '_n', false, t => { mat.normalMap = t; mat.needsUpdate = true; });
}

// --- merged textured geometry -------------------------------------------------
// UVs come straight from world coordinates, so a 40 m wall tiles at the same
// density as a 2 m crate and neighbouring boxes line up instead of each
// stretching its own 0..1 patch. Everything of one material merges into a
// single geometry: one draw call for all the concrete in the level.
const TILE_GROUND = 4;   // metres per ground texture tile
const TILE_STRUCT = 3;   // metres per tile on walls, decks and rocks
// [nx,ny,nz, ux,uy,uz, vx,vy,vz, xHi,yHi,zHi] with U x V = N so the winding
// faces outward; the *Hi flags pick the box corner the quad starts from.
const BOX_FACES = [
  [1, 0, 0, 0, 0, -1, 0, 1, 0, 1, 0, 1],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0],
  [0, 1, 0, 1, 0, 0, 0, 0, -1, 0, 1, 1],
  [0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 0, -1, 0, 1, 0, 1, 0, 0, 0, 0, 0],
];
function geoBuilder() {
  const P = [], N = [], U = [], I = [];
  return {
    get empty() { return I.length === 0; },
    quad(ox, oy, oz, ux, uy, uz, ul, vx, vy, vz, vl, nx, ny, nz, tile) {
      const base = P.length / 3;
      for (let k = 0; k < 4; k++) {
        const a = (k === 1 || k === 2) ? ul : 0;
        const b = (k === 2 || k === 3) ? vl : 0;
        const x = ox + ux * a + vx * b, y = oy + uy * a + vy * b, z = oz + uz * a + vz * b;
        P.push(x, y, z);
        N.push(nx, ny, nz);
        U.push((ux ? x : uy ? y : z) / tile, (vx ? x : vy ? y : z) / tile);
      }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    },
    build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      g.setIndex(I);
      g.computeBoundingSphere();
      return g;
    },
  };
}
// list entries are {x1,z1,x2,z2} plus a top (h) and an optional bottom (y1)
function boxesGeometry(list, tile) {
  const b = geoBuilder();
  for (const o of list) {
    const y1 = o.y1 || 0, y2 = o.h;
    const dx = o.x2 - o.x1, dy = y2 - y1, dz = o.z2 - o.z1;
    if (!(dx > 0) || !(dz > 0) || !(dy > 0)) continue;
    for (const f of BOX_FACES) {
      if (f[1] === -1 && y1 < 0.01) continue; // a box on the deck has no underside
      b.quad(
        f[9] ? o.x2 : o.x1, f[10] ? y2 : y1, f[11] ? o.z2 : o.z1,
        f[3], f[4], f[5], f[3] ? dx : f[4] ? dy : dz,
        f[6], f[7], f[8], f[6] ? dx : f[7] ? dy : dz,
        f[0], f[1], f[2], tile);
    }
  }
  return b.empty ? null : b.build();
}
function slabsGeometry(list, y, tile) {
  const b = geoBuilder();
  for (const q of list) {
    const dx = q.x2 - q.x1, dz = q.z2 - q.z1;
    if (!(dx > 0) || !(dz > 0)) continue;
    b.quad(q.x1, y, q.z2, 1, 0, 0, dx, 0, 0, -1, dz, 0, 1, 0, tile);
  }
  return b.empty ? null : b.build();
}

// --- world geometry ---------------------------------------------------------
const world = buildWorld();
// Everything past buildWorld's original three fields is optional: this client
// has to keep running against a world.js from either side of the level rebuild.
const wPlatforms = Array.isArray(world.platforms) ? world.platforms : [];
const wGround = Array.isArray(world.ground) ? world.ground : [];
const wProps = Array.isArray(world.props) ? world.props : [];
const wPois = Array.isArray(world.pois) ? world.pois : [];
const wPickups = Array.isArray(world.pickups) ? world.pickups : [];
// The server owns standing height; world.js exports the same function so
// prediction agrees with it. A named import would hard-fail the whole module
// while the two files are out of step, hence the lookup + local twin.
const groundHeightAt = typeof WORLD.groundHeightAt === 'function'
  ? WORLD.groundHeightAt : localGroundHeightAt;
function localGroundHeightAt(x, z, w) {
  const ps = (w && w.platforms) || wPlatforms;
  let y = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.y > y && x >= p.x1 && x <= p.x2 && z >= p.z1 && z <= p.z2) y = p.y;
  }
  return y;
}

// true when no combination of same-height obstacles fills the platform's
// footprint, i.e. the deck is a walkway hanging in the air and needs geometry
function platformUncovered(p) {
  const cover = [];
  for (const b of world.obstacles) {
    if (Math.abs(b.h - p.y) > 0.08) continue;
    if (b.x2 <= p.x1 || b.x1 >= p.x2 || b.z2 <= p.z1 || b.z1 >= p.z2) continue;
    cover.push(b);
  }
  if (!cover.length) return true;
  const nx = Math.max(2, Math.min(10, Math.round((p.x2 - p.x1) / 1.5)));
  const nz = Math.max(2, Math.min(10, Math.round((p.z2 - p.z1) / 1.5)));
  for (let i = 0; i < nx; i++) {
    const x = p.x1 + (p.x2 - p.x1) * (i + 0.5) / nx;
    for (let j = 0; j < nz; j++) {
      const z = p.z1 + (p.z2 - p.z1) * (j + 0.5) / nz;
      let inside = false;
      for (let k = 0; k < cover.length && !inside; k++) {
        const b = cover[k];
        inside = x >= b.x1 && x <= b.x2 && z >= b.z1 && z <= b.z2;
      }
      if (!inside) return true;
    }
  }
  return false;
}

const obstaclesByKind = {};
const propBoxes = {};       // boxes near enough the model's size to wear it
const bulkBoxes = [];       // the rest: drawn as textured concrete instead
const boxMeshByKind = {};
// instanceProp stretches ONE model to fill the whole box, so a box far from the
// size the model was authored at reads as a smeared blob rather than a prop.
// Past these it is architecture (the 14 m plinth, the 13.6 m parapet run), and
// architecture belongs with the walls and ruins. [maxWidth, maxHeight, maxDepth]
const PROP_MAX = { building: [0, 0, 0], barrier: [6, 2.2, 6] };
// kinds that stay as boxes: concrete for the built stuff, gravel for rock.
// 'building' is here because every building in this level is over PROP_MAX and
// so never wears prop_building; a small one still would.
const MERGED_KINDS = { wall: 'concrete', ruin: 'concrete', building: 'concrete', rock: 'gravel' };
{
  for (const b of world.obstacles) {
    (obstaclesByKind[b.kind] ??= []).push(b);
    const lim = PROP_MAX[b.kind];
    if (lim && (b.x2 - b.x1 > lim[0] || b.h > lim[1] || b.z2 - b.z1 > lim[2])) bulkBoxes.push(b);
    else (propBoxes[b.kind] ??= []).push(b);
  }

  // ground: textured dirt everywhere, world 'ground' patches proud of it
  const g = new THREE.PlaneGeometry(world.size * 2 + 8, world.size * 2 + 8, 48, 48);
  g.rotateX(-Math.PI / 2);
  const c1 = new THREE.Color(COL.ground), c2 = new THREE.Color(COL.groundVar);
  const colors = [];
  let seed = 42 >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < g.attributes.position.count; i++) {
    const c = c1.clone().lerp(c2, rnd());
    colors.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  {
    const pos = g.attributes.position, uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = pos.getX(i) / TILE_GROUND;
      uv[i * 2 + 1] = pos.getZ(i) / TILE_GROUND;
    }
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  }
  const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  scene.add(ground);
  const dirtMat = new THREE.MeshStandardMaterial({
    color: 0xc9c2b0, roughness: 1, metalness: 0 });
  dirtMat.normalScale.set(0.8, 0.8);
  texturize(dirtMat, 'dirt', () => { ground.material = dirtMat; });

  // road / gravel patches: a couple of cm of Y plus polygonOffset keeps them off
  // the base plane at grazing angles without reading as floating decals
  const patchY = { asphalt: 0.022, gravel: 0.014 };
  const patchTint = { asphalt: 0xb4b2ac, gravel: 0xc0bbae };
  for (const mat of ['asphalt', 'gravel']) {
    const list = wGround.filter(q => q && q.mat === mat);
    const geo = slabsGeometry(list, patchY[mat], TILE_GROUND);
    if (!geo) continue;
    const m = new THREE.MeshStandardMaterial({
      color: COL.ground, roughness: 1, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    m.normalScale.set(0.8, 0.8);
    texturize(m, mat, () => { m.color.setHex(patchTint[mat]); });
    scene.add(new THREE.Mesh(geo, m));
  }

  // concrete: perimeter walls, ruin shells, building shells and raised decks.
  // Walls/ruins/platforms share one geometry; buildings get their own so the
  // GLB can retire just them.
  const concreteMat = new THREE.MeshStandardMaterial({
    color: COL.wall, roughness: 0.95, metalness: 0 });
  concreteMat.normalScale.set(0.9, 0.9);
  texturize(concreteMat, 'concrete', () => { concreteMat.color.setHex(0xd6d3c8); });
  const rockMat = new THREE.MeshStandardMaterial({
    color: COL.rock, roughness: 1, metalness: 0, flatShading: true });
  texturize(rockMat, 'gravel', () => { rockMat.color.setHex(0x8e8c84); });

  const structural = [];
  for (const k of ['wall', 'ruin']) if (obstaclesByKind[k]) structural.push(...obstaclesByKind[k]);
  structural.push(...bulkBoxes);
  // A platform top is normally the top face of a solid box that is already
  // drawn (possibly several boxes butted together, as on a catwalk). Only decks
  // with nothing under them get their own slab: two coplanar faces would z-fight.
  const DECK = 0.45;
  for (const p of wPlatforms) {
    if (!(p.y > 0) || !platformUncovered(p)) continue;
    structural.push({ x1: p.x1, z1: p.z1, x2: p.x2, z2: p.z2, y1: Math.max(0, p.y - DECK), h: p.y });
  }
  const structGeo = boxesGeometry(structural, TILE_STRUCT);
  if (structGeo) scene.add(new THREE.Mesh(structGeo, concreteMat));
  for (const [kind, tex] of Object.entries(MERGED_KINDS)) {
    if (kind === 'wall' || kind === 'ruin') continue; // already in structGeo
    const geo = boxesGeometry(propBoxes[kind] || [], TILE_STRUCT);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, tex === 'gravel' ? rockMat : concreteMat);
    scene.add(mesh);
    boxMeshByKind[kind] = mesh; // a prop GLB may retire it
  }

  // every other kind keeps a flat-coloured instanced box until its model lands
  const box = new THREE.BoxGeometry(1, 1, 1);
  const m4 = new THREE.Matrix4();
  for (const [kind, list] of Object.entries(propBoxes)) {
    if (MERGED_KINDS[kind]) continue;
    const mat = new THREE.MeshLambertMaterial({ color: COL[kind] ?? 0x666660, flatShading: true });
    const inst = new THREE.InstancedMesh(box, mat, list.length);
    list.forEach((b, i) => {
      m4.makeScale(b.x2 - b.x1, b.h, b.z2 - b.z1);
      m4.setPosition((b.x1 + b.x2) / 2, b.h / 2, (b.z1 + b.z2) / 2);
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
    boxMeshByKind[kind] = inst;
  }

  // legacy scatter: only when the world ships no props of its own
  if (!wProps.length) {
    const trunkGeo = new THREE.CylinderGeometry(0.14, 0.24, 3.4, 5);
    const trunks = new THREE.InstancedMesh(trunkGeo,
      new THREE.MeshLambertMaterial({ color: 0x4a4036, flatShading: true }), 24);
    let placed = 0, guard = 0;
    while (placed < 24 && guard++ < 300) {
      const x = (rnd() * 2 - 1) * (world.size - 6), z = (rnd() * 2 - 1) * (world.size - 6);
      if (world.obstacles.some(b => x > b.x1 - 1 && x < b.x2 + 1 && z > b.z1 - 1 && z < b.z2 + 1)) continue;
      m4.makeRotationY(rnd() * 6.28);
      m4.setPosition(x, 1.7, z);
      trunks.setMatrixAt(placed++, m4);
    }
    trunks.count = placed;
    trunks.instanceMatrix.needsUpdate = true;
    scene.add(trunks);
  }
}

// --- prop models (optional; the boxes above stay if a GLB is absent) ---------
// Each source mesh of the model becomes one InstancedMesh, so a whole kind
// costs one draw call per material however many copies the level places.
function collectMeshes(root) {
  const srcs = [];
  root.traverse(n => { if (n.isMesh && n.geometry) srcs.push(n); });
  return srcs;
}
// normalize: centered in XZ, bottom on y=0, fitted into a 1x1x1 box
function fitUnitBox(root) {
  root.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(root);
  const sx = Math.max(1e-3, bb.max.x - bb.min.x);
  const sy = Math.max(1e-3, bb.max.y - bb.min.y);
  const sz = Math.max(1e-3, bb.max.z - bb.min.z);
  const swap = sz > sx; // model's long side runs along Z — turn it onto X
  const m = new THREE.Matrix4().makeTranslation(
    -(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  const tmp = new THREE.Matrix4();
  if (swap) m.premultiply(tmp.makeRotationY(Math.PI / 2));
  m.premultiply(tmp.makeScale(1 / (swap ? sz : sx), 1 / sy, 1 / (swap ? sx : sz)));
  return m;
}
// normalize: centered in XZ, bottom on y=0, exactly 1 unit tall (uniform)
function fitUnitHeight(root) {
  root.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(root);
  const s = 1 / Math.max(1e-3, bb.max.y - bb.min.y);
  const m = new THREE.Matrix4().makeTranslation(
    -(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  return m.premultiply(new THREE.Matrix4().makeScale(s, s, s));
}
function instanceRoot(root, norm, count, place) {
  const srcs = collectMeshes(root);
  if (!srcs.length || !count) return false;
  const p = new THREE.Matrix4(), out = new THREE.Matrix4();
  for (const src of srcs) {
    const im = new THREE.InstancedMesh(src.geometry, src.material, count);
    im.frustumCulled = false;
    for (let i = 0; i < count; i++) {
      place(i, p);
      out.multiplyMatrices(p, norm).multiply(src.matrixWorld);
      im.setMatrixAt(i, out);
    }
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);
  }
  return true;
}
const OBSTACLE_MODELS = {
  container: 'prop_container', rubble: 'prop_sandbags', barrier: 'prop_barrier',
  car: 'prop_car', crate: 'prop_crate', barrel: 'prop_barrel',
  tower: 'prop_tower', building: 'prop_building',
};
function instanceProp(url, kind) {
  const list = propBoxes[kind];
  if (!list || !list.length) return;
  const scratch = new THREE.Matrix4();
  new GLTFLoader().load(url, gltf => {
    const ok = instanceRoot(gltf.scene, fitUnitBox(gltf.scene), list.length, (i, out) => {
      const b = list[i];
      const w = b.x2 - b.x1, d = b.z2 - b.z1;
      const turn = d > w;
      // deterministic 180° flip so identical props don't all face the same way
      const flip = ((Math.abs(b.x1 * 7.3 + b.z1 * 3.1) | 0) & 1) ? Math.PI : 0;
      out.makeRotationY((turn ? Math.PI / 2 : 0) + flip);
      out.multiply(scratch.makeScale(turn ? d : w, b.h, turn ? w : d));
      out.setPosition((b.x1 + b.x2) / 2, 0, (b.z1 + b.z2) / 2);
    });
    const boxes = boxMeshByKind[kind];
    if (ok && boxes) boxes.visible = false;
  }, undefined, () => { /* keep the box rendering for this kind */ });
}
for (const kind of Object.keys(OBSTACLE_MODELS)) {
  instanceProp(`./assets/models/${OBSTACLE_MODELS[kind]}.glb`, kind);
}

// --- decoration props: world.props, no collision ------------------------------
const DECOR_MODELS = { tree: 'prop_tree', pole: 'prop_pole' };
const DECOR_SIZE = { tree: 6.5, pole: 7.5 }; // metres tall at s = 1
function decorFallback(kind) {
  const g = new THREE.Group();
  const pole = kind === 'pole';
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(pole ? 0.035 : 0.045, pole ? 0.06 : 0.075, 1, 5),
    new THREE.MeshLambertMaterial({ color: pole ? 0x544c40 : 0x4a4036, flatShading: true }));
  m.position.y = 0.5;
  if (pole) m.rotation.z = 0.07; // leaning utility pole
  g.add(m);
  return g;
}
{
  const byKind = {};
  for (const p of wProps) {
    if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') continue;
    (byKind[p.kind] ??= []).push(p);
  }
  const sv = new THREE.Vector3();
  for (const kind of Object.keys(byKind)) {
    const list = byKind[kind];
    const place = (i, out) => {
      const p = list[i];
      // s reads as a multiplier of the kind's natural height; a value only
      // sensible as metres is taken literally so either convention works.
      const n = typeof p.s === 'number' && p.s > 0 ? p.s : 1;
      const h = n > 2.5 ? n : (DECOR_SIZE[kind] || 4) * n;
      out.makeRotationY(typeof p.ry === 'number' ? p.ry : 0);
      out.scale(sv.set(h, h, h));
      out.setPosition(p.x, groundHeightAt(p.x, p.z, world), p.z);
    };
    const fallback = () => {
      const root = decorFallback(kind);
      instanceRoot(root, fitUnitHeight(root), list.length, place);
    };
    const file = DECOR_MODELS[kind];
    if (!file) { fallback(); continue; }
    new GLTFLoader().load(`./assets/models/${file}.glb`, g => {
      if (!instanceRoot(g.scene, fitUnitHeight(g.scene), list.length, place)) fallback();
    }, undefined, fallback);
  }
}

// pickup markers
const pickupMeshes = new Map();
const pickupById = new Map();
for (const pk of wPickups) {
  pickupById.set(pk.id, pk);
  const grp = new THREE.Group();
  const isHealth = pk.type === 'health';
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.7),
    new THREE.MeshLambertMaterial({ color: isHealth ? 0x3d5a3d : 0x44483c, flatShading: true }));
  body.name = 'pickup-body';
  grp.add(body);
  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(0.78, 0.16, 0.78),
    new THREE.MeshBasicMaterial({ color: COL.accent }));
  glow.position.y = 0;
  grp.add(glow);
  // no PointLight here on purpose: the unlit glow slab already reads as a
  // marker, and nine extra lights cost a full GGX evaluation per fragment of
  // every standard-material surface in the world
  grp.userData.baseY = groundHeightAt(pk.x, pk.z, world) + 1.0;
  grp.position.set(pk.x, grp.userData.baseY, pk.z);
  scene.add(grp);
  pickupMeshes.set(pk.id, grp);
}

// --- player avatar templates -------------------------------------------------
// Two rigged soldiers, picked deterministically per player id so a given
// callsign always looks the same. player.glb (the DeadZone walker) is the
// fallback, a capsule the fallback of last resort. Templates arrive async;
// avatarEpoch bumps so live remotes re-attach to the better model.
let avatarEpoch = 0;
const avatarSlots = [null, null]; // soldier_a, soldier_b
let fallbackTpl = null;
function makeAvatarTpl(key, gltf, targetH) {
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const h = Math.max(0.01, box.max.y - box.min.y);
  const scale = targetH / h;
  gltf.scene.traverse(n => {
    if (n.isMesh || n.isSkinnedMesh) { n.castShadow = false; n.frustumCulled = false; }
  });
  return {
    key, scene: gltf.scene, scale, yOff: -box.min.y * scale,
    clip: (gltf.animations && gltf.animations[0]) || null,
  };
}
{
  const gl = new GLTFLoader();
  gl.load('./assets/models/player.glb', g => {
    fallbackTpl = makeAvatarTpl('player', g, 2.35);
    avatarEpoch++;
  }, undefined, () => { /* capsule avatars */ });
  ['soldier_a', 'soldier_b'].forEach((key, i) => {
    gl.load(`./assets/models/${key}.glb`, g => {
      // ~1.9m tall matches the server head/body hit spheres (1.62 + 0.3r)
      avatarSlots[i] = makeAvatarTpl(key, g, 1.9);
      avatarEpoch++;
    }, undefined, () => { /* falls back to player.glb */ });
  });
}
function pickAvatarTpl(id) {
  const want = id % avatarSlots.length;
  if (avatarSlots[want]) return avatarSlots[want];
  for (let i = 0; i < avatarSlots.length; i++) if (avatarSlots[i]) return avatarSlots[i];
  return fallbackTpl;
}
// Right-hand attachment point. Bone naming varies wildly between exporters, so
// score on part name + a right-side marker and take the best.
function findHandBone(root) {
  let best = null, bestScore = 0;
  root.traverse(n => {
    const nm = (n.name || '').toLowerCase();
    if (!nm) return;
    let part = 0;
    if (nm.includes('hand')) part = 3;
    else if (nm.includes('wrist')) part = 2;
    else if (nm.includes('forearm') || nm.includes('lowerarm')) part = 1;
    if (!part) return;
    if (nm.includes('left') || nm.endsWith('_l') || nm.endsWith('.l') || nm.includes('_l_')) return;
    const right = nm.includes('right') || nm.endsWith('_r') || nm.endsWith('.r') ||
      nm.includes('_r_') || /(^|[^a-z])r([^a-z]|$)/.test(nm) || nm.endsWith('r');
    if (!right) return;
    const score = part + (n.isBone ? 10 : 0);
    if (score > bestScore) { bestScore = score; best = n; }
  });
  return best;
}
const capsuleGeo = new THREE.CapsuleGeometry(0.4, 1.0, 4, 8);
const capsuleMat = new THREE.MeshLambertMaterial({ color: COL.skin, flatShading: true });

function makeNameSprite(rawName, team) {
  const name = String(rawName ?? '???');
  const friend = team === myTeam;
  const c = document.createElement('canvas'); c.width = 256; c.height = 56;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 30px monospace'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(0, 0, 256, 56);
  // squadmates read green, hostiles red — the single most important glance
  ctx.fillStyle = team === undefined ? '#cfe0b0' : (friend ? '#8fe87a' : '#ff8a7a');
  ctx.fillText((friend ? '▲ ' : '') + name.toUpperCase(), 128, 38);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(1.9, 0.42, 1);
  sp.position.y = 2.25;
  return sp;
}

function attachAvatar(r) {
  r.epoch = avatarEpoch;
  if (r.avatarInst) { r.body.remove(r.avatarInst); r.avatarInst = null; }
  if (r.gunHolder && r.gunHolder.parent) r.gunHolder.parent.remove(r.gunHolder);
  r.gunHolder = null; r.muzzle = null; r.gunWeapon = ''; r.handBone = null;
  r.mixer = null; r.action = null;
  const tpl = pickAvatarTpl(r.id);
  if (tpl) {
    const inst = cloneSkeleton(tpl.scene);
    inst.scale.setScalar(tpl.scale);
    inst.position.y = tpl.yOff;
    r.body.add(inst);
    r.avatarInst = inst;
    r.tplKey = tpl.key;
    r.handBone = findHandBone(inst);
    if (tpl.clip) {
      r.mixer = new THREE.AnimationMixer(inst);
      r.action = r.mixer.clipAction(tpl.clip);
      r.action.play();
      r.mixer.update((r.id * 0.53) % tpl.clip.duration); // desync identical clips
    }
  } else {
    const cap = new THREE.Mesh(capsuleGeo, capsuleMat);
    cap.position.y = 0.9;
    r.body.add(cap);
    r.avatarInst = cap;
    r.tplKey = 'capsule';
  }
}

// --- gun models (generated GLBs; procedural boxes as fallback) ---------------
// tune: len = world length of the gun in view, rot = orientation fix after
// auto-aligning the longest axis to Z, pos = grip offset in the holder,
// ads = where the holder sits while aiming, adsRot = pitch applied on top of it.
// ADS has to be per weapon: the models are all normalised to the same length, so
// a taller sight line (the longshot's scope) ends up further below the crosshair
// than the rifle's rail does, and one shared offset cannot frame both.
const GUN_TUNE = {
  rifle:    { len: 0.8,  rot: [-0.12, -Math.PI / 2, 0], pos: [0, -0.02, 0.1],
              ads: [0, -0.19, -0.60], adsRot: 0 },
  shotgun:  { len: 0.78, rot: [-0.12, -Math.PI / 2, 0], pos: [0, -0.02, 0.1],
              ads: [0, -0.165, -0.58], adsRot: 0 },
  // scope sits highest and the barrel is longest: lift it to the sight line and
  // level out the tune's muzzle-down tilt so the tube points at the crosshair
  longshot: { len: 1.0,  rot: [-0.12, -Math.PI / 2, 0], pos: [0, -0.02, 0.14],
              ads: [0.009, -0.058, -0.60], adsRot: 0.1 },
  // no sidearm model yet: the rifle GLB shrunk down and pulled in reads as a
  // stubby weapon in hand, and the procedural fallback covers it if it 404s
  pistol:   { len: 0.42, rot: [-0.12, -Math.PI / 2, 0], pos: [0.02, -0.06, 0.02],
              ads: [0, -0.13, -0.5], adsRot: 0, model: 'rifle' },
};
const ADS_FALLBACK = [0, -0.19, -0.60];
const gunModels = {};
{
  const gl = new GLTFLoader();
  for (const w of Object.keys(GUN_TUNE)) {
    // a tune may borrow another gun's mesh (the sidearm has no model of its own)
    const file = GUN_TUNE[w].model || w;
    gl.load(`./assets/models/gun_${file}.glb`, g => {
      gunModels[w] = normalizeGun(g.scene, w);
      if (me.weapon === w) buildViewmodel(w);
      refreshPickupVisual(w);
    }, undefined, () => { /* keep procedural fallback */ });
  }
}
// Center the model, scale to tune.len, apply the per-gun orientation fix
// (tuned by eye against orientation grids — Meshy output axes vary per model).
function normalizeGun(scene, weapon) {
  const tune = GUN_TUNE[weapon];
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  scene.position.sub(center);
  const inner = new THREE.Group();
  inner.add(scene);
  inner.scale.setScalar(tune.len / Math.max(size.x, size.y, size.z));
  const wrap = new THREE.Group();
  wrap.add(inner);
  wrap.rotation.set(tune.rot[0], tune.rot[1], tune.rot[2]);
  return wrap;
}
function refreshPickupVisual(weapon) {
  for (const pk of wPickups) {
    if (pk.type !== weapon) continue;
    const grp = pickupMeshes.get(pk.id);
    if (!grp || !gunModels[weapon]) continue;
    const old = grp.getObjectByName('pickup-body');
    if (old) grp.remove(old);
    const inst = gunModels[weapon].clone(true);
    inst.name = 'pickup-body';
    inst.rotation.z = 0.35;
    grp.add(inst);
  }
}

// --- guns in remote hands -----------------------------------------------------
let flashTex = null;
function getFlashTex() {
  if (flashTex) return flashTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 1, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,250,225,1)');
  g.addColorStop(0.25, 'rgba(255,206,120,0.85)');
  g.addColorStop(0.6, 'rgba(255,150,50,0.28)');
  g.addColorStop(1, 'rgba(255,140,40,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  // a couple of spikes so it reads as a flash and not a blob
  x.strokeStyle = 'rgba(255,240,200,0.7)'; x.lineWidth = 3;
  x.beginPath(); x.moveTo(4, 32); x.lineTo(60, 32); x.moveTo(32, 8); x.lineTo(32, 56); x.stroke();
  flashTex = new THREE.CanvasTexture(c);
  return flashTex;
}
const procGunCache = {};
function makeProcGun(weapon) {
  if (!procGunCache[weapon]) {
    const s = (WEAPONS[weapon] || WEAPONS.rifle).vmSize;
    const metal = new THREE.MeshLambertMaterial({ color: 0x33352f, flatShading: true });
    const grip = new THREE.MeshLambertMaterial({ color: 0x2a241c, flatShading: true });
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.07 * s, 0.1 * s, 0.42 * s), metal);
    g.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022 * s, 0.022 * s, 0.36 * s, 6), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.02 * s, -0.34 * s);
    g.add(barrel);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.055 * s, 0.14 * s, 0.08 * s), grip);
    handle.position.set(0, -0.1 * s, 0.1 * s);
    handle.rotation.x = 0.3;
    g.add(handle);
    procGunCache[weapon] = g;
  }
  return procGunCache[weapon].clone(true); // clones share geometry + materials
}
// The gun hangs off the right-hand bone when the rig exposes one, but its
// orientation is re-derived from the torso every frame (bone axes are
// unknowable across exporters), so the barrel always points where the player
// faces instead of wherever the animator's wrist axis happens to look.
function buildRemoteGun(r, weapon) {
  if (r.gunHolder && r.gunHolder.parent) r.gunHolder.parent.remove(r.gunHolder);
  r.gunWeapon = weapon;
  r.gunModelled = !!gunModels[weapon];
  const tune = GUN_TUNE[weapon] || GUN_TUNE.rifle;
  const holder = new THREE.Group();
  const pivot = new THREE.Group();
  pivot.position.set(0, -0.03, -0.22); // grip in the palm, body of the gun forward
  holder.add(pivot);
  pivot.add(gunModels[weapon] ? gunModels[weapon].clone(true) : makeProcGun(weapon));
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getFlashTex(), transparent: true, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending }));
  sp.position.set(0, 0.02, -tune.len * 0.62);
  sp.scale.set(0.4, 0.4, 1);
  sp.visible = false;
  pivot.add(sp);
  r.muzzle = sp;
  if (r.handBone) {
    r.handBone.add(holder);
    r.body.updateWorldMatrix(true, true);
    r.handBone.matrixWorld.decompose(_v1, _q1, _v2);
    const s = (Math.abs(_v2.x) + Math.abs(_v2.y) + Math.abs(_v2.z)) / 3;
    holder.scale.setScalar(s > 1e-6 ? 1 / s : 1); // undo the rig's scale chain
  } else {
    holder.position.set(-0.2, 1.22, 0); // right hand of a body whose forward is +Z
    holder.rotation.y = Math.PI;
    r.body.add(holder);
  }
  r.gunHolder = holder;
}

// --- viewmodel ---------------------------------------------------------------
const vmHolder = new THREE.Group();
vmHolder.position.set(0.3, -0.3, -0.62);
camera.add(vmHolder);
let vmFlash, vmFlashLight, vmRecoil = 0;
function buildViewmodel(weapon) {
  vmHolder.clear();
  const tune = GUN_TUNE[weapon];
  if (gunModels[weapon]) {
    const g = new THREE.Group();
    const inst = gunModels[weapon].clone(true);
    inst.position.set(tune.pos[0], tune.pos[1], tune.pos[2]);
    g.add(inst);
    vmFlash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22),
      new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0.95, depthWrite: false }));
    vmFlash.position.set(tune.pos[0], tune.pos[1] + 0.03, tune.pos[2] - tune.len * 0.62);
    vmFlash.visible = false;
    g.add(vmFlash);
    vmFlashLight = new THREE.PointLight(0xffaa44, 0, 5);
    vmFlashLight.position.copy(vmFlash.position);
    g.add(vmFlashLight);
    vmHolder.add(g);
    return;
  }
  const s = WEAPONS[weapon].vmSize;
  const metal = new THREE.MeshStandardMaterial({ color: 0x33352f, metalness: 0.7, roughness: 0.45 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x2a241c, roughness: 0.9 });
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.07 * s, 0.1 * s, 0.36 * s), metal);
  g.add(body);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02 * s, 0.02 * s, 0.32 * s, 6), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02 * s, -0.32 * s);
  g.add(barrel);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.055 * s, 0.14 * s, 0.08 * s), grip);
  handle.position.set(0, -0.1 * s, 0.1 * s);
  handle.rotation.x = 0.3;
  g.add(handle);
  if (weapon !== 'rifle') {
    const pump = new THREE.Mesh(new THREE.BoxGeometry(0.05 * s, 0.05 * s, 0.15 * s), grip);
    pump.position.set(0, -0.05 * s, -0.2 * s);
    g.add(pump);
  }
  vmFlash = new THREE.Mesh(new THREE.PlaneGeometry(0.2 * s, 0.2 * s),
    new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0.95, depthWrite: false }));
  vmFlash.position.set(0, 0.02 * s, -0.5 * s);
  vmFlash.visible = false;
  g.add(vmFlash);
  vmFlashLight = new THREE.PointLight(0xffaa44, 0, 5);
  vmFlashLight.position.copy(vmFlash.position);
  g.add(vmFlashLight);
  vmHolder.add(g);
}
buildViewmodel('rifle');

// --- audio -------------------------------------------------------------------
let actx = null, master = null;
const sndBufs = {};
const SOUNDS = ['rifle', 'shotgun', 'hit', 'death', 'pickup', 'step', 'land', 'wind'];
// one-pole-filtered noise burst: stands in for step/land when no file shipped
function makeThudBuf(dur, cut, pow) {
  const n = Math.max(1, Math.floor(actx.sampleRate * dur));
  const buf = actx.createBuffer(1, n, actx.sampleRate);
  const d = buf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += ((Math.random() * 2 - 1) - lp) * cut;
    d[i] = lp * (1 - i / n) ** pow;
  }
  return buf;
}
function loopBuffer(buf, vol) {
  const src = actx.createBufferSource();
  src.buffer = buf; src.loop = true;
  const g = actx.createGain(); g.gain.value = vol;
  src.connect(g); g.connect(master); src.start();
}
async function initAudio() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  master = actx.createGain(); master.gain.value = 0.6; master.connect(actx.destination);
  for (const name of [...SOUNDS, 'music']) {
    for (const ext of ['mp3', 'm4a', 'wav', 'ogg']) {
      try {
        const res = await fetch(`./assets/sounds/${name}.${ext}`);
        if (!res.ok) continue;
        sndBufs[name] = await actx.decodeAudioData(await res.arrayBuffer());
        break;
      } catch { /* keep silent fallback */ }
    }
  }
  if (!sndBufs.step) sndBufs.step = makeThudBuf(0.10, 0.38, 2.2);
  if (!sndBufs.land) sndBufs.land = makeThudBuf(0.24, 0.10, 2.6);
  if (sndBufs.music) loopBuffer(sndBufs.music, 0.16);
  if (sndBufs.wind) loopBuffer(sndBufs.wind, 0.18); // ambience, under everything
}
function play(name, vol = 1, pos = null) {
  if (!actx || !sndBufs[name]) return;
  const src = actx.createBufferSource();
  src.buffer = sndBufs[name];
  const g = actx.createGain();
  let v = vol;
  if (pos) {
    const d = Math.hypot(pos.x - me.x, pos.z - me.z);
    v = vol * Math.max(0.05, 1 - d / 70);
  }
  g.gain.value = Math.min(1, v * 0.5);
  src.connect(g); g.connect(master); src.start();
}

// --- grenades + explosions ------------------------------------------------
const nadeMeshes = [];
const nadeGeo = new THREE.SphereGeometry(0.12, 8, 8);
const nadeMat = new THREE.MeshLambertMaterial({ color: 0x2e332a });
function syncGrenades(list) {
  while (nadeMeshes.length < list.length) {
    const m = new THREE.Mesh(nadeGeo, nadeMat);
    scene.add(m);
    nadeMeshes.push(m);
  }
  nadeMeshes.forEach((m, i) => {
    if (i < list.length) { m.visible = true; m.position.set(list[i][0], list[i][1], list[i][2]); }
    else m.visible = false;
  });
}
let shakeT = 0;
// One light and one puff, built once and never removed. Adding or removing a
// PointLight changes the scene's light count, which is baked into every lit
// material's program cache key — a blast would otherwise recompile every
// standard material in the world twice.
const boomLight = new THREE.PointLight(0xffb050, 0, 26);
boomLight.position.set(0, -50, 0);
scene.add(boomLight);
const boomPuff = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 10),
  new THREE.MeshBasicMaterial({ color: 0xd8c9a0, transparent: true, opacity: 0, depthWrite: false }));
boomPuff.visible = false;
scene.add(boomPuff);
let boomT0 = 0, boomRunning = false, boomScale = 1;
function explodeAt(x, y, z, scale = 1) {
  boomScale = scale;
  boomLight.position.set(x, y + 0.6, z);
  boomPuff.position.set(x, y + 0.6, z);
  boomPuff.visible = true;
  boomT0 = performance.now();
  if (!boomRunning) {
    boomRunning = true;
    const grow = () => {
      const t = (performance.now() - boomT0) / 450;
      if (t >= 1) {
        boomRunning = false;
        boomLight.intensity = 0;
        boomPuff.visible = false;
        return;
      }
      boomPuff.scale.setScalar((1 + t * 7) * boomScale);
      boomPuff.material.opacity = 0.85 * (1 - t);
      boomLight.intensity = 30 * boomScale * (1 - t);
      requestAnimationFrame(grow);
    };
    grow();
  }
  const d = Math.hypot(x - me.x, z - me.z);
  const reach = 30 * scale;
  if (d < reach) shakeT = Math.max(shakeT, 0.35 * scale * (1 - d / reach));
  synthBoom(Math.max(0.1, (1 - d / (70 * scale)) * scale));
}
function synthBoom(vol) {
  if (!actx) return;
  const t0 = actx.currentTime;
  const buf = actx.createBuffer(1, actx.sampleRate * 0.7, actx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
  const src = actx.createBufferSource();
  src.buffer = buf;
  const f = actx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.setValueAtTime(900, t0);
  f.frequency.exponentialRampToValueAtTime(90, t0 + 0.6);
  const g = actx.createGain();
  g.gain.setValueAtTime(Math.min(0.9, vol), t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.7);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0);
  const osc = actx.createOscillator();
  osc.type = 'sine'; osc.frequency.setValueAtTime(60, t0);
  osc.frequency.exponentialRampToValueAtTime(28, t0 + 0.5);
  const g2 = actx.createGain();
  g2.gain.setValueAtTime(vol * 0.7, t0);
  g2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
  osc.connect(g2); g2.connect(master);
  osc.start(t0); osc.stop(t0 + 0.6);
}

// low-health heartbeat: two sine thumps, faster and louder as hp drops
function thumpAt(t, vol) {
  const osc = actx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(76, t);
  osc.frequency.exponentialRampToValueAtTime(38, t + 0.14);
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.02, vol), t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  osc.connect(g); g.connect(master);
  osc.start(t); osc.stop(t + 0.26);
}
function synthHeartbeat(vol) {
  if (!actx) return;
  const t0 = actx.currentTime;
  thumpAt(t0, vol * 0.45);
  thumpAt(t0 + 0.19, vol * 0.28);
}

// --- air units --------------------------------------------------------------
// Built from primitives: a gunship and a jet, both flat-shaded to match the
// world. Pooled and hidden rather than rebuilt — the snapshot drives them.
const airPool = { heli: [], jet: [] };
const bombPool = [];
const airMat = new THREE.MeshLambertMaterial({ color: 0x4a4f45, flatShading: true });
const airDark = new THREE.MeshLambertMaterial({ color: 0x2b2f28, flatShading: true });

function buildHeli() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.5, 4.2, 4, 8), airMat);
  body.rotation.z = Math.PI / 2;
  g.add(body);
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.22, 6, 6), airMat);
  tail.rotation.z = Math.PI / 2;
  tail.position.x = -5;
  g.add(tail);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.8, 0.9), airDark);
  fin.position.set(-7.6, 0.7, 0);
  g.add(fin);
  for (const sx of [-1, 1]) {
    const skid = new THREE.Mesh(new THREE.BoxGeometry(5, 0.18, 0.18), airDark);
    skid.position.set(0.4, -1.8, sx * 1.3);
    g.add(skid);
  }
  const rotor = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.09, 0.5), airDark);
    blade.rotation.y = (i / 4) * Math.PI * 2;
    rotor.add(blade);
  }
  rotor.position.y = 1.9;
  g.add(rotor);
  g.userData.rotor = rotor;
  const tr = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 0.28), airDark);
    b.rotation.x = (i / 3) * Math.PI * 2;
    tr.add(b);
  }
  tr.position.set(-7.6, 0.7, 0.5);
  g.add(tr);
  g.userData.tail = tr;
  return g;
}

function buildJet() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.5, 12, 8), airMat);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.85, 3, 8), airMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -7.4;
  g.add(nose);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(13, 0.3, 3.2), airMat);
  wing.position.z = 1;
  g.add(wing);
  const tailw = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.25, 1.6), airMat);
  tailw.position.z = 5.4;
  g.add(tailw);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.4, 2.2), airDark);
  fin.position.set(0, 1.2, 5.2);
  g.add(fin);
  return g;
}

function syncAir(list) {
  const used = { heli: 0, jet: 0 };
  for (const a of list) {
    const kind = a[0] === 'jet' ? 'jet' : 'heli';
    const pool = airPool[kind];
    let e = pool[used[kind]];
    if (!e) {
      e = kind === 'jet' ? buildJet() : buildHeli();
      scene.add(e);
      pool.push(e);
    }
    e.visible = true;
    e.position.set(a[1], a[2], a[3]);
    e.rotation.y = a[4];
    used[kind]++;
  }
  for (const kind of ['heli', 'jet']) {
    for (let i = used[kind]; i < airPool[kind].length; i++) airPool[kind][i].visible = false;
  }
  if (used.heli && !heliSound) startHeliSound();
  if (!used.heli && heliSound) stopHeliSound();
}

function syncBombs(list) {
  while (bombPool.length < list.length) {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.9, 3, 6), airDark);
    scene.add(m);
    bombPool.push(m);
  }
  bombPool.forEach((m, i) => {
    if (i < list.length) { m.visible = true; m.position.set(list[i][0], list[i][1], list[i][2]); }
    else m.visible = false;
  });
}

// rotor wash: a looping synthesized thump that follows the gunship
let heliSound = null;
function startHeliSound() {
  if (!actx || heliSound) return;
  const osc = actx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 26;
  const lfo = actx.createOscillator();
  lfo.frequency.value = 15;              // blade-pass rate
  const lfoGain = actx.createGain();
  lfoGain.gain.value = 0.5;
  const g = actx.createGain();
  g.gain.value = 0.0;
  const f = actx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 340;
  lfo.connect(lfoGain); lfoGain.connect(g.gain);
  osc.connect(f); f.connect(g); g.connect(master);
  osc.start(); lfo.start();
  heliSound = { osc, lfo, g };
}
function stopHeliSound() {
  if (!heliSound) return;
  try { heliSound.osc.stop(); heliSound.lfo.stop(); } catch {}
  heliSound = null;
}

// jet pass: a rising then falling roar, fired when a jet spawns
function jetRoar() {
  if (!actx) return;
  const t0 = actx.currentTime;
  const buf = actx.createBuffer(1, actx.sampleRate * 3.2, actx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = actx.createBufferSource(); src.buffer = buf;
  const f = actx.createBiquadFilter(); f.type = 'bandpass';
  f.frequency.setValueAtTime(180, t0);
  f.frequency.exponentialRampToValueAtTime(900, t0 + 1.6);
  f.frequency.exponentialRampToValueAtTime(140, t0 + 3.1);
  f.Q.value = 0.8;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.001, t0);
  g.gain.exponentialRampToValueAtTime(0.5, t0 + 1.6);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 3.1);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + 3.2);
}

// --- distant war: missiles rising from behind the ridgeline -----------------
// Pure backdrop. Fog-exempt like the mountains, on its own slow schedule.
const missiles = [];
// These sit 700 m out, so they have to be big to read at all: a 2 m rocket at
// that range is a sub-pixel speck. Scaled for silhouette, not for realism.
const missileMat = new THREE.MeshBasicMaterial({ color: 0xffe3b0, fog: false });
// darker than the sky: white smoke vanishes against this haze, grey reads
const trailMat = new THREE.MeshBasicMaterial({
  color: 0x6c6559, transparent: true, opacity: 0.7, fog: false, depthWrite: false });
let nextMissileAt = 6000;
function launchMissile(now) {
  const a = Math.random() * Math.PI * 2;
  // beyond the mountain ring (which reaches ~620) so they rise from behind it
  const r = 660 + Math.random() * 120;
  const head = new THREE.Mesh(new THREE.SphereGeometry(7, 8, 8), missileMat);
  const trail = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 9, 1, 6), trailMat);
  const base = new THREE.Vector3(Math.cos(a) * r, -10, Math.sin(a) * r);
  head.position.copy(base);
  scene.add(head); scene.add(trail);
  missiles.push({
    head, trail, base,
    // slight lean so they arc rather than rise like elevators
    lean: new THREE.Vector3((Math.random() - 0.5) * 0.35, 0, (Math.random() - 0.5) * 0.35),
    t: 0, life: 8 + Math.random() * 4, speed: 70 + Math.random() * 40,
  });
  // the report arrives late, the way distance actually works
  setTimeout(() => distantBoom(), 1400 + Math.random() * 2200);
}
function distantBoom() {
  if (!actx) return;
  const t0 = actx.currentTime;
  const buf = actx.createBuffer(1, actx.sampleRate * 1.6, actx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = actx.createBufferSource(); src.buffer = buf;
  const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 130;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.22, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.5);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0);
}
function updateMissiles(dt, now) {
  if (now > nextMissileAt) {
    nextMissileAt = now + 9000 + Math.random() * 16000;
    launchMissile(now);
    if (Math.random() < 0.45) setTimeout(() => launchMissile(now), 700 + Math.random() * 900);
  }
  for (let i = missiles.length - 1; i >= 0; i--) {
    const m = missiles[i];
    m.t += dt;
    if (m.t > m.life) {
      scene.remove(m.head); scene.remove(m.trail);
      missiles.splice(i, 1);
      continue;
    }
    const h = m.t * m.speed;
    m.head.position.set(m.base.x + m.lean.x * h, m.base.y + h, m.base.z + m.lean.z * h);
    // the trail is one stretched cylinder from the pad to the warhead
    const midY = m.base.y + h / 2;
    m.trail.position.set(m.base.x + m.lean.x * h / 2, midY, m.base.z + m.lean.z * h / 2);
    m.trail.scale.set(1, Math.max(0.001, h), 1);
    m.trail.material.opacity = 0.75 * (1 - m.t / m.life);
    const fade = 1 - m.t / m.life;
    m.head.scale.setScalar(0.6 + fade * 0.8);
  }
}

// --- minimap ---------------------------------------------------------------
const mmCanvas = $('minimap');
const mmCtx = mmCanvas.getContext('2d');
const MM = mmCanvas.width || 148;
const MMPX = MM / (world.size * 2);
const zoneEl = $('zone-label');
const mmBase = document.createElement('canvas');
mmBase.width = mmBase.height = MM;
{
  const b = mmBase.getContext('2d');
  const S = world.size, px = MMPX;
  const rect = (o, pad) => b.fillRect((o.x1 + S) * px, (o.z1 + S) * px,
    Math.max(pad, (o.x2 - o.x1) * px), Math.max(pad, (o.z2 - o.z1) * px));
  b.fillStyle = 'rgba(30,30,34,0.9)';
  b.fillRect(0, 0, MM, MM);
  // roads and gravel beds first: they are what makes the layout readable
  for (const q of wGround) {
    if (!q) continue;
    b.fillStyle = q.mat === 'asphalt' ? '#3b3b42' : q.mat === 'gravel' ? '#4b4941' : '#3f3d37';
    rect(q, 1);
  }
  // raised decks read as a lighter plate under the walls
  b.fillStyle = 'rgba(158,158,146,0.20)';
  for (const p of wPlatforms) rect(p, 1);
  b.fillStyle = '#55555c';
  for (const o of world.obstacles) rect(o, 1);
  b.strokeStyle = 'rgba(176,176,162,0.45)';
  b.lineWidth = 1;
  for (const p of wPlatforms) {
    b.strokeRect((p.x1 + S) * px + 0.5, (p.z1 + S) * px + 0.5,
      Math.max(1, (p.x2 - p.x1) * px - 1), Math.max(1, (p.z2 - p.z1) * px - 1));
  }
  // district labels
  b.font = '8px "Courier New", monospace';
  b.textAlign = 'center';
  b.textBaseline = 'middle';
  for (const p of wPois) {
    if (!p || typeof p.x !== 'number') continue;
    const tx = (p.x + S) * px, tz = (p.z + S) * px;
    const label = String(p.name ?? '').toUpperCase().slice(0, 14);
    b.fillStyle = 'rgba(10,10,12,0.75)';
    b.fillText(label, tx + 1, tz + 1);
    b.fillStyle = 'rgba(206,206,190,0.62)';
    b.fillText(label, tx, tz);
  }
}
mmCtx.drawImage(mmBase, 0, 0); // readable before the first snapshot arrives
// name of the district the local player is standing in
let zoneShown = '';
function updateZoneLabel() {
  if (!zoneEl || !wPois.length) return;
  let best = null, bestD = Infinity;
  for (const p of wPois) {
    const d = (p.x - me.x) * (p.x - me.x) + (p.z - me.z) * (p.z - me.z);
    if (d < bestD) { bestD = d; best = p; }
  }
  const name = best ? String(best.name ?? '') : '';
  if (name !== zoneShown) { zoneShown = name; zoneEl.textContent = name.toUpperCase(); }
}
let mmLast = 0;
function drawMinimap(now) {
  if (now - mmLast < 100 || !snapB) return;
  mmLast = now;
  const S = world.size, px = MMPX;
  mmCtx.drawImage(mmBase, 0, 0);
  updateZoneLabel();
  // pickups
  mmCtx.fillStyle = '#57e389';
  for (const [id, active] of snapB.m.pk) {
    if (!active) continue;
    const pk = pickupById.get(id);
    if (!pk) continue;
    mmCtx.fillRect((pk.x + S) * px - 1.5, (pk.z + S) * px - 1.5, 3, 3);
  }
  // players
  for (const row of snapB.m.p) {
    if (row[6] <= 0) continue;
    const isMe = row[0] === myId;
    mmCtx.fillStyle = isMe ? '#ffffff' : TEAM_COL[row[15] === undefined ? 1 : row[15]];
    mmCtx.beginPath();
    mmCtx.arc((row[1] + S) * px, (row[3] + S) * px, isMe ? 3.4 : 2.6, 0, 7);
    mmCtx.fill();
    if (isMe) { // facing wedge
      mmCtx.strokeStyle = '#8aff5a';
      mmCtx.beginPath();
      const a = -row[4] - Math.PI / 2;
      mmCtx.moveTo((row[1] + S) * px, (row[3] + S) * px);
      mmCtx.lineTo((row[1] + S) * px + Math.cos(a) * 8, (row[3] + S) * px + Math.sin(a) * 8);
      mmCtx.stroke();
    }
  }
}

// --- net ----------------------------------------------------------------------
const room = new URLSearchParams(location.search).get('room') ||
  Math.random().toString(36).slice(2, 7);
const devFlag = new URLSearchParams(location.search).has('dev');
history.replaceState(null, '', `?room=${room}` + (devFlag ? '&dev' : ''));
const inviteURL = location.origin + location.pathname + '?room=' + room;
$('invite').innerHTML =
  `<div>${STR.invite}</div><input readonly value="${inviteURL}"><button id="copy-btn">${STR.copy}</button>`;
$('copy-btn').addEventListener('click', () => {
  navigator.clipboard?.writeText(inviteURL);
  $('copy-btn').textContent = STR.copied;
  setTimeout(() => { $('copy-btn').textContent = STR.copy; }, 1200);
});

let ws = null, myId = 0, killTarget = 15, joined = false, wantJoin = false;
let myTeam = 0, teamTarget = 75, teamNames = ['WOLFPACK', 'VULTURES'];
// friendly green / hostile red, used on nameplates, minimap and the score bar
const TEAM_COL = ['#6fdc5a', '#e05545'];
let snapA = null, snapB = null; // last two snapshots for interpolation
const remotes = new Map();      // id -> remote entity
const me = { x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0, eye: 1.55, hp: 100, mag: 30, weapon: 'rifle', reloading: false, alive: true, kills: 0, deaths: 0 };
let mySlot = 0, myStowed = 'pistol';
let serverMe = null;

function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const base = location.pathname.replace(/\/(index\.html)?$/, '');
  return proto + location.host + base + '/ws/' + room;
}
function connect() {
  banner($('sub-banner'), STR.connecting, 0);
  ws = new WebSocket(wsURL());
  ws.addEventListener('open', () => {
    if (wantJoin) sendJoin();
  });
  ws.addEventListener('message', e => onServerMessage(e.data));
  ws.addEventListener('close', () => {
    joined = false;
    if (wantJoin) {
      banner($('sub-banner'), STR.reconnecting, 0);
      setTimeout(connect, 1500);
    }
  });
}
function sendJoin() {
  try { ws.send(JSON.stringify({ t: 'j', name: myName })); } catch {}
}
function send(obj) {
  if (ws && ws.readyState === 1 && joined) { try { ws.send(JSON.stringify(obj)); } catch {} }
}

let myName = '';
$('join-btn').addEventListener('click', startGame);
$('name-input').addEventListener('keydown', e => { if (e.code === 'Enter') startGame(); });
function startGame() {
  myName = ($('name-input').value.trim() || 'DRIFTER').slice(0, 14);
  localStorage.setItem('dz_name', myName);
  wantJoin = true;
  $('join-screen').classList.add('hidden');
  initAudio();
  if (ws && ws.readyState === 1) sendJoin();
  if (!isTouch) tryLock();
}

function onServerMessage(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (m.t === 'w') {
    myId = m.id; killTarget = m.killTarget; joined = true;
    myTeam = m.team | 0;
    teamTarget = m.teamTarget || 75;
    teamNames = m.teamNames || teamNames;
    banner($('sub-banner'), '', 0);
    banner($('center-banner'), teamNames[myTeam], 2600);
    $('js-note').textContent = fmt(STR.killTargetInfo, { n: killTarget });
    return;
  }
  if (m.t === 'full') { banner($('center-banner'), STR.roomFull, 4000); wantJoin = false; return; }
  if (m.t !== 's') return;

  snapA = snapB; snapB = { at: performance.now(), m };

  // my authoritative entry
  for (const row of m.p) {
    if (row[0] !== myId) continue;
    serverMe = row;
    const [, sx, sy, sz, , , hp, kills, deaths, weapon, mag, rel] = row;
    const wasAlive = me.alive;
    me.hp = hp; me.kills = kills; me.deaths = deaths; me.mag = mag; me.reloading = !!rel;
    me.alive = hp > 0;
    myTeam = row[15] === undefined ? myTeam : row[15];
    myStowed = row[16] || myStowed;
    // the server owns which slot is live; derive it rather than tracking locally
    mySlot = (weapon === 'pistol') ? 1 : 0;
    if (me.weapon !== weapon) { me.weapon = weapon; buildViewmodel(weapon); }
    if (wasAlive && !me.alive) onLocalDeath();
    if (!wasAlive && me.alive) { me.x = sx; me.y = sy; me.z = sz; }
    // reconciliation: snap if server disagrees hard. Height gets its own test —
    // a mispredicted platform edge diverges in Y long before it does in XZ —
    // but only while both sides agree we are standing on something. Mid-jump
    // the client is legitimately up to a jump-height above the last snapshot,
    // and correcting there cuts every single jump short.
    if (me.alive && Math.hypot(sx - me.x, sz - me.z) > 2.5) { me.x = sx; me.y = sy; me.z = sz; me.vy = 0; }
    else if (me.alive && me.vy === 0 && !(row[14] & 8) && Math.abs(sy - me.y) > 0.5) { me.y = sy; }
  }

  // pickups
  for (const [id, active] of m.pk) {
    const mesh = pickupMeshes.get(id);
    if (mesh) mesh.visible = !!active;
  }
  syncGrenades(m.g || []);
  syncAir(m.air || []);
  syncBombs(m.bm || []);

  // events
  for (const ev of m.ev) handleEvent(ev, m);
  updateHUD(m);
}

function nameOf(m, id) {
  const row = m.p.find(r => r[0] === id);
  return row ? row[12] : '???';
}
function posOf(m, id) {
  const row = m.p.find(r => r[0] === id);
  return row ? { x: row[1], y: row[2], z: row[3] } : null;
}

function handleEvent(ev, m) {
  const [kind, a, b, c, d] = ev;
  if (kind === 'shot') {
    if (a !== myId) {
      const pos = posOf(m, a);
      if (pos) {
        play(b === 'shotgun' ? 'shotgun' : 'rifle', 0.8, pos);
        if (Array.isArray(c) && c.length === 3) {
          addTracer(new THREE.Vector3(pos.x, pos.y + 1.5, pos.z),
            new THREE.Vector3(c[0], c[1], c[2]));
        }
      }
      const r = remotes.get(a);
      if (r) {
        r.flashUntil = performance.now() + 75;
        if (r.muzzle) { // randomise so repeat shots don't look stamped
          r.muzzle.material.rotation = Math.random() * 6.283;
          const s = 0.32 + Math.random() * 0.18;
          r.muzzle.scale.set(s, s, 1);
        }
      }
    }
  } else if (kind === 'hit') {
    if (a === myId) {
      hitmarker(); play('hit', 0.7);
      const vp = posOf(m, b);
      // start above the name plate (sprite spans y 2.04..2.46) so they don't overlap
      if (vp) showDamageNumber(b, vp.x, vp.y + 2.55, vp.z, c | 0, !!d);
    }
    if (b === myId) {
      damageFlash(); play('hit', 1);
      const shooter = posOf(m, a);
      if (shooter) showDamageDir(shooter);
    }
  } else if (kind === 'step') {
    if (a === myId) play('step', 0.3);
    else { const p = posOf(m, a); if (p) play('step', 0.8, p); }
  } else if (kind === 'land') {
    if (a === myId) play('land', 0.55);
    else { const p = posOf(m, a); if (p) play('land', 0.9, p); }
  } else if (kind === 'kill') {
    // killer id 0 means the air hazard did it; name it after the weapon
    const killer = a === 0 ? (STR.killers[c] || STR.killers.airstrike) : nameOf(m, a);
    feed(fmt(STR.feedKilled, { a: killer, b: nameOf(m, b) }), a === myId || b === myId);
    const pos = posOf(m, b);
    if (pos) play('death', 0.9, pos);
    if (b === myId) {
      banner($('center-banner'), STR.youDied, 2600);
      banner($('sub-banner'), fmt(STR.killedBy, { name: killer }), 2600);
    }
  } else if (kind === 'pickup') {
    if (a === myId) {
      play('pickup', 1);
      const label = b === 'health' ? STR.pickedHealth : (b === 'shotgun' ? STR.pickedShotgun : STR.pickedLongshot);
      banner($('sub-banner'), label, 1500);
    } else {
      const pos = posOf(m, a);
      if (pos) play('pickup', 0.5, pos);
    }
  } else if (kind === 'join') {
    if (a !== myId) feed(fmt(STR.joined, { name: b }), false);
  } else if (kind === 'leave') {
    feed(fmt(STR.left, { name: b }), false);
    const r = remotes.get(a);
    if (r) { scene.remove(r.group); remotes.delete(a); }
  } else if (kind === 'boom') {
    explodeAt(a, b, c);
  } else if (kind === 'airburst') {
    // a jet's ordnance: same machinery as a grenade, much bigger and louder
    explodeAt(a, b, c, 2.6);
  } else if (kind === 'strafe') {
    // [ , gx,gy,gz, tx,tz] — cannon fire from the gunship down to the dirt
    const from = new THREE.Vector3(a, b, c);
    const to = new THREE.Vector3(d, groundHeightAt(d, ev[5], world), ev[5]);
    const dir = to.clone().sub(from).normalize();
    addTracer(from, dir, from.distanceTo(to));
    addPuff(to.x, to.y + 0.2, to.z, 0.5);
    play('rifle', 0.45, { x: to.x, y: to.y, z: to.z });
  } else if (kind === 'air') {
    if (a === 'jet') { jetRoar(); banner($('sub-banner'), STR.airJet, 2600); }
    else banner($('sub-banner'), STR.airHeli, 2600);
  } else if (kind === 'swap') {
    if (a === myId) play('pickup', 0.5);
  } else if (kind === 'end') {
    banner($('center-banner'), fmt(STR.matchOver, { name: b }), 6000);
  } else if (kind === 'restart') {
    banner($('center-banner'), '', 0);
  }
}

function onLocalDeath() { /* respawn overlay is driven from updateHUD */ }

// --- input ---------------------------------------------------------------------
const isTouch = matchMedia('(pointer: coarse)').matches;
if (isTouch) document.body.classList.add('touch');
const held = new Set();
const BIND = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  ArrowUp: 'fwd', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint', Space: 'jump', KeyR: 'reload',
  KeyG: 'nade', Tab: 'score', ControlLeft: 'crouch', ControlRight: 'crouch', KeyC: 'crouch',
  Digit1: 'slot0', Digit2: 'slot1', KeyQ: 'swap',
};
// slot 0 is the long gun, slot 1 the sidearm; Q toggles
function switchTo(i) { if (i !== mySlot) send({ t: 'sw', i }); }
function throwNade() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  send({ t: 'g', d: [dir.x, dir.y + 0.12, dir.z] });
}
addEventListener('keydown', e => {
  const cmd = BIND[e.code];
  if (!cmd) return;
  e.preventDefault();
  if (cmd === 'reload') send({ t: 'r' });
  else if (cmd === 'nade') throwNade();
  else if (cmd === 'slot0') switchTo(0);
  else if (cmd === 'slot1') switchTo(1);
  else if (cmd === 'swap') switchTo(mySlot === 0 ? 1 : 0);
  else held.add(cmd);
});
addEventListener('keyup', e => { const cmd = BIND[e.code]; if (cmd) held.delete(cmd); });

let firing = false, lockFailed = false;
function tryLock() {
  try {
    const r = canvas.requestPointerLock?.();
    if (r && r.catch) r.catch(() => { lockFailed = true; });
  } catch { lockFailed = true; }
}
let ads = false, adsT = 0, sprintT = 0;
addEventListener('mousedown', e => {
  if ($('join-screen').offsetParent) return;
  if (e.button === 2) { ads = true; e.preventDefault(); return; }
  if (e.button !== 0) return;
  if (!isTouch && document.pointerLockElement !== canvas && !lockFailed) { tryLock(); return; }
  firing = true;
});
addEventListener('mouseup', e => {
  if (e.button === 0) firing = false;
  else if (e.button === 2) ads = false;
});
addEventListener('contextmenu', e => { if (!$('join-screen').offsetParent) e.preventDefault(); });
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas) return;
  const s = 0.0022 * (1 - 0.45 * adsT); // aiming down sights slows the look
  me.yaw -= e.movementX * s;
  me.pitch = Math.max(-1.55, Math.min(1.55, me.pitch - e.movementY * s));
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas && joined && !isTouch) {
    banner($('sub-banner'), STR.clickToAim, 1800);
  }
});

// touch: left stick + right-half look + buttons
const stick = { active: false, id: -1, sx: 0, sy: 0, mx: 0, mz: 0 };
const look = { id: -1, lx: 0, ly: 0 };
if (isTouch) {
  const zone = $('stick-zone'), base = $('stick-base'), nub = $('stick-nub');
  zone.addEventListener('touchstart', e => {
    const t = e.changedTouches[0];
    stick.active = true; stick.id = t.identifier; stick.sx = t.clientX; stick.sy = t.clientY;
    base.style.display = nub.style.display = 'block';
    base.style.left = (t.clientX - 55) + 'px'; base.style.top = (t.clientY - 55) + 'px';
    nub.style.left = (t.clientX - 24) + 'px'; nub.style.top = (t.clientY - 24) + 'px';
    e.preventDefault();
  }, { passive: false });
  addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) {
        const dx = t.clientX - stick.sx, dy = t.clientY - stick.sy;
        const len = Math.min(50, Math.hypot(dx, dy));
        const a = Math.atan2(dy, dx);
        stick.mx = Math.cos(a) * len / 50; stick.mz = -Math.sin(a) * len / 50;
        nub.style.left = (stick.sx + Math.cos(a) * len - 24) + 'px';
        nub.style.top = (stick.sy + Math.sin(a) * len - 24) + 'px';
      } else if (t.identifier === look.id) {
        me.yaw -= (t.clientX - look.lx) * 0.005;
        me.pitch = Math.max(-1.55, Math.min(1.55, me.pitch - (t.clientY - look.ly) * 0.005));
        look.lx = t.clientX; look.ly = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive: false });
  addEventListener('touchend', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) {
        stick.active = false; stick.id = -1; stick.mx = stick.mz = 0;
        $('stick-base').style.display = $('stick-nub').style.display = 'none';
      }
      if (t.identifier === look.id) look.id = -1;
    }
  });
  addEventListener('touchstart', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) continue;
      const el = document.elementFromPoint(t.clientX, t.clientY);
      if (el && el.classList.contains('tbtn')) continue;
      if (t.clientX > innerWidth * 0.45 && look.id === -1) {
        look.id = t.identifier; look.lx = t.clientX; look.ly = t.clientY;
      }
    }
  }, { passive: true });
  $('btn-fire').addEventListener('touchstart', e => { firing = true; e.preventDefault(); }, { passive: false });
  $('btn-fire').addEventListener('touchend', e => { firing = false; e.preventDefault(); }, { passive: false });
  $('btn-jump').addEventListener('touchstart', e => { held.add('jump'); e.preventDefault(); }, { passive: false });
  $('btn-jump').addEventListener('touchend', e => { held.delete('jump'); e.preventDefault(); }, { passive: false });
  $('btn-reload').addEventListener('touchstart', e => { send({ t: 'r' }); e.preventDefault(); }, { passive: false });
  $('btn-nade').addEventListener('touchstart', e => { throwNade(); e.preventDefault(); }, { passive: false });
  $('btn-swap').addEventListener('touchstart', e => { switchTo(mySlot === 0 ? 1 : 0); e.preventDefault(); }, { passive: false });
  $('btn-ads').addEventListener('touchstart', e => { ads = true; e.preventDefault(); }, { passive: false });
  $('btn-ads').addEventListener('touchend', e => { ads = false; e.preventDefault(); }, { passive: false });
}

// gamepad
let padNadeLatch = false, padAds = false;
function pollGamepad() {
  padAds = false;
  for (const gp of navigator.getGamepads?.() ?? []) {
    if (!gp) continue;
    const dead = v => Math.abs(v) > 0.18 ? v : 0;
    stick.gx = dead(gp.axes[0] || 0);
    stick.gz = -dead(gp.axes[1] || 0);
    const ls = 1 - 0.45 * adsT;
    me.yaw -= dead(gp.axes[2] || 0) * 0.045 * ls;
    me.pitch = Math.max(-1.55, Math.min(1.55, me.pitch - dead(gp.axes[3] || 0) * 0.035 * ls));
    firing = firing || (gp.buttons[7]?.pressed ?? false);
    padAds = padAds || (gp.buttons[6]?.pressed ?? false); // left trigger = ADS
    if (gp.buttons[0]?.pressed) held.add('jump'); else if (!isTouch) held.delete('jump');
    if (gp.buttons[2]?.pressed) send({ t: 'r' });
    if (gp.buttons[5]?.pressed && !padNadeLatch) { padNadeLatch = true; throwNade(); }
    else if (!gp.buttons[5]?.pressed) padNadeLatch = false;
    // Y / triangle swaps weapons
    if (gp.buttons[3]?.pressed && !padSwapLatch) { padSwapLatch = true; switchTo(mySlot === 0 ? 1 : 0); }
    else if (!gp.buttons[3]?.pressed) padSwapLatch = false;
    if (gp.buttons[10]?.pressed) held.add('sprint');
    if (gp.buttons[1]?.pressed) held.add('crouch'); else if (!isTouch) held.delete('crouch');
  }
}

// --- local prediction + fire ------------------------------------------------
let lastFireAt = 0, semiLatch = false, lastInputSend = 0;
const _inp = { mx: 0, mz: 0 }; // reused: this is read twice per frame
function inputVector() {
  let mx = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
  let mz = (held.has('fwd') ? 1 : 0) - (held.has('back') ? 1 : 0);
  mx += stick.mx || 0; mz += stick.mz || 0;
  mx += stick.gx || 0; mz += stick.gz || 0;
  _inp.mx = Math.max(-1, Math.min(1, mx));
  _inp.mz = Math.max(-1, Math.min(1, mz));
  return _inp;
}

function step(dt) {
  pollGamepad();
  if (!joined || !me.alive) return;
  const { mx, mz } = inputVector();
  const l = Math.hypot(mx, mz);
  // Sampled BEFORE the horizontal move and with the server's exact tolerance:
  // the server decides "grounded" at the pre-move position, so testing the
  // post-move one denies jumps the server grants and diverges by metres.
  const grounded = me.y <= groundHeightAt(me.x, me.z, world) + 1e-4;
  if (l > 0.01) {
    const nx = mx / Math.max(1, l), nz = mz / Math.max(1, l);
    const sin = Math.sin(me.yaw), cos = Math.cos(me.yaw);
    const wx = nx * cos - nz * sin;
    const wz = -nx * sin - nz * cos;
    const sp = held.has('crouch') ? CROUCH_SPEED : (held.has('sprint') ? SPRINT : WALK);
    me.x += wx * sp * dt;
    me.z += wz * sp * dt;
  }
  // vertical: the surface underfoot is 0 or the platform we are standing over.
  // Walking off an edge just leaves me.y above the new ground, so gravity takes
  // over on the next line instead of the player being dropped instantly.
  let gh = groundHeightAt(me.x, me.z, world);
  if (held.has('jump') && grounded) me.vy = JUMP_V;
  if (me.y > gh || me.vy > 0) {
    me.vy += GRAV * dt;
    me.y += me.vy * dt;
    if (me.y <= gh) { me.y = gh; me.vy = 0; }
  } else if (me.y !== gh) {
    me.y = gh; me.vy = 0;
  }
  for (const b of world.obstacles) {
    if (me.y > b.h - 0.2) continue;
    const nx = Math.max(b.x1, Math.min(me.x, b.x2));
    const nz = Math.max(b.z1, Math.min(me.z, b.z2));
    const dx = me.x - nx, dz = me.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 < PLAYER_R * PLAYER_R && d2 > 1e-9) {
      const dist = Math.sqrt(d2);
      me.x = nx + (dx / dist) * PLAYER_R;
      me.z = nz + (dz / dist) * PLAYER_R;
    } else if (d2 <= 1e-9) {
      // inside the box: same nearest-face escape the server uses, or prediction
      // and the server disagree by the width of whatever we are stuck in
      const dw = me.x - b.x1, de = b.x2 - me.x, dn = me.z - b.z1, ds = b.z2 - me.z;
      const mn = Math.min(dw, de, dn, ds);
      if (mn === dw) me.x = b.x1 - PLAYER_R;
      else if (mn === de) me.x = b.x2 + PLAYER_R;
      else if (mn === dn) me.z = b.z1 - PLAYER_R;
      else me.z = b.z2 + PLAYER_R;
    }
  }
  const S = world.size;
  me.x = Math.max(-S + 0.6, Math.min(S - 0.6, me.x));
  me.z = Math.max(-S + 0.6, Math.min(S - 0.6, me.z));
  // collision may have pushed us over a deck edge: settle onto whatever is
  // under the final position rather than hovering until the next tick
  gh = groundHeightAt(me.x, me.z, world);
  if (me.y < gh) { me.y = gh; me.vy = 0; }

  // send input at 20 Hz
  const now = performance.now();
  if (now - lastInputSend > 50) {
    lastInputSend = now;
    send({ t: 'i', mx, mz, sp: held.has('sprint'), jp: held.has('jump'),
           cr: held.has('crouch'), yaw: me.yaw, pitch: me.pitch });
  }

  // firing
  const w = WEAPONS[me.weapon];
  if (firing && !me.reloading && me.mag > 0 && (w.auto || !semiLatch)) {
    if (now - lastFireAt >= 60000 / w.rpm) {
      lastFireAt = now; semiLatch = true;
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      send({ t: 'f', d: [dir.x, dir.y, dir.z] });
      play(me.weapon === 'shotgun' ? 'shotgun' : 'rifle', 1);
      // own tracer from just below the eye so it reads as leaving the barrel
      addTracer(new THREE.Vector3(me.x, me.y + EYE - 0.12, me.z)
        .addScaledVector(dir, 0.8), dir);
      localImpact(dir.x, dir.y, dir.z);
      vmRecoil = 1;
      if (vmFlash) {
        vmFlash.visible = true; vmFlashLight.intensity = 7;
        setTimeout(() => { if (vmFlash) { vmFlash.visible = false; vmFlashLight.intensity = 0; } }, 45);
      }
      if (me.mag > 0) me.mag--; // optimistic; server value overwrites
    }
  }
  if (!firing) semiLatch = false;
}

// --- remote entities -----------------------------------------------------------
const CORPSE_MS = 5000, TOPPLE_MS = 500;
const remoteSeen = new Set(); // reused every frame
function ensureRemote(id, name, hp, team) {
  let r = remotes.get(id);
  if (r) return r;
  r = {
    id, group: new THREE.Group(), body: new THREE.Group(),
    nameSprite: null, avatarInst: null, mixer: null, action: null,
    tplKey: '', epoch: -1, handBone: null,
    gunHolder: null, gunWeapon: '', gunModelled: false, muzzle: null,
    flashUntil: 0,
    animSpeed: 0, crouchT: 0, phase: (id * 1.7) % 6.283,
    alive: hp > 0, deadAt: 0, corpseY: 0,
    toppleDir: (id % 2) ? 1 : -1,
  };
  r.group.add(r.body);
  r.team = team;
  r.nameSprite = makeNameSprite(name, team);
  r.group.add(r.nameSprite);
  attachAvatar(r);
  scene.add(r.group);
  remotes.set(id, r);
  return r;
}

// permanent, so the scene's point-light count never changes at runtime
const remoteFlash = new THREE.PointLight(0xffaa44, 0, 6);
remoteFlash.position.set(0, -50, 0);
scene.add(remoteFlash);
function updateRemotes(dt, now) {
  if (!snapB) return;
  let flashBest = 0;
  const renderAt = now - INTERP_DELAY;
  const [A, B] = snapA && snapA.at < snapB.at ? [snapA, snapB] : [snapB, snapB];
  const span = Math.max(1, B.at - A.at);
  const t = Math.max(0, Math.min(1, (renderAt - A.at) / span));
  remoteSeen.clear();
  for (const rowB of B.m.p) {
    const id = rowB[0];
    if (id === myId) continue;
    remoteSeen.add(id);
    let rowA = rowB;
    for (let i = 0; i < A.m.p.length; i++) if (A.m.p[i][0] === id) { rowA = A.m.p[i]; break; }
    const r = ensureRemote(id, rowB[12], rowB[6], rowB[15]);
    if (r.epoch !== avatarEpoch) {          // a model finished loading since last check
      r.epoch = avatarEpoch;
      const want = pickAvatarTpl(id);
      if ((want ? want.key : 'capsule') !== r.tplKey) attachAvatar(r);
    }

    const x = rowA[1] + (rowB[1] - rowA[1]) * t;
    const y = rowA[2] + (rowB[2] - rowA[2]) * t;
    const z = rowA[3] + (rowB[3] - rowA[3]) * t;
    const hp = rowB[6];
    const flags = rowB[14] | 0;
    const alive = hp > 0;

    if (!alive && r.alive) { r.alive = false; r.deadAt = now; r.corpseY = y; }
    else if (alive && !r.alive) { r.alive = true; r.deadAt = 0; r.nameSprite.visible = true; }

    let topple = 0;
    if (alive) {
      r.group.visible = true;
      r.group.position.set(x, y, z);
    } else {
      const age = now - r.deadAt;
      r.group.visible = age < CORPSE_MS;
      r.nameSprite.visible = false;
      // bodies never hang in the air: drop the corpse as it topples, but onto
      // the surface it died on — clamping to 0 buries it inside a deck
      r.corpseY = Math.max(groundHeightAt(x, z, world), r.corpseY - dt * 7);
      r.group.position.set(x, r.corpseY, z);
      const k = Math.min(1, age / TOPPLE_MS);
      topple = r.toppleDir * (Math.PI / 2) * k * k;
    }
    if (!r.group.visible) continue;

    let ya = rowA[4], yb = rowB[4];
    if (yb - ya > Math.PI) ya += Math.PI * 2; else if (ya - yb > Math.PI) yb += Math.PI * 2;
    r.group.rotation.y = ya + (yb - ya) * t + Math.PI;

    // animation state: smoothed so it can't pop between 20 Hz snapshots
    const spTarget = alive ? Math.max(0, Math.min(1, rowB[13] || 0)) : 0;
    r.animSpeed += (spTarget - r.animSpeed) * Math.min(1, dt * 7);
    const crouching = alive && (flags & 2) !== 0;
    r.crouchT += ((crouching ? 1 : 0) - r.crouchT) * Math.min(1, dt * 9);
    const airborne = alive && (flags & 8) !== 0;

    const breathe = alive
      ? Math.sin(now * 0.0016 + r.phase) * 0.014 * (1 - Math.min(1, r.animSpeed * 5))
      : 0;
    r.body.position.y = -0.26 * r.crouchT + breathe;
    r.body.rotation.x = 0.2 * r.crouchT + topple;

    if (r.mixer && alive && !airborne) {          // airborne freezes the pose
      r.mixer.update(dt * (0.14 + r.animSpeed * 2.4) * (1 - 0.35 * r.crouchT));
    }

    // weapon in hand (rebuilds on weapon change and on late GLB arrival)
    const wname = rowB[9];
    if (r.gunWeapon !== wname || r.gunModelled !== !!gunModels[wname]) buildRemoteGun(r, wname);
    if (r.handBone && r.gunHolder) {
      // world orientation of the gun := torso orientation, flipped to face +Z
      r.handBone.getWorldQuaternion(_q1);
      r.body.getWorldQuaternion(_q2);
      r.gunHolder.quaternion.copy(_q1.invert()).multiply(_q2).multiply(_qGunFlip);
    }
    if (r.muzzle) r.muzzle.visible = now < r.flashUntil;
    // one shared muzzle light, parked on whoever fired most recently: a light
    // per remote would make the scene's light count churn as players join and
    // leave, recompiling every lit material each time
    if (now < r.flashUntil && r.flashUntil > flashBest) {
      flashBest = r.flashUntil;
      remoteFlash.position.set(x, y + 1.5, z);
    }
  }
  remoteFlash.intensity = flashBest > now ? 6 : 0;
  for (const [id, r] of remotes) {
    if (!remoteSeen.has(id)) { scene.remove(r.group); remotes.delete(id); }
  }
}

// --- HUD -------------------------------------------------------------------------
let feedItems = [];
function feed(text, mine) {
  feedItems.push({ text, mine, at: Date.now() });
  if (feedItems.length > 6) feedItems.shift();
  $('killfeed').innerHTML = feedItems
    .map(f => `<div class="${f.mine ? 'me' : ''}">${f.text}</div>`).join('');
}
setInterval(() => {
  const cut = Date.now() - 7000;
  const n = feedItems.length;
  feedItems = feedItems.filter(f => f.at > cut);
  if (feedItems.length !== n) {
    $('killfeed').innerHTML = feedItems
      .map(f => `<div class="${f.mine ? 'me' : ''}">${f.text}</div>`).join('');
  }
}, 1000);

// red wedge at screen center pointing toward whoever shot you
let dmgDirT = null;
function showDamageDir(shooter) {
  const el = $('dmgdir');
  const ang = Math.atan2(shooter.x - me.x, -(shooter.z - me.z)) - (-me.yaw);
  el.style.transform = `translate(-50%,-50%) rotate(${(-ang) * 180 / Math.PI}deg)`;
  el.style.opacity = 0.9;
  clearTimeout(dmgDirT);
  dmgDirT = setTimeout(() => { el.style.opacity = 0; }, 650);
}

// --- floating damage numbers (pooled DOM nodes) ------------------------------
const DMG_MAX = 12, DMG_LIFE = 950;
const dmgLayer = $('dmgnums');
const dmgPool = [];
let dmgRR = 0;
function showDamageNumber(victimId, x, y, z, dmg, head) {
  const now = performance.now();
  // shotgun pellets arrive as 8 separate hits in one snapshot — merge them
  for (let i = 0; i < dmgPool.length; i++) {
    const d = dmgPool[i];
    if (d.active && d.vid === victimId && now - d.born < 260) {
      d.amt += dmg; d.head = d.head || head; d.born = now; d.t0 = now;
      d.x = x; d.y = y; d.z = z;
      d.el.textContent = d.amt;
      d.el.className = d.head ? 'dmgnum head' : 'dmgnum';
      return;
    }
  }
  let d = null;
  for (let i = 0; i < dmgPool.length; i++) if (!dmgPool[i].active) { d = dmgPool[i]; break; }
  if (!d) {
    if (dmgPool.length < DMG_MAX) {
      const el = document.createElement('div');
      el.className = 'dmgnum';
      dmgLayer.appendChild(el);
      d = { el, active: false, vid: 0, amt: 0, head: false, t0: 0, born: 0, x: 0, y: 0, z: 0 };
      dmgPool.push(d);
    } else {
      d = dmgPool[dmgRR++ % DMG_MAX]; // recycle oldest slot
    }
  }
  d.active = true; d.vid = victimId; d.amt = dmg; d.head = head;
  d.t0 = now; d.born = now; d.x = x; d.y = y; d.z = z;
  d.el.textContent = dmg;
  d.el.className = head ? 'dmgnum head' : 'dmgnum';
  d.el.style.display = 'block';
}
function updateDamageNumbers(now) {
  for (let i = 0; i < dmgPool.length; i++) {
    const d = dmgPool[i];
    if (!d.active) continue;
    const age = (now - d.t0) / DMG_LIFE;
    if (age >= 1) { d.active = false; d.el.style.display = 'none'; continue; }
    _v1.set(d.x, d.y + age * 0.9, d.z).project(camera);
    if (_v1.z > 1) { d.el.style.display = 'none'; continue; }
    d.el.style.display = 'block';
    d.el.style.transform = 'translate(-50%,-50%) translate(' +
      ((_v1.x * 0.5 + 0.5) * innerWidth).toFixed(0) + 'px,' +
      ((-_v1.y * 0.5 + 0.5) * innerHeight).toFixed(0) + 'px)';
    d.el.style.opacity = (1 - age * age).toFixed(2);
  }
}

// --- dynamic crosshair --------------------------------------------------------
const chEl = $('crosshair');
let chGap = 5, chShown = -1;
function updateCrosshair(dt, moveAmt) {
  let target = 3.5 + moveAmt * 7 + vmRecoil * 9;
  if (held.has('sprint') && moveAmt > 0.1) target += 4;
  if (held.has('crouch')) target -= 1.8;
  target *= 1 - 0.55 * adsT;
  chGap += (Math.max(1, target) - chGap) * Math.min(1, dt * 14);
  if (Math.abs(chGap - chShown) > 0.25) {
    chShown = chGap;
    chEl.style.setProperty('--g', chGap.toFixed(1) + 'px');
  }
}

// --- low health: pulsing vignette + heartbeat --------------------------------
const lowEl = $('lowhp');
let lowOn = false, nextThump = 0;
function updateLowHealth(now) {
  const low = me.alive && me.hp > 0 && me.hp < 35;
  if (low !== lowOn) {
    lowOn = low;
    lowEl.classList.toggle('on', low);
    if (low) nextThump = now; // thump immediately on crossing the line
  }
  if (!low || !actx || now < nextThump) return;
  const f = Math.max(0, Math.min(1, me.hp / 35));
  nextThump = now + 520 + f * 540;
  synthHeartbeat(0.55 + (1 - f) * 0.4);
}

let hitT = null;
function hitmarker() {
  $('hitmarker').style.opacity = 1;
  clearTimeout(hitT);
  hitT = setTimeout(() => { $('hitmarker').style.opacity = 0; }, 90);
}
function damageFlash() {
  const v = $('damage-vignette');
  v.style.transition = 'none'; v.style.opacity = 0.9;
  requestAnimationFrame(() => { v.style.transition = 'opacity .6s'; v.style.opacity = Math.max(0, 1 - me.hp / 100) * 0.5; });
}
let bannerT = { c: null, s: null };
function banner(el, text, ms) {
  const key = el.id === 'center-banner' ? 'c' : 's';
  el.textContent = text;
  el.style.opacity = text ? 1 : 0;
  clearTimeout(bannerT[key]);
  if (text && ms > 0) bannerT[key] = setTimeout(() => { el.style.opacity = 0; }, ms);
}

let lastHpSeen = 100;
function updateHUD(m) {
  // healing has to clear the damage vignette too, not just taking a hit
  if (me.hp > lastHpSeen) {
    $('damage-vignette').style.opacity = Math.max(0, 1 - me.hp / 100) * 0.5;
  }
  lastHpSeen = me.hp;
  $('hp-fill').style.width = Math.max(0, me.hp) + '%';
  $('hp-fill').style.background = me.hp > 50 ? '#7da05a' : (me.hp > 25 ? '#a08a3a' : '#a04a3a');
  $('hp-label').textContent = `${STR.hp} ${Math.max(0, me.hp)}`;
  const stowedName = STR.weaponNames[myStowed] || myStowed;
  $('weapon-name').innerHTML =
    (STR.weaponNames[me.weapon] || me.weapon) +
    `<span style="color:#6a6a60"> / ${stowedName} [Q]</span>`;
  $('ammo').querySelector('.mag').textContent = me.reloading ? '···' : me.mag;
  $('reload-hint').style.visibility = (!me.reloading && me.mag === 0) ? 'visible' : 'hidden';
  $('reload-hint').textContent = STR.reload;

  if (m.ts) {
    $('t0').textContent = `${teamNames[0]} ${m.ts[0]}`;
    $('t1').textContent = `${m.ts[1]} ${teamNames[1]}`;
  }
  const rows = [...m.p].sort((a, b) => b[7] - a[7]);
  const top = rows[0];
  $('score-strip').textContent =
    `${me.kills} ${STR.kills} / ${me.deaths} ${STR.deaths}   ·   ` +
    (top ? `TOP: ${top[12]} ${top[7]}/${killTarget}` : '') +
    (rows.length === 1 ? `   ·   ${STR.waiting}` : '');

  if (!me.alive && me.hp <= 0) {
    const myRow = m.p.find(r => r[0] === myId);
    if (myRow) banner($('sub-banner'), fmt(STR.respawnIn, { n: Math.ceil(3) }), 900);
  }
  if (m.ph === 'over') {
    banner($('sub-banner'), fmt(STR.newMatchIn, { n: Math.ceil(m.endsIn / 1000) }), 900);
  }

  // scoreboard
  const sb = $('scoreboard');
  if (held.has('score')) {
    sb.style.display = 'block';
    sb.innerHTML = `<table><tr><th>${STR.enterName}</th><th>${STR.kills}</th><th>${STR.deaths}</th><th>${STR.hp}</th></tr>` +
      rows.map(r =>
        `<tr class="${r[0] === myId ? 'me' : ''}"><td>${r[12]}</td><td>${r[7]}</td><td>${r[8]}</td><td>${r[6]}</td></tr>`
      ).join('') + '</table>';
  } else {
    sb.style.display = 'none';
  }
}

// --- main loop ----------------------------------------------------------------
// Never pause the sim — this is online PvP and the server keeps running.
// Blur only drops inputs so an unfocused window doesn't walk into fire.
const STEP = 1 / 60;
let acc = 0, last = performance.now();
addEventListener('blur', () => { held.clear(); firing = false; ads = false; });
addEventListener('focus', () => { last = performance.now(); });
const devEl = $('dev');
const showDev = devFlag;
if (showDev) devEl.style.display = 'block';
let frames = 0, fpsAt = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000; last = now;
  dt = Math.min(dt, 0.1);
  acc += dt;
  while (acc >= STEP) { step(STEP); acc -= STEP; }

  updateRemotes(dt, now);
  updateTracers(now);
  updatePuffs(dt);
  updateMissiles(dt, now);
  // rotor + tail spin, and a jet that banks slightly as it runs
  for (const h of airPool.heli) {
    if (!h.visible) continue;
    h.userData.rotor.rotation.y += dt * 26;
    h.userData.tail.rotation.x += dt * 34;
  }
  for (const j of airPool.jet) { if (j.visible) j.rotation.z = Math.sin(now / 900) * 0.12; }
  updateLowHealth(now);
  for (const sp of cloudSprites) {
    sp.position.x += sp.userData.drift * dt;
    if (sp.position.x > 650) sp.position.x = -650;
  }

  // pickup spin
  const t = now / 1000;
  for (const mesh of pickupMeshes.values()) {
    if (mesh.visible) {
      mesh.rotation.y = t * 1.4;
      mesh.position.y = mesh.userData.baseY + Math.sin(t * 2) * 0.15;
    }
  }

  // aim-down-sights / sprint field of view (only touch the projection on change)
  const moving = inputVector();
  const moveAmt = Math.min(1, Math.hypot(moving.mx, moving.mz));
  const adsWant = (ads || padAds) && me.alive && joined ? 1 : 0;
  adsT += (adsWant - adsT) * Math.min(1, dt * 13);
  const sprintWant = (held.has('sprint') && moveAmt > 0.15 && !adsWant) ? 1 : 0;
  sprintT += (sprintWant - sprintT) * Math.min(1, dt * 6);
  const fovWant = FOV_BASE + (FOV_ADS - FOV_BASE) * adsT +
    (FOV_SPRINT - FOV_BASE) * sprintT * (1 - adsT);
  if (Math.abs(fovWant - camera.fov) > 0.02) { camera.fov = fovWant; camera.updateProjectionMatrix(); }
  updateCrosshair(dt, moveAmt);

  // camera (+ crouch dip, explosion shake)
  const eyeTarget = held.has('crouch') ? 1.1 : EYE;
  me.eye += (eyeTarget - me.eye) * Math.min(1, dt * 12);
  camera.position.set(me.x, me.y + me.eye, me.z);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(me.yaw);
  camera.rotateX(me.pitch);
  if (shakeT > 0) {
    shakeT = Math.max(0, shakeT - dt);
    camera.position.x += (Math.random() - 0.5) * shakeT * 0.3;
    camera.position.y += (Math.random() - 0.5) * shakeT * 0.3;
    camera.rotateZ((Math.random() - 0.5) * shakeT * 0.05);
  }
  if (!me.alive) camera.position.y = me.y + 0.5;

  drawMinimap(now);
  updateDamageNumbers(now); // after the camera moves, so they project cleanly

  // viewmodel recoil/bob, easing toward screen centre while aiming
  vmRecoil = Math.max(0, vmRecoil - dt * 7);
  const bob = Math.sin(now / 90) * 0.008 * (moveAmt > 0.1 ? 2 : 0.6) * (1 - 0.8 * adsT);
  // ADS slides the gun to centre and lifts its sight line onto the crosshair,
  // from the weapon's own offset so every gun frames it the same way.
  const gt = GUN_TUNE[me.weapon] || GUN_TUNE.rifle;
  const ga = gt.ads || ADS_FALLBACK;
  vmHolder.position.set(
    0.3 + (ga[0] - 0.3) * adsT,
    -0.3 + (ga[1] + 0.3) * adsT + bob,
    -0.62 + (ga[2] + 0.62) * adsT + vmRecoil * 0.07);
  vmHolder.rotation.x = vmRecoil * 0.08 + (gt.adsRot || 0) * adsT;

  renderer.render(scene, camera);
  if (showDev && (frames++, now - fpsAt >= 500)) {
    devEl.textContent = Math.round(frames * 1000 / (now - fpsAt)) + ' fps · ' +
      renderer.info.render.calls + ' draws';
    frames = 0; fpsAt = now;
  }
}
requestAnimationFrame(frame);

// kick off networking (after all module-level state above is initialized)
$('js-note').textContent = fmt(STR.killTargetInfo, { n: killTarget }) + ' · ' + STR.padNote;
connect();

// debug handle (also used by the automated netcode tests)
window.__dzpvp = {
  me, remotes, world, scene, camera, renderer, GUN_TUNE,
  get ws() { return ws; }, get snap() { return snapB; },
  get fov() { return camera.fov; }, get adsT() { return adsT; },
  get decals() { return decalIdx; },
  get draws() { return renderer.info.render.calls; },
  get missiles() { return missiles.length; },
  get air() { return { heli: airPool.heli.filter(h => h.visible).length,
                       jet: airPool.jet.filter(j => j.visible).length }; },
  launchMissile() { launchMissile(performance.now()); },
  groundAt(x, z) { return groundHeightAt(x, z, world); },
  setFiring(v) { firing = v; },
  setAds(v) { ads = v; },
  hold(cmd, on) { on ? held.add(cmd) : held.delete(cmd); },
  vm(w) { buildViewmodel(w); },
  // live ADS tuning: __dzpvp.adsTune('longshot', 0, -0.09, -0.6, 0.1)
  adsTune(w, x, y, z, rot) {
    const t = GUN_TUNE[w];
    if (!t) return null;
    t.ads = [x, y, z];
    t.adsRot = rot || 0;
    return t.ads;
  },
};
