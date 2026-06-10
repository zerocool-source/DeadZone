// Procedural canvas textures. These are stand-ins until real texture assets
// are dropped into /assets — see README for the swap points.
import * as THREE from 'three';

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')];
}

function asTexture(canvas, repeatX = 1, repeatY = 1) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function concreteTexture(repeatX = 4, repeatY = 4, base = '#4a4a48') {
  const [c, ctx] = makeCanvas(256);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4200; i++) {
    const v = Math.random() * 36 - 18;
    ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 160})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  // cracks
  ctx.strokeStyle = 'rgba(20,20,20,0.35)';
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    let x = Math.random() * 256, y = Math.random() * 256;
    ctx.moveTo(x, y);
    for (let s = 0; s < 8; s++) {
      x += Math.random() * 40 - 20; y += Math.random() * 40 - 20;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return asTexture(c, repeatX, repeatY);
}

export function brickTexture(repeatX = 4, repeatY = 2) {
  const [c, ctx] = makeCanvas(256);
  ctx.fillStyle = '#3a3030';
  ctx.fillRect(0, 0, 256, 256);
  const bw = 64, bh = 32;
  for (let row = 0; row < 256 / bh; row++) {
    const off = (row % 2) * bw / 2;
    for (let col = -1; col < 256 / bw; col++) {
      const shade = 60 + Math.random() * 30;
      ctx.fillStyle = `rgb(${shade + 20},${shade * 0.55},${shade * 0.5})`;
      ctx.fillRect(col * bw + off + 2, row * bh + 2, bw - 4, bh - 4);
      // grime
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.3})`;
      ctx.fillRect(col * bw + off + 2, row * bh + 2, bw - 4, bh - 4);
    }
  }
  return asTexture(c, repeatX, repeatY);
}

export function woodTexture(repeatX = 4, repeatY = 4) {
  const [c, ctx] = makeCanvas(256);
  ctx.fillStyle = '#4a3520';
  ctx.fillRect(0, 0, 256, 256);
  const plank = 42;
  for (let p = 0; p < 256 / plank + 1; p++) {
    const shade = 50 + Math.random() * 28;
    ctx.fillStyle = `rgb(${shade + 24},${shade * 0.72},${shade * 0.42})`;
    ctx.fillRect(0, p * plank, 256, plank - 3);
    ctx.strokeStyle = 'rgba(30,18,8,0.5)';
    for (let g = 0; g < 5; g++) {
      ctx.beginPath();
      const y = p * plank + Math.random() * plank;
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(80, y + Math.random() * 6 - 3, 170, y + Math.random() * 6 - 3, 256, y);
      ctx.stroke();
    }
  }
  return asTexture(c, repeatX, repeatY);
}

export function bloodStainTexture() {
  const [c, ctx] = makeCanvas(128);
  ctx.clearRect(0, 0, 128, 128);
  const cx = 64, cy = 64;
  for (let i = 0; i < 26; i++) {
    const r = 6 + Math.random() * 26;
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * 34;
    const g = ctx.createRadialGradient(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0,
      cx + Math.cos(a) * d, cy + Math.sin(a) * d, r);
    g.addColorStop(0, 'rgba(110,4,4,0.9)');
    g.addColorStop(1, 'rgba(80,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Floating label sprite (wall-buy prices, etc.)
export function textSprite(lines, { size = 30, color = '#ffd34d' } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  c.width = 512; c.height = 64 * lines.length + 16;
  ctx.font = `bold ${size}px 'Courier New', monospace`;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = color;
  lines.forEach((line, i) => ctx.fillText(line, 256, 44 + i * 56));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.2, 2.2 * c.height / c.width, 1);
  return sprite;
}
