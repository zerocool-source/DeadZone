// Map construction: geometry, collision, zones, doors, zombie spawn points
// and the waypoint graph zombies use to chase the player between floors.
//
// Layout (top-down):
//                 [ UPPER FLOOR  y=3.2 ]
//   GROUND ROOM ==stairs up==>
//   (y=0)
//     ||
//   stairs down
//     ||
//   [ BASEMENT y=-3.2 ]
import * as THREE from 'three';
import { concreteTexture, brickTexture, woodTexture, textSprite } from './textures.js';

export const ZONES = {
  GROUND:   { id: 'GROUND',   floorY: 0 },
  CORR_A:   { id: 'CORR_A' },                 // stairs up   x:10..16, ramp 0 -> 3.2
  UPPER:    { id: 'UPPER',    floorY: 3.2 },
  CORR_B:   { id: 'CORR_B' },                 // stairs down z:7..13,  ramp 0 -> -3.2
  BASEMENT: { id: 'BASEMENT', floorY: -3.2 },
};

export function zoneAt(x, z) {
  if (x >= -10 && x <= 10 && z >= -7 && z <= 7) return 'GROUND';
  if (x > 10 && x <= 16 && z >= -2 && z <= 2) return 'CORR_A';
  if (x > 16 && x <= 30 && z >= -6 && z <= 6) return 'UPPER';
  if (z > 7 && z <= 13 && x >= -2 && x <= 2) return 'CORR_B';
  if (z > 13 && z <= 25 && x >= -8 && x <= 8) return 'BASEMENT';
  return 'GROUND';
}

export function groundHeightAt(x, z) {
  switch (zoneAt(x, z)) {
    case 'CORR_A': return 3.2 * THREE.MathUtils.clamp((x - 10) / 6, 0, 1);
    case 'UPPER': return 3.2;
    case 'CORR_B': return -3.2 * THREE.MathUtils.clamp((z - 7) / 6, 0, 1);
    case 'BASEMENT': return -3.2;
    default: return 0;
  }
}

// ---------------------------------------------------------------- collision
export class Collider {
  constructor(minX, maxX, minY, maxY, minZ, maxZ) {
    Object.assign(this, { minX, maxX, minY, maxY, minZ, maxZ });
    this.enabled = true;
  }
}

// Push a vertical capsule (circle in XZ between feetY..feetY+height) out of colliders.
export function resolveCollisions(pos, radius, feetY, height, colliders) {
  for (const c of colliders) {
    if (!c.enabled) continue;
    if (feetY + height < c.minY || feetY > c.maxY) continue;
    const nx = THREE.MathUtils.clamp(pos.x, c.minX, c.maxX);
    const nz = THREE.MathUtils.clamp(pos.z, c.minZ, c.maxZ);
    const dx = pos.x - nx, dz = pos.z - nz;
    const distSq = dx * dx + dz * dz;
    if (distSq >= radius * radius) continue;
    if (distSq > 1e-9) {
      const dist = Math.sqrt(distSq);
      pos.x = nx + (dx / dist) * radius;
      pos.z = nz + (dz / dist) * radius;
    } else {
      // center inside the box: push out along the shallowest axis
      const pushLeft = pos.x - c.minX + radius, pushRight = c.maxX - pos.x + radius;
      const pushBack = pos.z - c.minZ + radius, pushFront = c.maxZ - pos.z + radius;
      const m = Math.min(pushLeft, pushRight, pushBack, pushFront);
      if (m === pushLeft) pos.x = c.minX - radius;
      else if (m === pushRight) pos.x = c.maxX + radius;
      else if (m === pushBack) pos.z = c.minZ - radius;
      else pos.z = c.maxZ + radius;
    }
  }
}

// ------------------------------------------------------------ waypoint graph
// Nodes zombies route through when the player is in a different zone.
const NODES = {
  g:  { x: 0,    z: 0,    zone: 'GROUND' },
  ga: { x: 8.5,  z: 0,    zone: 'GROUND' },
  a1: { x: 13,   z: 0,    zone: 'CORR_A' },
  u1: { x: 18,   z: 0,    zone: 'UPPER' },
  u2: { x: 23,   z: 0,    zone: 'UPPER' },
  gb: { x: 0,    z: 5,    zone: 'GROUND' },
  b1: { x: 0,    z: 10,   zone: 'CORR_B' },
  bm: { x: 0,    z: 15,   zone: 'BASEMENT' },
  b2: { x: 0,    z: 19,   zone: 'BASEMENT' },
};
// edge -> required door (null = always open)
const EDGES = [
  ['g', 'ga', null], ['g', 'gb', null],
  ['ga', 'a1', 'doorA'], ['a1', 'u1', null], ['u1', 'u2', null],
  ['gb', 'b1', 'doorB'], ['b1', 'bm', null], ['bm', 'b2', null],
];

