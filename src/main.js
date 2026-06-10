// DEADZONE — round-based FPS zombie survival.
// Wires together world, player, weapons, horde, gore, audio and HUD.
import * as THREE from 'three';
import { World } from './world.js';
import { GoreSystem } from './gore.js';
import { Horde } from './zombies.js';
import { Arsenal, WEAPON_DEFS, UPGRADE_COST } from './weapons.js';
import { Player } from './player.js';
import { HUD } from './hud.js';
import { initAudio, resumeAudio, sfx } from './audio.js';
import { textSprite } from './textures.js';

// ------------------------------------------------------------ renderer/scene
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
scene.fog = new THREE.FogExp2(0x05060a, 0.045);

const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 120);
scene.add(camera); // viewmodel hangs off the camera

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------- systems
const hud = new HUD();
const world = new World(scene);
const gore = new GoreSystem(scene);
const horde = new Horde(scene, world, gore);
const player = new Player(camera, canvas);

const game = {
  points: 500,
  totalPoints: 500,
  kills: 0,
  state: 'menu', // menu | playing | paused | dead
  hud, gore, horde,
  get playerMoving() { return player.moving; },
  addPoints(n) {
    this.points += n;
    if (n > 0) this.totalPoints += n;
    hud.setPoints(this.points);
    hud.pointPop(n);
  },
  spend(n) {
    this.points -= n;
    hud.setPoints(this.points);
    hud.pointPop(-n);
  },
  onZombieKilled() { this.kills++; },
};

const arsenal = new Arsenal(camera, scene, game);

horde.onRoundChange = r => hud.setRound(r);
horde.onAttackPlayer = dmg => {
  player.takeDamage(dmg);
  hud.setHealth(player.health, true);
};
player.onDamaged = h => hud.setHealth(h, false);

// ------------------------------------------------------------- interactables
const interactables = [];

// doors
for (const [name, door] of Object.entries(world.doors)) {
  const center = door.mesh.position;
  interactables.push({
    pos: new THREE.Vector3(center.x, center.y, center.z),
    radius: 2.6,
    label: () => `<span class="key">[F]</span> Open ${door.destination} — ${door.cost}`,
    active: () => !door.open,
    use() {
      if (game.points < door.cost) { sfx.denied(); hud.announce('NOT ENOUGH POINTS', 1200); return; }
      game.spend(door.cost);
      world.openDoor(name);
      sfx.doorOpen();
      hud.announce(`${door.destination} OPENED`, 2000);
    },
  });
}

// wall-buy guns
for (const spot of world.wallBuySpots) {
  const def = WEAPON_DEFS[spot.weapon];
  // chalk-outline style wall gun
  const outline = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xcccccc, wireframe: true });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9 * def.size, 0.18 * def.size, 0.06), mat);
  outline.add(body);
  const handleMesh = new THREE.Mesh(new THREE.BoxGeometry(0.14 * def.size, 0.3 * def.size, 0.06), mat);
  handleMesh.position.set(0.25 * def.size, -0.2 * def.size, 0);
  outline.add(handleMesh);
  outline.position.copy(spot.pos);
  outline.rotation.y = spot.ry;
  scene.add(outline);
  const label = textSprite([def.name, `${def.cost}`]);
  label.position.copy(spot.pos).y += 0.85;
  scene.add(label);

  interactables.push({
    pos: spot.pos.clone(),
    radius: 2.3,
    active: () => true,
    label: () => {
      const owned = arsenal.slots.find(w => w.id === spot.weapon);
      return owned
        ? `<span class="key">[F]</span> Refill ${def.name} ammo — ${Math.floor(def.cost / 2)}`
        : `<span class="key">[F]</span> Buy ${def.name} — ${def.cost}`;
    },
    use() {
      const res = arsenal.buyOrRefill(spot.weapon, game.points);
      if (!res.ok) { sfx.denied(); hud.announce('NOT ENOUGH POINTS', 1200); return; }
      game.spend(res.cost);
    },
  });
}

