// DeadZone: Wasteland PvP — client. Renders snapshots from the
// authoritative server, predicts the local player, and turns input
// (keyboard+mouse / touch / gamepad) into command messages.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { buildWorld } from './world.js';
import { STR } from './strings.js';

// --- constants (mirror server.js; server is authoritative) ---------------
const WALK = 5.2, SPRINT = 7.6, GRAV = -22, JUMP_V = 7.5, PLAYER_R = 0.45;
const WEAPONS = {
  rifle:    { rpm: 540, mag: 30, auto: true,  vmSize: 1.0 },
  shotgun:  { rpm: 85,  mag: 6,  auto: false, vmSize: 1.15 },
  longshot: { rpm: 45,  mag: 5,  auto: false, vmSize: 1.3 },
};
const EYE = 1.55;
const INTERP_DELAY = 120; // ms behind live for remote interpolation

// FORMULA palette
const COL = {
  sky: 0x8a8474, fog: 0x8a8474, ground: 0x5c5a50, groundVar: 0x51544a,
  wall: 0x62625e, ruin: 0x6a675f, container: 0x6e4a33, rubble: 0x585650,
  rock: 0x4f4f4b, accent: 0x57e389, skin: 0xb8b3a2, cloth: 0x3a3d35,
};

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

// --- renderer / scene ------------------------------------------------------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
const scene = new THREE.Scene();
scene.background = new THREE.Color(COL.sky);
scene.fog = new THREE.FogExp2(COL.fog, 0.011);
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400);
scene.add(camera);
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); addEventListener('orientationchange', resize); resize();

scene.add(new THREE.HemisphereLight(0xb0a890, 0x3a382e, 0.9));
const sun = new THREE.DirectionalLight(0xd8cdb0, 1.4);
sun.position.set(40, 80, 20);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x8a8478, 0.35));

// --- world geometry ---------------------------------------------------------
const world = buildWorld();
{
  // ground: vertex-jittered color patches
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
  const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  scene.add(ground);

  // obstacles: one InstancedMesh per kind (one draw call each)
  const byKind = {};
  for (const b of world.obstacles) (byKind[b.kind] ??= []).push(b);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const m4 = new THREE.Matrix4();
  for (const [kind, list] of Object.entries(byKind)) {
    const mat = new THREE.MeshLambertMaterial({ color: COL[kind] ?? 0x666660, flatShading: true });
    const inst = new THREE.InstancedMesh(box, mat, list.length);
    list.forEach((b, i) => {
      m4.makeScale(b.x2 - b.x1, b.h, b.z2 - b.z1);
      m4.setPosition((b.x1 + b.x2) / 2, b.h / 2, (b.z1 + b.z2) / 2);
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
  }

  // decorative dead trees (visual only, placed clear of obstacles)
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

// pickup markers
const pickupMeshes = new Map();
for (const pk of world.pickups) {
  const grp = new THREE.Group();
  const isHealth = pk.type === 'health';
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.7),
    new THREE.MeshLambertMaterial({ color: isHealth ? 0x3d5a3d : 0x44483c, flatShading: true }));
  grp.add(body);
  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(0.78, 0.16, 0.78),
    new THREE.MeshBasicMaterial({ color: COL.accent }));
  glow.position.y = 0;
  grp.add(glow);
  const light = new THREE.PointLight(COL.accent, 4, 6);
  light.position.y = 1;
  grp.add(light);
  grp.position.set(pk.x, 1.0, pk.z);
  scene.add(grp);
  pickupMeshes.set(pk.id, grp);
}

// --- player avatar template (reused DeadZone walker GLB) --------------------
let avatarTpl = null;
new GLTFLoader().load('./assets/models/player.glb', gltf => {
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const scale = 2.35 / (box.max.y - box.min.y);
  gltf.scene.traverse(n => { if (n.isMesh || n.isSkinnedMesh) { n.castShadow = false; n.frustumCulled = false; } });
  avatarTpl = { scene: gltf.scene, clip: gltf.animations[0] || null, scale, yOff: -box.min.y * scale };
  for (const r of remotes.values()) if (!r.model) attachAvatar(r);
}, undefined, () => { /* fallback capsule avatars */ });

function makeNameSprite(name) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 56;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 30px monospace'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(0, 0, 256, 56);
  ctx.fillStyle = '#cfe0b0'; ctx.fillText(name.toUpperCase(), 128, 38);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(1.9, 0.42, 1);
  sp.position.y = 2.25;
  return sp;
}

