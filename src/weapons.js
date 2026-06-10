// Weapons: definitions, procedural viewmodels (placeholder until gun model
// assets arrive), hitscan firing, reloads, wall-buys and upgrades.
import * as THREE from 'three';
import { sfx } from './audio.js';

export const WEAPON_DEFS = {
  m1911: {
    name: 'M1911', cost: 0, damage: 40, mag: 8, reserve: 64,
    auto: false, rpm: 320, reloadTime: 1.2, pellets: 1, spread: 0.012,
    sound: 'pistolShot', size: 0.7,
  },
  kompakt9: {
    name: 'KOMPAKT-9', cost: 1000, damage: 28, mag: 32, reserve: 192,
    auto: true, rpm: 720, reloadTime: 1.8, pellets: 1, spread: 0.03,
    sound: 'smgShot', size: 0.85,
  },
  riot12: {
    name: 'RIOT-12', cost: 1200, damage: 20, mag: 6, reserve: 42,
    auto: false, rpm: 75, reloadTime: 2.6, pellets: 8, spread: 0.07,
    sound: 'shotgunShot', size: 1.1,
  },
  longshot: {
    name: 'LONGSHOT', cost: 1500, damage: 95, mag: 10, reserve: 80,
    auto: false, rpm: 170, reloadTime: 2.2, pellets: 1, spread: 0.004,
    sound: 'rifleShot', size: 1.25,
  },
  hellfang: {
    name: 'HELLFANG', cost: 2500, damage: 38, mag: 75, reserve: 300,
    auto: true, rpm: 600, reloadTime: 3.4, pellets: 1, spread: 0.045,
    sound: 'rifleShot', size: 1.2,
  },
};

export const UPGRADE_COST = 5000;
const HIT_POINTS = 10;
const KILL_POINTS = 60;
const HEADSHOT_KILL_POINTS = 110;

function buildViewmodel(def, upgraded) {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({
    color: upgraded ? 0x3a2a55 : 0x2a2a30, metalness: 0.85, roughness: 0.35,
  });
  const grip = new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 0.9 });
  const s = def.size;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.07 * s, 0.1 * s, 0.34 * s), metal);
  g.add(body);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018 * s, 0.018 * s, 0.3 * s, 8), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02 * s, -0.3 * s);
  g.add(barrel);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06 * s, 0.14 * s, 0.08 * s), grip);
  handle.position.set(0, -0.1 * s, 0.1 * s);
  handle.rotation.x = 0.3;
  g.add(handle);
  if (def.pellets > 1) { // shotgun pump
    const pump = new THREE.Mesh(new THREE.BoxGeometry(0.05 * s, 0.05 * s, 0.14 * s), grip);
    pump.position.set(0, -0.045 * s, -0.22 * s);
    g.add(pump);
  }
  if (def.mag >= 30) { // big mag
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.045 * s, 0.16 * s, 0.07 * s), metal);
    mag.position.set(0, -0.12 * s, -0.02 * s);
    g.add(mag);
  }
  if (upgraded) {
    const glow = new THREE.PointLight(0x9d4edd, 1.2, 0.8);
    glow.position.set(0, 0.05, -0.1);
    g.add(glow);
  }
  // muzzle flash (toggled visible per shot)
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.16 * s, 0.16 * s),
    new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.95, depthWrite: false }));
  flash.position.set(0, 0.02 * s, -0.48 * s);
  flash.visible = false;
  g.add(flash);
  const flashLight = new THREE.PointLight(0xffaa44, 0, 6);
  flashLight.position.copy(flash.position);
  g.add(flashLight);
  g.userData = { flash, flashLight };
  return g;
}

class WeaponInstance {
  constructor(id) {
    this.id = id;
    this.upgraded = false;
    const def = WEAPON_DEFS[id];
    this.magSize = def.mag;
    this.mag = def.mag;
    this.reserve = def.reserve;
    this.damage = def.damage;
  }
  get def() { return WEAPON_DEFS[this.id]; }
  get name() { return this.def.name + (this.upgraded ? ' ★' : ''); }
  upgrade() {
    const def = this.def;
    this.upgraded = true;
    this.damage = Math.round(def.damage * 2.5);
    this.magSize = Math.round(def.mag * 1.5);
    this.reserve = def.reserve * 2;
    this.mag = this.magSize;
  }
  refill() {
    this.reserve = this.def.reserve * (this.upgraded ? 2 : 1);
  }
}

export class Arsenal {
  constructor(camera, scene, game) {
    this.camera = camera;
    this.scene = scene;
    this.game = game;          // { gore, horde, addPoints(n, headshot), hud }
    this.slots = [new WeaponInstance('m1911')];
    this.current = 0;
    this.cooldown = 0;
    this.reloading = 0;
    this.triggerHeld = false;
    this._semiLatch = false;   // require trigger release for semi-auto
    this.flashTimer = 0;
    this.raycaster = new THREE.Raycaster();

    this.holder = new THREE.Group();
    this.holder.position.set(0.3, -0.28, -0.6);
    camera.add(this.holder);
    this._mountViewmodel();
    this.bobPhase = 0;
    this.recoil = 0;
  }

  get weapon() { return this.slots[this.current]; }

  _mountViewmodel() {
    this.holder.clear();
    this.viewmodel = buildViewmodel(this.weapon.def, this.weapon.upgraded);
    this.holder.add(this.viewmodel);
    this.game.hud.setWeapon(this.weapon);
  }