export class World {
  constructor(scene) {
    this.scene = scene;
    this.colliders = [];
    this.doors = {};            // name -> { collider, mesh, label, cost, open }
    this.spawnPoints = { GROUND: [], UPPER: [], BASEMENT: [] };
    this.wallBuySpots = [];     // filled below, consumed by weapons module
    this.upgradeBenchPos = null;
    this.flickerLights = [];
    this._build(scene);
  }

  // nearest graph node to a position
  _nearestNode(pos) {
    let best = null, bestD = Infinity;
    for (const [name, n] of Object.entries(NODES)) {
      const d = (pos.x - n.x) ** 2 + (pos.z - n.z) ** 2;
      if (d < bestD) { bestD = d; best = name; }
    }
    return best;
  }

  // Next position a zombie should walk toward to reach the player.
  // Returns null if it should just steer directly at the player.
  nextWaypoint(zombiePos, playerPos) {
    const zZone = zoneAt(zombiePos.x, zombiePos.z);
    const pZone = zoneAt(playerPos.x, playerPos.z);
    if (zZone === pZone) return null;
    const start = this._nearestNode(zombiePos);
    const goal = this._nearestNode(playerPos);
    // BFS over open edges
    const prev = { [start]: start };
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === goal) break;
      for (const [a, b, door] of EDGES) {
        if (door && !this.doors[door].open) continue;
        const next = a === cur ? b : (b === cur ? a : null);
        if (next && !(next in prev)) { prev[next] = cur; queue.push(next); }
      }
    }
    if (!(goal in prev)) return null; // unreachable; just push toward player
    // walk back from goal to find the first step after start
    let step = goal;
    while (prev[step] !== start) {
      step = prev[step];
      if (step === start) break;
    }
    const n = NODES[step === start ? goal : step];
    return new THREE.Vector3(n.x, groundHeightAt(n.x, n.z), n.z);
  }

  openDoor(name) {
    const door = this.doors[name];
    if (!door || door.open) return;
    door.open = true;
    door.collider.enabled = false;
    this.scene.remove(door.mesh);
    if (door.label) this.scene.remove(door.label);
  }

  update(time) {
    for (const l of this.flickerLights) {
      l.light.intensity = l.base * (0.82 + 0.18 * Math.sin(time * l.speed + l.phase) * Math.sin(time * l.speed * 2.7));
    }
  }

  // ------------------------------------------------------------- build
  _build(scene) {
    const concrete = new THREE.MeshStandardMaterial({ map: concreteTexture(6, 6), roughness: 0.95 });
    const concreteDark = new THREE.MeshStandardMaterial({ map: concreteTexture(6, 6, '#35353a'), roughness: 0.95 });
    const brick = new THREE.MeshStandardMaterial({ map: brickTexture(5, 2), roughness: 0.9 });
    const wood = new THREE.MeshStandardMaterial({ map: woodTexture(5, 5), roughness: 0.85 });

    const box = (mat, x1, y1, z1, x2, y2, z2, { collide = true } = {}) => {
      const w = x2 - x1, h = y2 - y1, d = z2 - z1;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      if (collide) {
        const c = new Collider(x1, x2, y1, y2, z1, z2);
        this.colliders.push(c);
        return { mesh, collider: c };
      }
      return { mesh };
    };

    // ---- floors (visual; physics uses groundHeightAt)
    box(wood, -10, -0.3, -7, 10, 0, 7, { collide: false });                  // ground room
    box(concrete, 16, 2.9, -6, 30, 3.2, 6, { collide: false });              // upper room
    box(concreteDark, -8, -3.5, 13, 8, -3.2, 25, { collide: false });        // basement
    // stair ramps (visual)
    const rampA = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(6, 3.2), 0.3, 4), concrete);
    rampA.position.set(13, 1.6 - 0.15, 0);
    rampA.rotation.z = Math.atan2(3.2, 6);
    rampA.receiveShadow = true;
    scene.add(rampA);
    const rampB = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, Math.hypot(6, 3.2)), concreteDark);
    rampB.position.set(0, -1.6 - 0.15, 10);
    rampB.rotation.x = -Math.atan2(3.2, 6);
    rampB.receiveShadow = true;
    scene.add(rampB);

    // ---- ceilings (visual only)
    box(concrete, -10, 4, -7, 10, 4.3, 7, { collide: false });
    box(concrete, 10, 4.8, -2, 16, 5.1, 2, { collide: false });
    box(concrete, 16, 7.2, -6, 30, 7.5, 6, { collide: false });
    box(concrete, -2, 2.6, 7, 2, 2.9, 13, { collide: false });
    box(concreteDark, -8, 0.8, 13, 8, 1.1, 25, { collide: false });

    // ---- ground room walls (door gaps: east z -2..2, south x -2..2)
    box(brick, -10, 0, -7.4, 10, 4, -7);                    // north
    box(brick, -10, 0, 7, -2, 4, 7.4);                      // south-west seg
    box(brick, 2, 0, 7, 10, 4, 7.4);                        // south-east seg
    box(brick, -10.4, 0, -7.4, -10, 4, 7.4);                // west
    box(brick, 10, 0, -7.4, 10.4, 4, -2);                   // east seg
    box(brick, 10, 0, 2, 10.4, 4, 7.4);                     // east seg

    // ---- stairwell A (up) side walls
    box(concrete, 10, -0.2, -2.4, 16.4, 5.2, -2);
    box(concrete, 10, -0.2, 2, 16.4, 5.2, 2.4);

    // ---- upper room walls (west gap z -2..2 where the stairs arrive)
    box(brick, 15.6, 3.2, -6, 16, 7.2, -2);
    box(brick, 15.6, 3.2, 2, 16, 7.2, 6);
    box(brick, 30, 3.2, -6.4, 30.4, 7.2, 6.4);
    box(brick, 16, 3.2, -6.4, 30, 7.2, -6);
    box(brick, 16, 3.2, 6, 30, 7.2, 6.4);

    // ---- stairwell B (down) side walls
    box(concrete, -2.4, -3.6, 7, -2, 3, 13.4);
    box(concrete, 2, -3.6, 7, 2.4, 3, 13.4);

    // ---- basement walls (north gap x -2..2 where the stairs arrive)
    box(concreteDark, -8, -3.2, 12.6, -2, 0.8, 13);
    box(concreteDark, 2, -3.2, 12.6, 8, 0.8, 13);
    box(concreteDark, -8, -3.2, 25, 8, 0.8, 25.4);
    box(concreteDark, -8.4, -3.2, 12.6, -8, 0.8, 25.4);
    box(concreteDark, 8, -3.2, 12.6, 8.4, 0.8, 25.4);

    // ---- boarded windows (visual + zombie spawn points)
    const windows = [
      { x: -5,  y: 0,    z: -7,   ry: 0,           zone: 'GROUND' },
      { x: 5,   y: 0,    z: -7,   ry: 0,           zone: 'GROUND' },
      { x: -10, y: 0,    z: 3,    ry: Math.PI / 2, zone: 'GROUND' },
      { x: 17.5,y: 3.2,  z: -6,   ry: 0,           zone: 'UPPER' },
      { x: 30,  y: 3.2,  z: 0,    ry: -Math.PI / 2, zone: 'UPPER' },
      { x: 26,  y: 3.2,  z: 6,    ry: Math.PI,     zone: 'UPPER' },
      { x: -8,  y: -3.2, z: 17,   ry: Math.PI / 2, zone: 'BASEMENT' },
      { x: 8,   y: -3.2, z: 21,   ry: -Math.PI / 2, zone: 'BASEMENT' },
      { x: 3,   y: -3.2, z: 25,   ry: Math.PI,     zone: 'BASEMENT' },
    ];
    const boardMat = new THREE.MeshStandardMaterial({ map: woodTexture(1, 1), roughness: 1 });
    const holeMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
    for (const w of windows) {
      const grp = new THREE.Group();
      grp.position.set(w.x, w.y, w.z);
      grp.rotation.y = w.ry;
      const hole = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.6), holeMat);
      hole.position.set(0, 1.7, 0.05);
      grp.add(hole);
      for (let i = 0; i < 4; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.22, 0.06), boardMat);
        b.position.set(0, 1.05 + i * 0.42, 0.12);
        b.rotation.z = (Math.random() - 0.5) * 0.25;
        grp.add(b);
      }
      scene.add(grp);
      // spawn just inside the room, facing inward
      const inward = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), w.ry);
      const p = new THREE.Vector3(w.x, w.y, w.z).addScaledVector(inward, 0.9);
      this.spawnPoints[w.zone].push(p);
    }

    // ---- doors (buyable)
    this._makeDoor('doorA', wood, 10, 0, -2, 10.4, 3.2, 2, 750, 'UPSTAIRS');
    this._makeDoor('doorB', wood, -2, 0, 7, 2, 3.2, 7.4, 1250, 'BASEMENT');

    // ---- wall-buy spots (consumed by the weapons module)
    this.wallBuySpots = [
      { weapon: 'kompakt9', pos: new THREE.Vector3(-9.7, 1.6, -3),  ry: Math.PI / 2 },
      { weapon: 'riot12',   pos: new THREE.Vector3(0, 1.6, -6.7),   ry: 0 },
      { weapon: 'longshot', pos: new THREE.Vector3(29.7, 4.8, 0),   ry: -Math.PI / 2 },
      { weapon: 'hellfang', pos: new THREE.Vector3(-7.7, -1.6, 20), ry: Math.PI / 2 },
    ];

    // ---- upgrade bench (basement)
    const bench = new THREE.Group();
    const benchTop = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.18, 1.1),
      new THREE.MeshStandardMaterial({ color: 0x222230, metalness: 0.7, roughness: 0.4 }));
    benchTop.position.y = 1.0;
    bench.add(benchTop);
    for (const [lx, lz] of [[-1, -0.45], [1, -0.45], [-1, 0.45], [1, 0.45]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x111118, metalness: 0.6 }));
      leg.position.set(lx, 0.5, lz);
      bench.add(leg);
    }
    const glow = new THREE.PointLight(0x9d4edd, 6, 7);
    glow.position.y = 1.6;
    bench.add(glow);
    const benchLabel = textSprite(['UPGRADE BENCH', '5000'], { color: '#c77dff' });
    benchLabel.position.y = 2.4;
    bench.add(benchLabel);
    bench.position.set(5, -3.2, 22);
    scene.add(bench);
    this.colliders.push(new Collider(3.9, 6.1, -3.2, -2.1, 21.45, 22.55));
    this.upgradeBenchPos = new THREE.Vector3(5, -3.2, 22);

    // ---- lighting
    scene.add(new THREE.AmbientLight(0x404048, 0.55));
    const hemi = new THREE.HemisphereLight(0x404055, 0x201510, 0.4);
    scene.add(hemi);
    const addFlicker = (x, y, z, color = 0xffd9a0, base = 14, dist = 16) => {
      const light = new THREE.PointLight(color, base, dist, 1.6);
      light.position.set(x, y, z);
      scene.add(light);
      // bare-bulb visual
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8),
        new THREE.MeshBasicMaterial({ color }));
      bulb.position.set(x, y, z);
      scene.add(bulb);
      this.flickerLights.push({ light, base, speed: 6 + Math.random() * 8, phase: Math.random() * 10 });
    };
    addFlicker(-5, 3.6, 0);
    addFlicker(5, 3.6, 0);
    addFlicker(13, 4.4, 0, 0xffc080, 8, 10);
    addFlicker(20, 6.8, 0);
    addFlicker(26, 6.8, 0);
    addFlicker(0, 2.2, 10, 0xffc080, 7, 9);
    addFlicker(-3, 0.4, 18, 0x88ff99, 10, 13);   // sickly green basement light
    addFlicker(4, 0.4, 22, 0x88ff99, 10, 13);
  }

  _makeDoor(name, mat, x1, y1, z1, x2, y2, z2, cost, destination) {
    const w = x2 - x1, h = y2 - y1, d = z2 - z1;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    const collider = new Collider(x1, x2, y1, y2, z1, z2);
    this.colliders.push(collider);
    const label = textSprite([`${destination}`, `OPEN - ${cost}`]);
    label.position.set((x1 + x2) / 2, y2 + 0.5, (z1 + z2) / 2);
    this.scene.add(label);
    this.doors[name] = { mesh, collider, label, cost, open: false, destination };
  }
}
