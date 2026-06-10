// Zombies: procedural placeholder models (swappable for GLB assets later),
// chase AI with cross-floor waypoint routing, and the round-based horde
// manager that scales health/speed/count per round.
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { groundHeightAt, resolveCollisions, zoneAt } from './world.js';
import { zombieModels } from './assets.js';
import { sfx } from './audio.js';

const ZOMBIE_RADIUS = 0.38;
const ATTACK_RANGE = 1.45;
const ATTACK_DAMAGE = 22;
const ATTACK_COOLDOWN = 1.1;

const skinMats = [
  new THREE.MeshStandardMaterial({ color: 0x59683a, roughness: 0.95 }),
  new THREE.MeshStandardMaterial({ color: 0x6b7a4a, roughness: 0.95 }),
  new THREE.MeshStandardMaterial({ color: 0x4a5e3e, roughness: 0.95 }),
];
const clothMats = [
  new THREE.MeshStandardMaterial({ color: 0x3a2f28, roughness: 1 }),
  new THREE.MeshStandardMaterial({ color: 0x2f3338, roughness: 1 }),
  new THREE.MeshStandardMaterial({ color: 0x40302f, roughness: 1 }),
];
const gashMat = new THREE.MeshStandardMaterial({ color: 0x6e0505, roughness: 0.8 });

let nextId = 1;

export class Zombie {
  constructor(scene, spawnPos, { health, speed, runner = false }) {
    this.id = nextId++;
    this.scene = scene;
    this.health = health;
    this.maxHealth = health;
    this.speed = speed;
    this.state = 'spawning';
    this.spawnTimer = 1.1;
    this.attackTimer = 0;
    this.groanTimer = 1 + Math.random() * 5;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.deadTimer = 0;
    this.hitMeshes = [];
    this.mixer = null;
    this.headBone = null;

    const g = new THREE.Group();
    const model = runner ? (zombieModels.runner || zombieModels.walker) : zombieModels.walker;
    if (model) this._buildFromModel(g, model);
    else this._buildProcedural(g);

    g.position.copy(spawnPos);
    g.position.y = groundHeightAt(spawnPos.x, spawnPos.z) - 1.8; // rises out of the floor
    scene.add(g);
    this.group = g;
  }

