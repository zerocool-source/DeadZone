// Asset drop-in pipeline.
//
// The game renders with procedural placeholders, then probes assets/ for
// real files and hot-swaps them in when found. Drop a correctly named file
// into assets/ (see assets/README.md) and it is picked up on next load —
// no code changes needed.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const texLoader = new THREE.TextureLoader();
const TEX_EXTS = ['jpg', 'png', 'webp', 'jpeg'];
const SND_EXTS = ['mp3', 'ogg', 'wav'];

async function firstExisting(base, exts) {
  for (const ext of exts) {
    const path = `${base}.${ext}`;
    try {
      const res = await fetch(path, { method: 'HEAD' });
      if (res.ok) return path;
    } catch { /* offline/file error: keep placeholder */ }
  }
  return null;
}

// Swap a material's map with assets/textures/<slot>.<ext> if present.
export async function applyTextureIfPresent(slot, material, { repeatX = 1, repeatY = 1 } = {}) {
  const path = await firstExisting(`assets/textures/${slot}`, TEX_EXTS);
  if (!path) return false;
  texLoader.load(path, tex => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    tex.colorSpace = THREE.SRGBColorSpace;
    material.map = tex;
    material.needsUpdate = true;
  });
  return true;
}

// Swap a decal texture (e.g. blood splatter) if present.
export async function applyDecalIfPresent(slot, material) {
  const path = await firstExisting(`assets/decals/${slot}`, TEX_EXTS);
  if (!path) return false;
  texLoader.load(path, tex => {
    tex.colorSpace = THREE.SRGBColorSpace;
    material.map = tex;
    material.needsUpdate = true;
  });
  return true;
}

// Resolve assets/sounds/<name>.<ext>, or null to keep the synthesized sfx.
export function soundPathIfPresent(name) {
  return firstExisting(`assets/sounds/${name}`, SND_EXTS);
}

// ----------------------------------------------------------- zombie models
// Older Sketchfab exports use the removed KHR_materials_pbrSpecularGlossiness
// extension; remap its diffuse texture so they don't load untextured gray.
class SpecGlossPlugin {
  constructor(parser) { this.parser = parser; this.name = 'KHR_materials_pbrSpecularGlossiness'; }
  getMaterialType(i) {
    const md = this.parser.json.materials[i];
    return md.extensions && md.extensions[this.name] ? THREE.MeshStandardMaterial : null;
  }
  extendMaterialParams(i, params) {
    const md = this.parser.json.materials[i];
    const ext = md.extensions && md.extensions[this.name];
    if (!ext) return Promise.resolve();
    const df = ext.diffuseFactor || [1, 1, 1, 1];
    params.color = new THREE.Color(df[0], df[1], df[2]);
    params.roughness = 0.85;
    params.metalness = 0;
    const pending = [];
    if (ext.diffuseTexture) pending.push(this.parser.assignTexture(params, 'map', ext.diffuseTexture, THREE.SRGBColorSpace));
    return Promise.all(pending);
  }
}

// Loaded templates; zombies clone from these. null until loaded (or if the
// file is missing) — zombies fall back to the procedural body.
export const zombieModels = { walker: null, runner: null };

export function loadZombieModels() {
  const loader = new GLTFLoader();
  loader.register(p => new SpecGlossPlugin(p));
  // heights compensate for animated bounding boxes (arms forward/stride
  // inflate the box, so targets run taller than the visual goal of ~1.8m)
  const defs = [
    { key: 'walker', file: 'zombie_walk_b', height: 2.35 },
    { key: 'runner', file: 'zombie_necromorph', height: 1.95 },
  ];
  for (const { key, file, height } of defs) {
    loader.load(`assets/models/${file}.glb`, gltf => {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const scale = height / (box.max.y - box.min.y);
      gltf.scene.traverse(n => { if (n.isMesh || n.isSkinnedMesh) n.castShadow = true; });
      zombieModels[key] = {
        scene: gltf.scene,
        clip: gltf.animations[0] || null,
        scale,
        yOffset: -box.min.y * scale,
      };
    }, undefined, () => { /* keep procedural fallback */ });
  }
}