// upgrade bench
interactables.push({
  pos: world.upgradeBenchPos.clone(),
  radius: 2.4,
  active: () => true,
  label: () => arsenal.weapon.upgraded
    ? `${arsenal.weapon.name} is already upgraded`
    : `<span class="key">[F]</span> Upgrade ${arsenal.weapon.name} — ${UPGRADE_COST}`,
  use() {
    const res = arsenal.upgradeCurrent(game.points);
    if (res.already) { sfx.denied(); return; }
    if (!res.ok) { sfx.denied(); hud.announce('NOT ENOUGH POINTS', 1200); return; }
    game.spend(res.cost);
    hud.announce('WEAPON UPGRADED', 2200);
  },
});

let nearbyInteractable = null;
function updateInteractables() {
  nearbyInteractable = null;
  const eye = new THREE.Vector3(player.position.x, player.position.y + 1.4, player.position.z);
  let bestD = Infinity;
  for (const it of interactables) {
    if (!it.active()) continue;
    const d = eye.distanceTo(it.pos);
    if (d < it.radius && d < bestD) { bestD = d; nearbyInteractable = it; }
  }
  hud.prompt(nearbyInteractable ? nearbyInteractable.label() : null);
}

// --------------------------------------------------------------------- input
document.addEventListener('mousedown', e => {
  if (game.state !== 'playing' || e.button !== 0) return;
  arsenal.triggerHeld = true;
});
document.addEventListener('mouseup', e => {
  if (e.button === 0) arsenal.triggerHeld = false;
});
document.addEventListener('keydown', e => {
  if (game.state !== 'playing') return;
  if (e.code === 'KeyR') arsenal.reload();
  if (e.code === 'KeyF' && nearbyInteractable) nearbyInteractable.use();
  if (e.code === 'Digit1') arsenal.switchSlot(0);
  if (e.code === 'Digit2') arsenal.switchSlot(1);
});

function lockPointer() {
  canvas.requestPointerLock();
}
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (!locked && game.state === 'playing') {
    game.state = 'paused';
    hud.showPaused(true);
    arsenal.triggerHeld = false;
  } else if (locked && game.state === 'paused') {
    game.state = 'playing';
    hud.showPaused(false);
  }
});

document.getElementById('start-btn').addEventListener('click', () => {
  initAudio();
  resumeAudio();
  hud.showStart(false);
  game.state = 'playing';
  lockPointer();
});
document.getElementById('resume-btn').addEventListener('click', () => {
  resumeAudio();
  hud.showPaused(false);
  game.state = 'playing';
  lockPointer();
});
document.getElementById('restart-btn').addEventListener('click', () => {
  restart();
});

function restart() {
  hudShownGameOver = false;
  horde.reset();
  player.reset();
  arsenal.reset();
  game.points = 500;
  game.totalPoints = 500;
  game.kills = 0;
  game.state = 'playing';
  hud.setPoints(game.points);
  hud.setHealth(100, false);
  hud.hideGameOver();
  // doors that were opened stay open for the next run; reload the page
  // for a completely fresh map
  lockPointer();
}

// ----------------------------------------------------------------- game loop
let deathTimer = 0;
let hudShownGameOver = false;
const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  world.update(t);

  if (game.state === 'playing') {
    player.update(dt, world.colliders);
    arsenal.update(dt);
    horde.update(dt, player.position);
    gore.update(dt);
    updateInteractables();

    if (player.dead) {
      game.state = 'dead';
      deathTimer = 1.6;
      arsenal.triggerHeld = false;
      hud.prompt(null);
    }
  } else if (game.state === 'dead') {
    player.update(dt, world.colliders); // death cam slump
    gore.update(dt);
    deathTimer -= dt;
    if (deathTimer <= 0 && !hudShownGameOver) {
      hudShownGameOver = true;
      document.exitPointerLock();
      hud.showGameOver({ round: horde.round, kills: game.kills, totalPoints: game.totalPoints });
    }
  }

  renderer.render(scene, camera);
}

// console debug handle
window.__dz = { game, horde, player, world, arsenal };

// initial HUD state
hud.setPoints(game.points);
hud.setHealth(100, false);
tick();