function attachAvatar(r) {
  if (avatarTpl) {
    const inst = cloneSkeleton(avatarTpl.scene);
    inst.scale.setScalar(avatarTpl.scale);
    inst.position.y = avatarTpl.yOff;
    r.group.add(inst);
    if (avatarTpl.clip) {
      r.mixer = new THREE.AnimationMixer(inst);
      r.action = r.mixer.clipAction(avatarTpl.clip);
      r.action.play();
      r.mixer.update(Math.random() * avatarTpl.clip.duration);
    }
  } else {
    const cap = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 8),
      new THREE.MeshLambertMaterial({ color: COL.skin, flatShading: true }));
    cap.position.y = 0.9;
    r.group.add(cap);
  }
  r.model = true;
}

// --- viewmodel ---------------------------------------------------------------
const vmHolder = new THREE.Group();
vmHolder.position.set(0.3, -0.3, -0.62);
camera.add(vmHolder);
let vmFlash, vmFlashLight, vmRecoil = 0;
function buildViewmodel(weapon) {
  vmHolder.clear();
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
const SOUNDS = ['rifle', 'shotgun', 'hit', 'death', 'pickup'];
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
  if (sndBufs.music) {
    const src = actx.createBufferSource();
    src.buffer = sndBufs.music; src.loop = true;
    const g = actx.createGain(); g.gain.value = 0.16;
    src.connect(g); g.connect(master); src.start();
  }
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

// --- net ----------------------------------------------------------------------
const room = new URLSearchParams(location.search).get('room') ||
  Math.random().toString(36).slice(2, 7);
history.replaceState(null, '', `?room=${room}`);
const inviteURL = location.origin + location.pathname + '?room=' + room;
$('invite').innerHTML =
  `<div>${STR.invite}</div><input readonly value="${inviteURL}"><button id="copy-btn">${STR.copy}</button>`;
$('copy-btn').addEventListener('click', () => {
  navigator.clipboard?.writeText(inviteURL);
  $('copy-btn').textContent = STR.copied;
  setTimeout(() => { $('copy-btn').textContent = STR.copy; }, 1200);
});

let ws = null, myId = 0, killTarget = 15, joined = false, wantJoin = false;
let snapA = null, snapB = null; // last two snapshots for interpolation
const remotes = new Map();      // id -> remote entity
const me = { x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0, hp: 100, mag: 30, weapon: 'rifle', reloading: false, alive: true, kills: 0, deaths: 0 };
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
    banner($('sub-banner'), '', 0);
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
    if (me.weapon !== weapon) { me.weapon = weapon; buildViewmodel(weapon); }
    if (wasAlive && !me.alive) onLocalDeath();
    if (!wasAlive && me.alive) { me.x = sx; me.y = sy; me.z = sz; }
    // reconciliation: snap if server disagrees hard
    if (me.alive && Math.hypot(sx - me.x, sz - me.z) > 2.5) { me.x = sx; me.y = sy; me.z = sz; }
  }

  // pickups
  for (const [id, active] of m.pk) {
    const mesh = pickupMeshes.get(id);
    if (mesh) mesh.visible = !!active;
  }

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
      if (pos) play(b === 'shotgun' ? 'shotgun' : 'rifle', 0.8, pos);
      const r = remotes.get(a);
      if (r) r.flashUntil = performance.now() + 60;
    }
  } else if (kind === 'hit') {
    if (a === myId) { hitmarker(); play('hit', 0.7); }
    if (b === myId) { damageFlash(); play('hit', 1); }
  } else if (kind === 'kill') {
    feed(fmt(STR.feedKilled, { a: nameOf(m, a), b: nameOf(m, b) }), a === myId || b === myId);
    const pos = posOf(m, b);
    if (pos) play('death', 0.9, pos);
    if (b === myId) {
      banner($('center-banner'), STR.youDied, 2600);
      banner($('sub-banner'), fmt(STR.killedBy, { name: nameOf(m, a) }), 2600);
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
  ShiftLeft: 'sprint', ShiftRight: 'sprint', Space: 'jump', KeyR: 'reload', Tab: 'score',
};
addEventListener('keydown', e => {
  const cmd = BIND[e.code];
  if (!cmd) return;
  e.preventDefault();
  if (cmd === 'reload') send({ t: 'r' });
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
addEventListener('mousedown', e => {
  if (e.button !== 0 || $('join-screen').offsetParent) return;
  if (!isTouch && document.pointerLockElement !== canvas && !lockFailed) { tryLock(); return; }
  firing = true;
});
addEventListener('mouseup', e => { if (e.button === 0) firing = false; });
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas) return;
  me.yaw -= e.movementX * 0.0022;
  me.pitch = Math.max(-1.55, Math.min(1.55, me.pitch - e.movementY * 0.0022));
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
}

// gamepad
function pollGamepad() {
  for (const gp of navigator.getGamepads?.() ?? []) {
    if (!gp) continue;
    const dead = v => Math.abs(v) > 0.18 ? v : 0;
    stick.gx = dead(gp.axes[0] || 0);
    stick.gz = -dead(gp.axes[1] || 0);
    me.yaw -= dead(gp.axes[2] || 0) * 0.045;
    me.pitch = Math.max(-1.55, Math.min(1.55, me.pitch - dead(gp.axes[3] || 0) * 0.035));
    firing = firing || (gp.buttons[7]?.pressed ?? false);
    if (gp.buttons[0]?.pressed) held.add('jump'); else if (!isTouch) held.delete('jump');
    if (gp.buttons[2]?.pressed) send({ t: 'r' });
    if (gp.buttons[10]?.pressed) held.add('sprint');
  }
}

// --- local prediction + fire ------------------------------------------------
let lastFireAt = 0, semiLatch = false, lastInputSend = 0;
function inputVector() {
  let mx = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
  let mz = (held.has('fwd') ? 1 : 0) - (held.has('back') ? 1 : 0);
  mx += stick.mx || 0; mz += stick.mz || 0;
  mx += stick.gx || 0; mz += stick.gz || 0;
  return { mx: Math.max(-1, Math.min(1, mx)), mz: Math.max(-1, Math.min(1, mz)) };
}

function step(dt) {
  pollGamepad();
  if (!joined || !me.alive) return;
  const { mx, mz } = inputVector();
  const l = Math.hypot(mx, mz);
  if (l > 0.01) {
    const nx = mx / Math.max(1, l), nz = mz / Math.max(1, l);
    const sin = Math.sin(me.yaw), cos = Math.cos(me.yaw);
    const wx = nx * cos - nz * sin;
    const wz = -nx * sin - nz * cos;
    const sp = held.has('sprint') ? SPRINT : WALK;
    me.x += wx * sp * dt;
    me.z += wz * sp * dt;
  }
  if (held.has('jump') && me.y === 0) me.vy = JUMP_V;
  if (me.y > 0 || me.vy > 0) {
    me.vy += GRAV * dt;
    me.y = Math.max(0, me.y + me.vy * dt);
    if (me.y === 0) me.vy = 0;
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
    }
  }
  const S = world.size;
  me.x = Math.max(-S + 0.6, Math.min(S - 0.6, me.x));
  me.z = Math.max(-S + 0.6, Math.min(S - 0.6, me.z));

  // send input at 20 Hz
  const now = performance.now();
  if (now - lastInputSend > 50) {
    lastInputSend = now;
    send({ t: 'i', mx, mz, sp: held.has('sprint'), jp: held.has('jump'), yaw: me.yaw, pitch: me.pitch });
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
function ensureRemote(id, name) {
  let r = remotes.get(id);
  if (!r) {
    r = { group: new THREE.Group(), mixer: null, action: null, model: false, flashUntil: 0, lastX: 0, lastZ: 0, speed: 0 };
    r.group.add(makeNameSprite(name));
    const flash = new THREE.PointLight(0xffaa44, 0, 6);
    flash.position.y = 1.5;
    r.group.add(flash);
    r.flashLight = flash;
    attachAvatar(r);
    scene.add(r.group);
    remotes.set(id, r);
  }
  return r;
}

function updateRemotes(dt) {
  if (!snapB) return;
  const renderAt = performance.now() - INTERP_DELAY;
  const [A, B] = snapA && snapA.at < snapB.at ? [snapA, snapB] : [snapB, snapB];
  const span = Math.max(1, B.at - A.at);
  const t = Math.max(0, Math.min(1, (renderAt - A.at) / span));
  const seen = new Set();
  for (const rowB of B.m.p) {
    const id = rowB[0];
    if (id === myId) continue;
    seen.add(id);
    const rowA = A.m.p.find(r => r[0] === id) || rowB;
    const r = ensureRemote(id, rowB[12]);
    const x = rowA[1] + (rowB[1] - rowA[1]) * t;
    const y = rowA[2] + (rowB[2] - rowA[2]) * t;
    const z = rowA[3] + (rowB[3] - rowA[3]) * t;
    const hp = rowB[6];
    r.group.visible = hp > 0;
    const dx = x - r.lastX, dz = z - r.lastZ;
    r.speed = r.speed * 0.8 + (Math.hypot(dx, dz) / Math.max(dt, 0.001)) * 0.2;
    r.lastX = x; r.lastZ = z;
    r.group.position.set(x, y, z);
    let ya = rowA[4], yb = rowB[4];
    if (yb - ya > Math.PI) ya += Math.PI * 2; else if (ya - yb > Math.PI) yb += Math.PI * 2;
    r.group.rotation.y = ya + (yb - ya) * t + Math.PI;
    if (r.mixer && hp > 0) {
      r.mixer.update(dt * Math.max(0.25, Math.min(2.2, r.speed / 2.2)));
    }
    r.flashLight.intensity = performance.now() < r.flashUntil ? 6 : 0;
  }
  for (const [id, r] of remotes) {
    if (!seen.has(id)) { scene.remove(r.group); remotes.delete(id); }
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

function updateHUD(m) {
  $('hp-fill').style.width = Math.max(0, me.hp) + '%';
  $('hp-fill').style.background = me.hp > 50 ? '#7da05a' : (me.hp > 25 ? '#a08a3a' : '#a04a3a');
  $('hp-label').textContent = `${STR.hp} ${Math.max(0, me.hp)}`;
  $('weapon-name').textContent = STR.weaponNames[me.weapon] || me.weapon;
  $('ammo').querySelector('.mag').textContent = me.reloading ? '···' : me.mag;
  $('reload-hint').style.visibility = (!me.reloading && me.mag === 0) ? 'visible' : 'hidden';
  $('reload-hint').textContent = STR.reload;

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
addEventListener('blur', () => { held.clear(); firing = false; });
addEventListener('focus', () => { last = performance.now(); });
const devEl = $('dev');
const showDev = new URLSearchParams(location.search).has('dev');
if (showDev) devEl.style.display = 'block';
let frames = 0, fpsAt = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000; last = now;
  dt = Math.min(dt, 0.1);
  acc += dt;
  while (acc >= STEP) { step(STEP); acc -= STEP; }

  updateRemotes(dt);

  // pickup spin
  const t = now / 1000;
  for (const mesh of pickupMeshes.values()) {
    if (mesh.visible) { mesh.rotation.y = t * 1.4; mesh.position.y = 1 + Math.sin(t * 2) * 0.15; }
  }

  // camera
  camera.position.set(me.x, me.y + EYE, me.z);
  camera.rotation.set(0, 0, 0);
  camera.rotateY(me.yaw);
  camera.rotateX(me.pitch);
  if (!me.alive) camera.position.y = me.y + 0.5;

  // viewmodel recoil/bob
  vmRecoil = Math.max(0, vmRecoil - dt * 7);
  const moving = inputVector();
  const bob = Math.sin(now / 90) * 0.008 * (Math.hypot(moving.mx, moving.mz) > 0.1 ? 2 : 0.6);
  vmHolder.position.set(0.3, -0.3 + bob, -0.62 + vmRecoil * 0.07);
  vmHolder.rotation.x = vmRecoil * 0.08;

  renderer.render(scene, camera);
  if (showDev && (frames++, now - fpsAt >= 500)) {
    devEl.textContent = Math.round(frames * 1000 / (now - fpsAt)) + ' fps · ' +
      renderer.info.render.calls + ' draws';
    frames = 0; fpsAt = now;
  }
}
requestAnimationFrame(frame);

// kick off networking (after all module-level state above is initialized)
$('js-note').textContent = fmt(STR.killTargetInfo, { n: killTarget });
connect();

// debug handle (also used by the automated netcode tests)
window.__dzpvp = {
  me, remotes, world,
  get ws() { return ws; }, get snap() { return snapB; },
  setFiring(v) { firing = v; },
  hold(cmd, on) { on ? held.add(cmd) : held.delete(cmd); },
};