  // Skinned GLB body (assets/models/) with invisible hitboxes for shooting.
  _buildFromModel(g, model) {
    const inst = cloneSkeleton(model.scene);
    inst.scale.setScalar(model.scale);
    inst.position.y = model.yOffset;
    g.add(inst);
    if (model.clip) {
      this.mixer = new THREE.AnimationMixer(inst);
      this.mixer.clipAction(model.clip).play();
      this.mixer.update(Math.random() * model.clip.duration); // desync the horde
    }
    inst.traverse(n => { if (!this.headBone && n.isBone && /head/i.test(n.name)) this.headBone = n; });

    // raycast against simple boxes, not the high-poly skinned mesh
    const invisMat = new THREE.MeshBasicMaterial();
    invisMat.visible = false;
    const bodyBox = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.15, 0.45), invisMat);
    bodyBox.position.y = 0.95;
    bodyBox.userData = { zombie: this, part: 'body' };
    g.add(bodyBox);
    this.hitMeshes.push(bodyBox);

    const headBox = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.34, 0.32), invisMat);
    headBox.userData = { zombie: this, part: 'head' };
    if (this.headBone) {
      g.updateMatrixWorld(true);
      const ws = new THREE.Vector3();
      this.headBone.getWorldScale(ws);
      headBox.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z); // undo rig scale
      this.headBone.add(headBox);
    } else {
      headBox.position.y = 1.62;
      g.add(headBox);
    }
    this.hitMeshes.push(headBox);
  }

  // Procedural box body — used until models load (or if files are missing).
  _buildProcedural(g) {
    const skin = skinMats[(Math.random() * skinMats.length) | 0];
    const cloth = clothMats[(Math.random() * clothMats.length) | 0];
    const part = (geom, mat, x, y, z, name) => {
      const m = new THREE.Mesh(geom, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.userData = { zombie: this, part: name };
      g.add(m);
      this.hitMeshes.push(m);
      return m;
    };

    this.torso = part(new THREE.BoxGeometry(0.52, 0.62, 0.3), cloth, 0, 1.22, 0, 'body');
    this.head = part(new THREE.BoxGeometry(0.3, 0.32, 0.3), skin, 0, 1.72, 0, 'head');
    // gory chest gash
    const gash = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.05), gashMat);
    gash.position.set(0.08, -0.05, 0.16);
    gash.rotation.z = 0.4;
    this.torso.add(gash);
    // eyes
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffdd55 });
    for (const ex of [-0.07, 0.07]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.02), eyeMat);
      eye.position.set(ex, 0.03, 0.16);
      this.head.add(eye);
    }
    // limbs pivot at the shoulder/hip so they swing naturally
    const limb = (w, len, mat, x, y, name) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, w), mat);
      m.position.y = -len / 2;
      m.castShadow = true;
      m.userData = { zombie: this, part: name };
      pivot.add(m);
      g.add(pivot);
      this.hitMeshes.push(m);
      return pivot;
    };
    this.armL = limb(0.14, 0.6, skin, -0.34, 1.46, 'body');
    this.armR = limb(0.14, 0.6, skin, 0.34, 1.46, 'body');
    this.legL = limb(0.17, 0.9, cloth, -0.15, 0.92, 'body');
    this.legR = limb(0.17, 0.9, cloth, 0.15, 0.92, 'body');
    // classic zombie arms-out pose
    this.armL.rotation.x = -Math.PI / 2.3;
    this.armR.rotation.x = -Math.PI / 2.3;
  }

  takeDamage(amount, isHead) {
    if (this.state === 'dead') return false;
    this.health -= amount * (isHead ? 2.5 : 1);
    return this.health <= 0;
  }

  die(gore, hitDir, headshot) {
    this.state = 'dead';
    this.deadTimer = 3.5;
    const p = this.group.position;
    const chest = new THREE.Vector3(p.x, p.y + 1.2, p.z);
    gore.burst(chest, headshot ? 55 : 35);
    gore.spawnGibs(chest, headshot ? 8 : 4, headshot ? 7 : 4.5);
    gore.splatFloor(p.x, p.z, 1.4);
    if (headshot) {
      if (this.headBone) this.headBone.scale.setScalar(0.0001); // pop the head
      else if (this.head) this.head.visible = false;
      const neck = new THREE.Vector3(p.x, p.y + 1.65, p.z);
      gore.spray(neck, new THREE.Vector3(0, 1, 0), 30, 7);
      sfx.headPop();
    }
    // fall over in the direction of the shot
    this._fallDir = Math.atan2(hitDir.x, hitDir.z);
  }

  update(dt, playerPos, world, gore, onAttackPlayer, zombies) {
    const g = this.group;
    const floor = groundHeightAt(g.position.x, g.position.z);

    if (this.state === 'dead') {
      this.deadTimer -= dt;
      // topple
      const target = Math.PI / 2;
      g.rotation.x = Math.min(target, g.rotation.x + dt * 5);
      if (g.rotation.x >= target * 0.97 && !this._splatted) {
        this._splatted = true;
        gore.splatFloor(g.position.x, g.position.z, 1.6);
      }
      if (this.deadTimer < 1) {
        g.position.y = floor - (1 - this.deadTimer) * 2; // sink into the ground
      }
      return this.deadTimer <= 0; // true = remove me
    }

    // skinned walk clip drives the body; playback speed follows move speed
    if (this.mixer) this.mixer.update(dt * THREE.MathUtils.clamp(this.speed / 1.3, 0.5, 2.2));

    if (this.state === 'spawning') {
      this.spawnTimer -= dt;
      g.position.y = floor - 1.8 * Math.max(0, this.spawnTimer / 1.1);
      if (this.spawnTimer <= 0) {
        this.state = 'chase';
        g.position.y = floor;
      }
      return false;
    }

    // ----- chase / attack
    this.groanTimer -= dt;
    if (this.groanTimer <= 0) {
      this.groanTimer = 3 + Math.random() * 7;
      const distToPlayer = g.position.distanceTo(playerPos);
      if (distToPlayer < 22) sfx.zombieGroan();
    }

    const toPlayer = new THREE.Vector3().subVectors(playerPos, g.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();

    this.attackTimer -= dt;
    if (dist < ATTACK_RANGE && Math.abs(playerPos.y - g.position.y) < 1.6) {
      // swipe
      if (this.attackTimer <= 0) {
        this.attackTimer = ATTACK_COOLDOWN;
        sfx.zombieAttack();
        onAttackPlayer(ATTACK_DAMAGE);
        this._swing = 0.32;
      }
    } else {
      // steer toward waypoint (different zone) or directly at the player
      const wp = world.nextWaypoint(g.position, playerPos);
      const target = wp || playerPos;
      const dir = new THREE.Vector3().subVectors(target, g.position);
      dir.y = 0;
      if (dir.lengthSq() > 0.001) {
        dir.normalize();
        g.position.addScaledVector(dir, this.speed * dt);
      }
    }

    // separation from other zombies
    for (const other of zombies) {
      if (other === this || other.state === 'dead') continue;
      const dx = g.position.x - other.group.position.x;
      const dz = g.position.z - other.group.position.z;
      const dSq = dx * dx + dz * dz;
      const minD = ZOMBIE_RADIUS * 2;
      if (dSq > 0.0001 && dSq < minD * minD) {
        const d = Math.sqrt(dSq);
        const push = (minD - d) * 0.5;
        g.position.x += (dx / d) * push;
        g.position.z += (dz / d) * push;
      }
    }

    resolveCollisions(g.position, ZOMBIE_RADIUS, g.position.y, 1.8, world.colliders);
    g.position.y = groundHeightAt(g.position.x, g.position.z);

    // face the player (or movement target)
    g.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);

    if (this.mixer) {
      // model body: quick forward lunge while swiping
      if (this._swing > 0) {
        this._swing -= dt;
        g.rotation.x = -0.28 * Math.sin((0.32 - this._swing) / 0.32 * Math.PI);
      } else {
        g.rotation.x = 0;
      }
    } else {
      // procedural shamble animation
      this.walkPhase += dt * this.speed * 3.2;
      const s = Math.sin(this.walkPhase);
      this.legL.rotation.x = s * 0.55;
      this.legR.rotation.x = -s * 0.55;
      const armBase = -Math.PI / 2.3;
      if (this._swing > 0) {
        this._swing -= dt;
        this.armR.rotation.x = armBase - 1.1 * Math.sin((0.32 - this._swing) / 0.32 * Math.PI);
      } else {
        this.armL.rotation.x = armBase + s * 0.16;
        this.armR.rotation.x = armBase - s * 0.16;
      }
      g.position.y += Math.abs(s) * 0.04; // bob
    }

    return false;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}

