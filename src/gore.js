// Blood & gore: particle sprays, persistent splatter decals, and gibs that
// fly off zombies on death / headshot.
import * as THREE from 'three';
import { bloodStainTexture } from './textures.js';
import { groundHeightAt } from './world.js';
import { applyDecalIfPresent } from './assets.js';

const MAX_PARTICLES = 600;
const MAX_DECALS = 90;
const MAX_GIBS = 40;
const GRAVITY = -16;

export class GoreSystem {
  constructor(scene) {
    this.scene = scene;

    // --- blood particles (THREE.Points pool)
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x8f0606, size: 0.085, sizeAttenuation: true,
      transparent: true, opacity: 0.95, depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.particles = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({ alive: false, vel: new THREE.Vector3(), life: 0 });
      this.positions[i * 3 + 1] = -999;
    }
    this._next = 0;

    // --- splatter decals
    this.decalMat = new THREE.MeshBasicMaterial({
      map: bloodStainTexture(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2,
    });
    applyDecalIfPresent('blood_splatter', this.decalMat);
    this.decals = [];

    // --- gibs
    this.gibs = [];
    this.gibMats = [
      new THREE.MeshStandardMaterial({ color: 0x7a0a0a, roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ color: 0x5e1414, roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ color: 0x3d4a2a, roughness: 0.9 }), // rotted flesh
    ];
  }

  spray(origin, direction, count = 14, speed = 5) {
    for (let n = 0; n < count; n++) {
      const i = this._next;
      this._next = (this._next + 1) % MAX_PARTICLES;
      const p = this.particles[i];
      p.alive = true;
      p.life = 0.5 + Math.random() * 0.6;
      p.vel.copy(direction)
        .addScaledVector(new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5), 1.4)
        .normalize()
        .multiplyScalar(speed * (0.4 + Math.random() * 0.9));
      this.positions[i * 3] = origin.x;
      this.positions[i * 3 + 1] = origin.y;
      this.positions[i * 3 + 2] = origin.z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  burst(origin, count = 40) {
    this.spray(origin, new THREE.Vector3(0, 1, 0), count, 6);
  }

  splatFloor(x, z, scale = 1) {
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.decalMat);
    decal.rotation.x = -Math.PI / 2;
    decal.rotation.z = Math.random() * Math.PI * 2;
    const s = (0.7 + Math.random() * 0.9) * scale;
    decal.scale.set(s, s, 1);
    decal.position.set(x, groundHeightAt(x, z) + 0.01 + this.decals.length * 0.0004, z);
    this.scene.add(decal);
    this.decals.push(decal);
    if (this.decals.length > MAX_DECALS) {
      const old = this.decals.shift();
      this.scene.remove(old);
    }
  }

  splatWall(point, normal) {
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.decalMat);
    decal.position.copy(point).addScaledVector(normal, 0.02);
    decal.lookAt(point.clone().add(normal));
    decal.rotateZ(Math.random() * Math.PI * 2);
    const s = 0.4 + Math.random() * 0.5;
    decal.scale.set(s, s, 1);
    this.scene.add(decal);
    this.decals.push(decal);
    if (this.decals.length > MAX_DECALS) {
      const old = this.decals.shift();
      this.scene.remove(old);
    }
  }

  // chunks of zombie flying off
  spawnGibs(origin, count = 5, power = 5) {
    for (let n = 0; n < count; n++) {
      if (this.gibs.length >= MAX_GIBS) {
        const old = this.gibs.shift();
        this.scene.remove(old.mesh);
      }
      const size = 0.07 + Math.random() * 0.13;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size, size * (0.6 + Math.random()), size),
        this.gibMats[(Math.random() * this.gibMats.length) | 0]);
      mesh.position.copy(origin);
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.gibs.push({
        mesh,
        vel: new THREE.Vector3((Math.random() - 0.5) * power, Math.random() * power * 0.9 + 1.5, (Math.random() - 0.5) * power),
        spin: new THREE.Vector3(Math.random() * 10 - 5, Math.random() * 10 - 5, Math.random() * 10 - 5),
        life: 6 + Math.random() * 4,
        settled: false,
      });
    }
  }

  update(dt) {
    // particles
    const posAttr = this.points.geometry.attributes.position;
    let any = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;
      any = true;
      p.life -= dt;
      const ix = i * 3;
      p.vel.y += GRAVITY * 0.6 * dt;
      this.positions[ix] += p.vel.x * dt;
      this.positions[ix + 1] += p.vel.y * dt;
      this.positions[ix + 2] += p.vel.z * dt;
      const floor = groundHeightAt(this.positions[ix], this.positions[ix + 2]);
      if (this.positions[ix + 1] <= floor + 0.02 || p.life <= 0) {
        if (p.life > 0 && Math.random() < 0.18) {
          this.splatFloor(this.positions[ix], this.positions[ix + 2], 0.35);
        }
        p.alive = false;
        this.positions[ix + 1] = -999;
      }
    }
    if (any) posAttr.needsUpdate = true;

    // gibs
    for (let i = this.gibs.length - 1; i >= 0; i--) {
      const g = this.gibs[i];
      g.life -= dt;
      if (g.life <= 0) {
        this.scene.remove(g.mesh);
        this.gibs.splice(i, 1);
        continue;
      }
      if (g.settled) continue;
      g.vel.y += GRAVITY * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      g.mesh.rotation.x += g.spin.x * dt;
      g.mesh.rotation.y += g.spin.y * dt;
      g.mesh.rotation.z += g.spin.z * dt;
      const floor = groundHeightAt(g.mesh.position.x, g.mesh.position.z);
      if (g.mesh.position.y <= floor + 0.05) {
        g.mesh.position.y = floor + 0.05;
        if (Math.abs(g.vel.y) > 2.2) {
          g.vel.y = -g.vel.y * 0.35;
          g.vel.x *= 0.55; g.vel.z *= 0.55;
          this.splatFloor(g.mesh.position.x, g.mesh.position.z, 0.5);
        } else {
          g.settled = true;
          this.splatFloor(g.mesh.position.x, g.mesh.position.z, 0.4);
        }
      }
    }
  }
}
