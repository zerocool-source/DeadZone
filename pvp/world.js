// Shared world definition — the same function is embedded verbatim in
// server.js (which may not import local modules). KEEP THE TWO COPIES
// BYTE-IDENTICAL: collision, spawns and pickups must match on both sides.
export function buildWorld() {
  let s = 1337 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const obstacles = []; // axis-aligned boxes {x1,z1,x2,z2,h,kind}
  const add = (cx, cz, w, d, h, kind) =>
    obstacles.push({ x1: cx - w / 2, z1: cz - d / 2, x2: cx + w / 2, z2: cz + d / 2, h, kind });

  const SIZE = 88; // half-extent of the arena

  // perimeter walls
  add(0, -SIZE - 1.5, SIZE * 2 + 6, 3, 7, 'wall');
  add(0, SIZE + 1.5, SIZE * 2 + 6, 3, 7, 'wall');
  add(-SIZE - 1.5, 0, 3, SIZE * 2 + 6, 7, 'wall');
  add(SIZE + 1.5, 0, 3, SIZE * 2 + 6, 7, 'wall');

  // six ruined building shells on a ring, door gaps facing center
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.35;
    const cx = Math.cos(a) * 46, cz = Math.sin(a) * 46;
    const w = 12 + rnd() * 6, d = 10 + rnd() * 5, h = 3.2 + rnd() * 2.2;
    // four walls with a gap in the center-facing one
    add(cx, cz - d / 2, w, 0.9, h, 'ruin');                       // far
    add(cx - w / 2, cz, 0.9, d, h, 'ruin');                       // left
    add(cx + w / 2, cz, 0.9, d, h, 'ruin');                       // right
    const gap = 3.2;
    add(cx - w / 4 - gap / 4, cz + d / 2, w / 2 - gap / 2, 0.9, h, 'ruin'); // near-left
    add(cx + w / 4 + gap / 4, cz + d / 2, w / 2 - gap / 2, 0.9, h, 'ruin'); // near-right
  }

  // central compound: broken cross walls around the middle
  add(0, -8, 16, 1.1, 2.6, 'ruin');
  add(-8, 4, 1.1, 14, 2.6, 'ruin');
  add(9, 6, 10, 1.1, 2.2, 'ruin');

  // cargo containers
  for (let i = 0; i < 14; i++) {
    const cx = (rnd() * 2 - 1) * (SIZE - 14);
    const cz = (rnd() * 2 - 1) * (SIZE - 14);
    if (Math.hypot(cx, cz) < 14) continue;
    add(cx, cz, 6.2, 2.5, 2.6, 'container');
  }

  // low rubble walls (waist height cover)
  for (let i = 0; i < 18; i++) {
    const cx = (rnd() * 2 - 1) * (SIZE - 10);
    const cz = (rnd() * 2 - 1) * (SIZE - 10);
    const horiz = rnd() > 0.5;
    add(cx, cz, horiz ? 5 + rnd() * 3 : 1, horiz ? 1 : 5 + rnd() * 3, 1.1, 'rubble');
  }

  // rocks
  for (let i = 0; i < 16; i++) {
    const cx = (rnd() * 2 - 1) * (SIZE - 6);
    const cz = (rnd() * 2 - 1) * (SIZE - 6);
    const r = 1 + rnd() * 2.2;
    add(cx, cz, r, r, 0.8 + rnd() * 1.6, 'rock');
  }

  // spawn points: outer ring
  const spawns = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.15;
    spawns.push({ x: Math.cos(a) * 70, z: Math.sin(a) * 70 });
  }

  // pickups: weapons near the middle, health on the ring
  const pickups = [
    { id: 0, type: 'shotgun', x: 0, z: 16 },
    { id: 1, type: 'shotgun', x: -40, z: -38 },
    { id: 2, type: 'longshot', x: 0, z: -16 },
    { id: 3, type: 'longshot', x: 42, z: 40 },
    { id: 4, type: 'health', x: -60, z: 0 },
    { id: 5, type: 'health', x: 60, z: 0 },
    { id: 6, type: 'health', x: 0, z: 60 },
    { id: 7, type: 'health', x: 0, z: -60 },
  ];

  return { size: SIZE, obstacles, spawns, pickups };
}