  switchSlot(i) {
    if (i === this.current || i >= this.slots.length || this.reloading > 0) return;
    this.current = i;
    this.cooldown = 0.3;
    this._mountViewmodel();
  }

  // Buy from a wall: new gun, or ammo refill at half price if already owned.
  buyOrRefill(id, points) {
    const def = WEAPON_DEFS[id];
    const owned = this.slots.find(w => w.id === id);
    if (owned) {
      const cost = Math.floor(def.cost / 2);
      if (points < cost) return { ok: false, cost };
      owned.refill();
      sfx.purchase();
      this.game.hud.setWeapon(this.weapon);
      return { ok: true, cost };
    }
    if (points < def.cost) return { ok: false, cost: def.cost };
    const inst = new WeaponInstance(id);
    if (this.slots.length < 2) {
      this.slots.push(inst);
      this.current = this.slots.length - 1;
    } else {
      this.slots[this.current] = inst; // trade in the held weapon
    }
    this.reloading = 0;
    sfx.purchase();
    this._mountViewmodel();
    return { ok: true, cost: def.cost };
  }

  upgradeCurrent(points) {
    if (this.weapon.upgraded) return { ok: false, cost: UPGRADE_COST, already: true };
    if (points < UPGRADE_COST) return { ok: false, cost: UPGRADE_COST };
    this.weapon.upgrade();
    sfx.upgrade();
    this._mountViewmodel();
    return { ok: true, cost: UPGRADE_COST };
  }

  reload() {
    const w = this.weapon;
    if (this.reloading > 0 || w.mag === w.magSize || w.reserve <= 0) return;
    this.reloading = w.def.reloadTime;
    sfx.reload();
  }

  _fire() {
    const w = this.weapon;
    if (w.mag <= 0) {
      sfx.dryFire();
      this.reload();
      return;
    }
    w.mag--;
    this.cooldown = 60 / w.def.rpm;
    sfx[w.def.sound]();
    this.recoil = 1;
    this.flashTimer = 0.045;
    const { flash, flashLight } = this.viewmodel.userData;
    flash.visible = true;
    flash.rotation.z = Math.random() * Math.PI;
    flashLight.intensity = 8;

    // hitscan — one ray per pellet
    const targets = [];
    for (const z of this.game.horde.zombies) {
      if (z.state === 'dead') continue;
      targets.push(...z.hitMeshes);
    }
    const dir = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const camPos = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    for (let p = 0; p < w.def.pellets; p++) {
      dir.copy(camDir);
      dir.x += (Math.random() - 0.5) * 2 * w.def.spread;
      dir.y += (Math.random() - 0.5) * 2 * w.def.spread;
      dir.z += (Math.random() - 0.5) * 2 * w.def.spread;
      dir.normalize();
      this.raycaster.set(camPos, dir);
      this.raycaster.far = 80;
      const hits = this.raycaster.intersectObjects(targets, false);
      if (!hits.length) continue;
      const hit = hits[0];
      const zombie = hit.object.userData.zombie;
      const isHead = hit.object.userData.part === 'head';
      this.game.gore.spray(hit.point, dir, isHead ? 18 : 10, 4.5);
      if (Math.random() < 0.5) {
        this.game.gore.splatFloor(zombie.group.position.x, zombie.group.position.z, 0.6);
      }
      sfx.fleshHit();
      this.game.hud.hitmarker();
      const killed = zombie.takeDamage(w.damage, isHead);
      if (killed) {
        zombie.die(this.game.gore, dir, isHead);
        this.game.addPoints(isHead ? HEADSHOT_KILL_POINTS : KILL_POINTS, isHead);
        this.game.onZombieKilled();
      } else {
        this.game.addPoints(HIT_POINTS, false);
      }
    }
    this.game.hud.setWeapon(w);
  }

  update(dt) {
    const w = this.weapon;
    this.cooldown -= dt;

    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const need = w.magSize - w.mag;
        const take = Math.min(need, w.reserve);
        w.mag += take;
        w.reserve -= take;
        this.game.hud.setWeapon(w);
      }
    } else if (this.triggerHeld && this.cooldown <= 0) {
      if (w.def.auto || !this._semiLatch) {
        this._fire();
        this._semiLatch = true;
      }
    }
    if (!this.triggerHeld) this._semiLatch = false;

    // muzzle flash decay
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        const { flash, flashLight } = this.viewmodel.userData;
        flash.visible = false;
        flashLight.intensity = 0;
      }
    }

    // viewmodel motion: bob + recoil + reload dip
    this.recoil = Math.max(0, this.recoil - dt * 7);
    const moving = this.game.playerMoving ? 1 : 0;
    this.bobPhase += dt * (moving ? 9 : 2);
    const bobY = Math.sin(this.bobPhase) * 0.008 * (moving ? 2 : 1);
    const bobX = Math.cos(this.bobPhase * 0.5) * 0.006 * moving;
    const reloadDip = this.reloading > 0 ? 0.16 * Math.sin(Math.min(1, this.reloading / w.def.reloadTime) * Math.PI) : 0;
    this.holder.position.set(0.3 + bobX, -0.28 + bobY - reloadDip, -0.6 + this.recoil * 0.07);
    this.holder.rotation.x = this.recoil * 0.09 + (this.reloading > 0 ? -0.5 * reloadDip : 0);
  }

  reset() {
    this.slots = [new WeaponInstance('m1911')];
    this.current = 0;
    this.reloading = 0;
    this.cooldown = 0;
    this.triggerHeld = false;
    this._mountViewmodel();
  }
}
