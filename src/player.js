// First-person player: pointer-lock look, WASD + sprint movement,
// floor-height tracking (stairs), collision, health with regen.
import * as THREE from 'three';
import { groundHeightAt, resolveCollisions } from './world.js';
import { sfx } from './audio.js';

const EYE_HEIGHT = 1.62;
const RADIUS = 0.35;
const WALK_SPEED = 4.4;
const SPRINT_SPEED = 6.6;
const REGEN_DELAY = 4.5;
const REGEN_RATE = 26;

export class Player {
  constructor(camera, domElement) {
    this.camera = camera;
    this.position = new THREE.Vector3(0, 0, 3);   // feet
    this.yaw = 0;                                  // face into the room
    this.pitch = 0;
    this.health = 100;
    this.timeSinceHit = 99;
    this.keys = {};
    this.moving = false;
    this.dead = false;
    this.onDamaged = null;

    document.addEventListener('keydown', e => { this.keys[e.code] = true; });
    document.addEventListener('keyup', e => { this.keys[e.code] = false; });
    document.addEventListener('mousemove', e => {
      if (document.pointerLockElement !== domElement) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch -= e.movementY * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
    });
  }

  takeDamage(amount) {
    if (this.dead) return;
    this.health -= amount;
    this.timeSinceHit = 0;
    sfx.playerHurt();
    if (this.onDamaged) this.onDamaged(this.health);
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
    }
  }

  update(dt, colliders) {
    if (this.dead) {
      // death camera: slump to the floor
      const floor = groundHeightAt(this.position.x, this.position.z);
      this.camera.position.y = Math.max(floor + 0.4, this.camera.position.y - dt * 2);
      this.camera.rotation.z = Math.min(0.5, this.camera.rotation.z + dt * 0.8);
      return;
    }

    // health regen
    this.timeSinceHit += dt;
    if (this.timeSinceHit > REGEN_DELAY && this.health < 100) {
      this.health = Math.min(100, this.health + REGEN_RATE * dt);
      if (this.onDamaged) this.onDamaged(this.health);
    }

    // movement
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const move = new THREE.Vector3();
    if (this.keys['KeyW']) move.add(forward);
    if (this.keys['KeyS']) move.sub(forward);
    if (this.keys['KeyD']) move.add(right);
    if (this.keys['KeyA']) move.sub(right);
    this.moving = move.lengthSq() > 0;
    if (this.moving) {
      move.normalize();
      const sprinting = this.keys['ShiftLeft'] || this.keys['ShiftRight'];
      this.position.addScaledVector(move, (sprinting ? SPRINT_SPEED : WALK_SPEED) * dt);
    }

    resolveCollisions(this.position, RADIUS, this.position.y, 1.8, colliders);
    // snap feet to the floor (handles the stair ramps)
    this.position.y = groundHeightAt(this.position.x, this.position.z);

    // camera
    this.camera.position.set(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
  }

  reset() {
    this.position.set(0, 0, 3);
    this.yaw = 0;
    this.pitch = 0;
    this.health = 100;
    this.timeSinceHit = 99;
    this.dead = false;
    this.camera.rotation.z = 0;
  }
}