// ------------------------------------------------------------- horde manager
export class Horde {
  constructor(scene, world, gore) {
    this.scene = scene;
    this.world = world;
    this.gore = gore;
    this.zombies = [];
    this.round = 0;
    this.toSpawn = 0;
    this.spawnTimer = 0;
    this.betweenRounds = true;
    this.roundDelay = 3.5;
    this.onRoundChange = null;
    this.onAttackPlayer = null;
  }

  zombiesForRound(r) { return Math.min(Math.round(5 + r * 2.6), 45); }
  healthForRound(r) { return 80 + r * 45; }
  maxAlive(r) { return Math.min(7 + r, 17); }
  spawnInterval(r) { return Math.max(0.55, 2.4 - r * 0.13); }

  startNextRound() {
    this.round++;
    this.toSpawn = this.zombiesForRound(this.round);
    this.betweenRounds = false;
    this.spawnTimer = 1.5;
    sfx.roundStart();
    if (this.onRoundChange) this.onRoundChange(this.round);
  }

  _pickSpawnPoint(playerPos) {
    const open = ['GROUND'];
    if (this.world.doors.doorA.open) open.push('UPPER');
    if (this.world.doors.doorB.open) open.push('BASEMENT');
    let pZone = zoneAt(playerPos.x, playerPos.z);
    if (pZone === 'CORR_A') pZone = this.world.doors.doorA.open ? 'UPPER' : 'GROUND';
    if (pZone === 'CORR_B') pZone = this.world.doors.doorB.open ? 'BASEMENT' : 'GROUND';
    // mostly spawn where the player is, sometimes elsewhere so opened
    // areas stay dangerous
    let zone = pZone;
    if (open.length > 1 && Math.random() < 0.25) {
      zone = open[(Math.random() * open.length) | 0];
    }
    const pts = this.world.spawnPoints[zone];
    return pts[(Math.random() * pts.length) | 0];
  }

  update(dt, playerPos) {
    // spawning
    if (!this.betweenRounds && this.toSpawn > 0) {
      this.spawnTimer -= dt;
      const alive = this.zombies.filter(z => z.state !== 'dead').length;
      if (this.spawnTimer <= 0 && alive < this.maxAlive(this.round)) {
        this.spawnTimer = this.spawnInterval(this.round);
        this.toSpawn--;
        const runnerChance = Math.min(0.08 * Math.max(0, this.round - 2), 0.55);
        const isRunner = Math.random() < runnerChance;
        const speed = isRunner ? 3.1 + Math.random() * 0.7 : 1.15 + Math.random() * 0.7 + this.round * 0.03;
        this.zombies.push(new Zombie(this.scene, this._pickSpawnPoint(playerPos), {
          health: this.healthForRound(this.round),
          speed: Math.min(speed, 4),
          runner: isRunner,
        }));
      }
    }

    // update + cull
    for (let i = this.zombies.length - 1; i >= 0; i--) {
      const remove = this.zombies[i].update(dt, playerPos, this.world, this.gore,
        this.onAttackPlayer, this.zombies);
      if (remove) {
        this.zombies[i].dispose();
        this.zombies.splice(i, 1);
      }
    }

    // round end
    if (!this.betweenRounds && this.toSpawn === 0 &&
        !this.zombies.some(z => z.state !== 'dead')) {
      this.betweenRounds = true;
      this.roundDelay = 6;
      sfx.roundEnd();
    }
    if (this.betweenRounds) {
      this.roundDelay -= dt;
      if (this.roundDelay <= 0) this.startNextRound();
    }
  }

  reset() {
    for (const z of this.zombies) z.dispose();
    this.zombies = [];
    this.round = 0;
    this.toSpawn = 0;
    this.betweenRounds = true;
    this.roundDelay = 3;
  }
}
