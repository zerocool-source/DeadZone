// Asset drop-in pipeline.
//
// The game renders with procedural placeholders, then probes assets/ for
// real files and hot-swaps them in when found. Drop a correctly named file
// into assets/ (see assets/README.md) and it is picked up on next load —
// no code changes needed.
import * as THREE from 'three';

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
