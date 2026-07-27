// Shared world definition — buildWorld and groundHeightAt are embedded verbatim
// in server.js (a Durable Object may not import local modules). KEEP THE TWO
// COPIES BYTE-IDENTICAL: collision, floor height, spawns and pickups must match
// on both sides or the client mispredicts.
export function buildWorld() {
  // Hand-authored layout. The seeded RNG below is cosmetic only: prop rotation,
  // prop scale and a few centimetres of prop jitter. Nothing that decides
  // whether a lane is open, a jump lands or a sightline exists goes through it.
  let s = 90210 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  const SIZE = 88;        // half-extent of the arena (176 x 176 m)
  const obstacles = [];   // solid boxes y=0..h — block movement and bullets
  const platforms = [];   // standable tops {x1,z1,x2,z2,y}
  const ground = [];      // material patches; later entries win where they overlap
  const props = [];       // decoration only, never collided against
  const pois = [];        // district labels for the minimap

  const add = (cx, cz, w, d, h, kind) =>
    obstacles.push({ x1: cx - w / 2, z1: cz - d / 2, x2: cx + w / 2, z2: cz + d / 2, h, kind });
  // A box you can stand on. Its platform top is always backed by a solid box of
  // exactly the same height: groundHeightAt is a heightfield, so any walkable
  // space left under a platform would suck a player up through the floor.
  const deck = (cx, cz, w, d, h, kind) => {
    add(cx, cz, w, d, h, kind);
    platforms.push({ x1: cx - w / 2, z1: cz - d / 2, x2: cx + w / 2, z2: cz + d / 2, y: h });
  };
  const patch = (x1, z1, x2, z2, mat) => ground.push({ x1, z1, x2, z2, mat });
  const prop = (kind, x, z, lo, hi) => props.push({
    kind,
    x: +(x + (rnd() - 0.5) * 1.6).toFixed(2),
    z: +(z + (rnd() - 0.5) * 1.6).toFixed(2),
    ry: +(rnd() * 6.2832).toFixed(3),
    s: +(lo + rnd() * (hi - lo)).toFixed(2),
  });
  // repeated furniture, so the coordinates below read as a layout and not as maths
  const cont = (cx, cz, alongX) =>
    add(cx, cz, alongX ? 6.2 : 2.5, alongX ? 2.5 : 6.2, 2.6, 'container');
  const car = (cx, cz, alongX) =>
    add(cx, cz, alongX ? 4.6 : 2.1, alongX ? 2.1 : 4.6, 1.5, 'car');
  const jersey = (cx, cz, alongX) =>
    add(cx, cz, alongX ? 3.8 : 0.7, alongX ? 0.7 : 3.8, 1.15, 'barrier');
  const sandbag = (cx, cz, w, d) => add(cx, cz, w, d, 1.05, 'rubble');
  const barrels = (cx, cz) => {
    add(cx, cz, 1.1, 1.1, 1.15, 'barrel');
    add(cx + 1.4, cz + 0.6, 1.1, 1.1, 1.15, 'barrel');
    add(cx + 0.5, cz + 1.5, 1.1, 1.1, 1.15, 'barrel');
  };
  // A stair of crates butted against a deck edge at (cx,cz), stepping away
  // along (dx,dz): heights top, top-1 ... 1, each flush with the next. Jump
  // apex is JUMP_V^2/(2*GRAV) = 1.28 m, so no step may be taller than that and
  // the crates must touch exactly, or the climb breaks.
  const stack = (cx, cz, dx, dz, top) => {
    for (let i = 0; i < top; i++) {
      const o = i * 2.4 + 1.2;
      // 2.5 deep on a 2.4 pitch: every crate overlaps its neighbour by 100 mm
      // so no float seam can open a hole in the heightfield between two steps
      deck(cx + dx * o, cz + dz * o, dx ? 2.5 : 3, dz ? 2.5 : 3, top - i, 'crate');
    }
  };

  // ---------------------------------------------------------------- perimeter
  add(0, -SIZE - 1.5, SIZE * 2 + 6, 3, 7, 'wall');
  add(0, SIZE + 1.5, SIZE * 2 + 6, 3, 7, 'wall');
  add(-SIZE - 1.5, 0, 3, SIZE * 2 + 6, 7, 'wall');
  add(SIZE + 1.5, 0, 3, SIZE * 2 + 6, 7, 'wall');

  // ------------------------------------------------------- THE TOWER (centre)
  // 14x14 concrete plinth at 2.6 carrying the derelict water tower, ringed by
  // an unbroken 1.0 m parapet. The ring is what keeps the deck honest: a body
  // up there is covered from every ground-level sightline (only the head shows
  // over it) and there is no hole for anyone outside to shoot through. The
  // price is that the last move in is a vault: from the 3.0 m crate you have
  // to be moving to clear the parapet before you drop back under 3.4.
  pois.push({ name: 'THE TOWER', x: 0, z: 0 });
  deck(0, 0, 14, 14, 2.6, 'building');
  add(0, 0, 4.2, 4.2, 9.4, 'tower');
  add(0, -6.5, 13.6, 0.6, 3.6, 'barrier');
  add(0, 6.5, 13.6, 0.6, 3.6, 'barrier');
  add(-6.5, 0, 0.6, 13.6, 3.6, 'barrier');
  add(6.5, 0, 0.6, 13.6, 3.6, 'barrier');
  stack(0, -7, 0, -1, 3);                      // climb in from the north,
  stack(7, 0, 1, 0, 3);                        // the east
  stack(0, 7, 0, 1, 3);                        // or the south

  // approach cover so the four radials are not a naked run at the plinth
  add(-13, -13, 7, 1.2, 1.4, 'rubble');
  add(13, -13, 1.2, 7, 1.4, 'rubble');
  add(-13, 13, 1.2, 7, 1.4, 'rubble');
  add(13, 13, 7, 1.2, 1.4, 'rubble');
  add(-19, -6, 1.2, 6, 1.2, 'barrier');
  add(19, 6, 1.2, 6, 1.2, 'barrier');
  add(-6, 19, 6, 1.2, 1.2, 'barrier');
  add(6, -19, 6, 1.2, 1.2, 'barrier');
  add(-9, -18, 2.6, 2.6, 1.7, 'rock');
  add(18, -9, 2.6, 2.6, 1.7, 'rock');
  add(9, 18, 2.6, 2.6, 1.7, 'rock');
  add(-18, 9, 2.6, 2.6, 1.7, 'rock');

  // ------------------------------------------------------- THE YARD (NE)
  // Shipping containers in a tight maze. One straight run of three containers
  // is a continuous 18.6 m catwalk at 2.6, climbed from the crates at its
  // south end. The shotgun sits in a pocket deep in the middle.
  pois.push({ name: 'THE YARD', x: 52, z: -52 });
  cont(32, -74, 1); cont(44, -74, 1); cont(58, -76, 1); cont(72, -73, 1);
  cont(28, -64, 0); cont(38, -66, 1); cont(52, -66, 0); cont(66, -64, 1);
  cont(76, -62, 0);
  cont(33, -55, 0); cont(58, -56, 1); cont(70, -53, 0);
  cont(30, -46, 1); cont(38, -43, 0); cont(58, -46, 0); cont(68, -44, 1);
  cont(77, -48, 1);
  cont(31, -35, 0); cont(40, -33, 1); cont(55, -35, 1); cont(66, -33, 0);
  cont(75, -36, 1);
  // catwalk: three containers butted end to end, one platform over the run
  cont(46.5, -58.6, 0); cont(46.5, -52.4, 0); cont(46.5, -46.2, 0);
  platforms.push({ x1: 45.25, z1: -61.7, x2: 47.75, z2: -43.1, y: 2.6 });
  stack(46.5, -43.1, 0, 1, 2);
  add(62, -70, 1.2, 6, 1.3, 'rubble');
  add(36, -60, 6, 1.2, 1.3, 'rubble');
  add(72, -58, 6, 1.2, 1.3, 'rubble');
  add(50, -38, 1.2, 5, 1.2, 'rubble');
  add(80, -70, 2.8, 2.8, 1.8, 'rock');
  add(26, -70, 2.6, 2.6, 1.6, 'rock');

  // ------------------------------------------------------- THE RUINS (NW)
  // Three shells with 0.9 m walls, door gaps and enterable interiors. The
  // middle one has a solid wing whose roof is a 3.0 m firing deck; its shell
  // walls are 3.8 so nobody can step off the roof onto a wall top.
  pois.push({ name: 'THE RUINS', x: -50, z: -50 });
  // shell A "the depot" — outer 18 x 15 at (-36,-36), doors south and west
  add(-36, -43.05, 18, 0.9, 3.6, 'ruin');
  add(-41.35, -28.95, 7.3, 0.9, 3.6, 'ruin');
  add(-30.65, -28.95, 7.3, 0.9, 3.6, 'ruin');
  add(-44.55, -40.75, 0.9, 5.5, 3.6, 'ruin');
  add(-44.55, -31.75, 0.9, 6.5, 3.6, 'ruin');
  add(-27.45, -36, 0.9, 15, 3.6, 'ruin');
  add(-36, -36, 0.9, 7, 2.2, 'ruin');
  // shell B "the plant" — outer 16 x 16 at (-64,-46), doors north and east
  add(-69, -53.55, 6, 0.9, 3.8, 'ruin');
  add(-59.3, -53.55, 6.6, 0.9, 3.8, 'ruin');
  add(-71.55, -46, 0.9, 16, 3.8, 'ruin');
  add(-56.45, -51, 0.9, 6, 3.8, 'ruin');
  add(-56.45, -41.3, 0.9, 6.6, 3.8, 'ruin');
  add(-64, -38.45, 16, 0.9, 3.8, 'ruin');
  deck(-64, -34, 16, 8, 3.0, 'building');      // the intact wing = roof deck
  stack(-64, -30, 0, 1, 2);
  // shell C "the tenement" — outer 16 x 14 at (-38,-64), doors north and west
  add(-43, -70.55, 6, 0.9, 3.4, 'ruin');
  add(-33.3, -70.55, 6.6, 0.9, 3.4, 'ruin');
  add(-45.55, -68.5, 0.9, 5, 3.4, 'ruin');
  add(-45.55, -59.8, 0.9, 5.6, 3.4, 'ruin');
  add(-38, -57.45, 16, 0.9, 3.4, 'ruin');
  add(-30.45, -64, 0.9, 14, 3.4, 'ruin');
  add(-38, -64, 6, 0.9, 2.0, 'ruin');
  add(-52, -66, 6, 1.3, 1.3, 'rubble');
  add(-58, -71, 1.3, 6, 1.3, 'rubble');
  add(-29, -50, 1.3, 7, 1.4, 'rubble');
  add(-50, -24, 7, 1.3, 1.2, 'rubble');
  add(-74, -66, 3, 3, 1.9, 'rock');
  add(-78, -52, 2.6, 2.6, 1.6, 'rock');
  add(-25, -62, 2.8, 2.8, 1.7, 'rock');
  add(-66, -72, 2.4, 2.4, 1.5, 'rock');
  add(-76, -30, 2.8, 2.8, 1.8, 'rock');

  // ------------------------------------------------------- THE STRIP (SW)
  // A 54 m asphalt run with wrecks and jersey barriers down it. Long sightline
  // west to the longshot at the dead end; the cross road is the second way in.
  pois.push({ name: 'THE STRIP', x: -53, z: 50 });
  car(-74, 47, 1); car(-68, 53, 1); car(-58, 46.5, 0); car(-46, 53.5, 1);
  car(-38, 47, 1); car(-31, 52.5, 0);
  jersey(-78, 44.3, 1); jersey(-70, 44.3, 1); jersey(-54, 44.3, 1);
  jersey(-44, 44.3, 1); jersey(-34, 44.3, 1);
  jersey(-74, 55.7, 1); jersey(-64, 55.7, 1); jersey(-50, 55.7, 1);
  jersey(-40, 55.7, 1); jersey(-30, 55.7, 1);
  jersey(-56.5, 34, 0); jersey(-56.5, 64, 0); jersey(-56.5, 72, 0);
  // roadside structures, so the shoulder is not a bare strip either
  cont(-72, 62, 1); cont(-64, 68, 0); cont(-42, 64, 1); cont(-30, 70, 0);
  cont(-76, 34, 0); cont(-46, 34, 1);
  add(-68, 76, 12, 1.2, 1.4, 'rubble');
  add(-36, 76, 1.2, 8, 1.4, 'rubble');
  add(-24, 60, 1.2, 8, 1.3, 'rubble');
  add(-80, 66, 2.8, 2.8, 1.8, 'rock');
  add(-26, 34, 2.6, 2.6, 1.6, 'rock');
  add(-62, 26, 2.8, 2.8, 1.7, 'rock');

  // ------------------------------------------------------- THE PITS (SE)
  // Open scrub: sandbag lines, barrel clusters and rocks, all low. The most
  // exposed crossing on the map — the second longshot sits out in the middle.
  pois.push({ name: 'THE PITS', x: 53, z: 53 });
  sandbag(40, 34, 9, 1.1); sandbag(62, 31, 1.1, 9); sandbag(34, 52, 1.1, 10);
  sandbag(52, 69, 11, 1.1); sandbag(73, 58, 1.1, 10); sandbag(46, 44, 8, 1.1);
  sandbag(66, 46, 8, 1.1); sandbag(44, 76, 1.1, 8); sandbag(30, 66, 8, 1.1);
  sandbag(78, 74, 1.1, 9);
  barrels(38, 62); barrels(58, 37); barrels(70, 70); barrels(29, 43);
  barrels(50, 62); barrels(77, 33); barrels(62, 78);
  add(48, 29, 3, 3, 2, 'rock');
  add(30, 74, 3.4, 3.4, 2.2, 'rock');
  add(69, 26, 2.6, 2.6, 1.6, 'rock');
  add(56, 80, 3, 3, 1.9, 'rock');
  add(80, 46, 2.8, 2.8, 1.8, 'rock');
  add(26, 30, 2.6, 2.6, 1.5, 'rock');
  add(66, 60, 2.4, 2.4, 1.4, 'rock');

  // ------------------------------------------------------- the ring road
  // Every district hangs off this loop, and the four radials run inward from
  // it. Wrecks and barriers along it keep the 90 m straights honest.
  car(-36, -37, 1); car(-10, -42, 1); car(20, -43, 1);
  jersey(-24, -43, 1); jersey(6, -37, 1); jersey(34, -38, 1);
  car(43, -30, 0); car(42, -2, 0); car(43, 26, 0);
  jersey(37, -16, 0); jersey(38, 12, 0); jersey(37, 38, 0);
  car(-34, 43, 1); car(-6, 42, 1); car(22, 43, 1);
  jersey(-20, 37, 1); jersey(8, 38, 1); jersey(36, 37, 1);
  car(-43, 30, 0); car(-42, 2, 0); car(-43, -26, 0);
  jersey(-37, 16, 0); jersey(-38, -12, 0); jersey(-37, -38, 0);
  add(-8, -30, 5, 1.2, 1.3, 'rubble');
  add(9, -27, 1.2, 5, 1.3, 'rubble');
  add(30, -8, 1.2, 5, 1.3, 'rubble');
  add(27, 9, 5, 1.2, 1.3, 'rubble');
  add(8, 30, 5, 1.2, 1.3, 'rubble');
  add(-9, 27, 1.2, 5, 1.3, 'rubble');
  add(-30, 8, 1.2, 5, 1.3, 'rubble');
  add(-27, -9, 5, 1.2, 1.3, 'rubble');
  // outer band cover, so the run in from a spawn is never a bare 25 m
  add(-62, -14, 1.3, 8, 1.4, 'rubble');
  add(-62, 12, 1.3, 8, 1.4, 'rubble');
  add(62, -12, 1.3, 8, 1.4, 'rubble');
  add(62, 14, 1.3, 8, 1.4, 'rubble');
  add(-14, -62, 8, 1.3, 1.4, 'rubble');
  add(12, -62, 8, 1.3, 1.4, 'rubble');
  add(-12, 62, 8, 1.3, 1.4, 'rubble');
  add(14, 62, 8, 1.3, 1.4, 'rubble');
  add(-78, -14, 2.8, 2.8, 1.8, 'rock');
  add(-78, 14, 2.6, 2.6, 1.6, 'rock');
  add(78, -14, 2.6, 2.6, 1.7, 'rock');
  add(78, 14, 2.8, 2.8, 1.8, 'rock');
  add(-14, -80, 2.6, 2.6, 1.6, 'rock');
  add(14, -80, 2.8, 2.8, 1.8, 'rock');
  add(-14, 80, 2.8, 2.8, 1.7, 'rock');
  add(14, 80, 2.6, 2.6, 1.6, 'rock');
  add(0, -46, 7, 1.3, 1.4, 'rubble');
  add(0, 46, 7, 1.3, 1.4, 'rubble');
  add(-46, 0, 1.3, 7, 1.4, 'rubble');
  add(46, 0, 1.3, 7, 1.4, 'rubble');
  add(-74, 2, 1.3, 8, 1.4, 'rubble');
  add(74, -2, 1.3, 8, 1.4, 'rubble');
  add(2, -74, 8, 1.3, 1.4, 'rubble');
  add(-2, 74, 8, 1.3, 1.4, 'rubble');
  add(-70, -8, 2.6, 2.6, 1.6, 'rock');
  add(70, 8, 2.6, 2.6, 1.6, 'rock');
  add(-8, 70, 2.6, 2.6, 1.6, 'rock');
  add(8, -70, 2.6, 2.6, 1.6, 'rock');
  add(-62, -40, 2.6, 2.6, 1.6, 'rock');
  add(62, 40, 2.6, 2.6, 1.6, 'rock');
  add(-40, 62, 2.6, 2.6, 1.6, 'rock');
  add(40, -62, 2.6, 2.6, 1.6, 'rock');

  // ------------------------------------------------------- ground materials
  patch(-22, -22, 22, 22, 'gravel');            // apron around the plinth
  patch(26, -80, 80, -26, 'gravel');            // the Yard
  patch(-45, -45, 45, -35, 'asphalt');          // ring road, north leg
  patch(-45, 35, 45, 45, 'asphalt');            // south leg
  patch(-45, -45, -35, 45, 'asphalt');          // west leg
  patch(35, -45, 45, 45, 'asphalt');            // east leg
  patch(-3.5, -38, 3.5, -18, 'asphalt');        // radials into the centre
  patch(-3.5, 18, 3.5, 38, 'asphalt');
  patch(-38, -3.5, -18, 3.5, 'asphalt');
  patch(18, -3.5, 38, 3.5, 'asphalt');
  patch(-80, 44, -26, 56, 'asphalt');           // the Strip
  patch(-62, 26, -50, 80, 'asphalt');           // the Strip cross road
  patch(-45, 44, -35, 56, 'asphalt');           // Strip -> west ring junction

  // ------------------------------------------------------- props (no collision)
  const treeSpots = [
    [-20, -74], [-8, -70], [18, -70], [34, -22], [58, -24], [74, -20],
    [72, 20], [56, 22], [24, 22], [22, 58], [8, 72], [-16, 70],
    [-24, 24], [-52, 22], [-72, 24], [-74, -22], [-56, -20], [-22, -24],
    [-84, -74], [84, -76], [84, 76], [-84, 78], [-50, -78], [50, -84],
    [-70, 8], [70, -8], [-6, -84], [6, 84], [-84, 40], [84, -40],
    [42, -78], [-42, 80], [-34, -20], [36, -20], [20, -46], [-20, 46],
  ];
  for (const t of treeSpots) prop('tree', t[0], t[1], 0.8, 1.5);
  const poleSpots = [
    [-3.5, -34], [3.5, -22], [-3.5, 22], [3.5, 34], [-34, 3.5], [-22, -3.5],
    [22, 3.5], [34, -3.5], [-41, -41], [41, -41], [41, 41], [-41, 41],
    [-80, 50], [-68, 42], [-52, 58], [-36, 42], [-26, 58],
    [30, -30], [30, 30], [-30, 30], [66, -76], [76, -66], [64, 64], [-64, 64],
    [0, -50], [0, 50], [-50, 0], [50, 0],
  ];
  for (const p of poleSpots) prop('pole', p[0], p[1], 0.9, 1.25);

  // ------------------------------------------------------- spawns
  // Twelve points in the outer band, off every district core and with the
  // plinth parapet (or the stubs behind its gaps) between them and the deck.
  const spawns = [
    { x: -70, z: -80 }, { x: -20, z: -80 }, { x: 20, z: -80 }, { x: 70, z: -80 },
    { x: 80, z: -20 }, { x: 80, z: 20 }, { x: 70, z: 80 }, { x: 20, z: 80 },
    { x: -20, z: 80 }, { x: -70, z: 80 }, { x: -80, z: 20 }, { x: -80, z: -20 },
  ];

  // ------------------------------------------------------- pickups
  // Eight as before plus the prize on the plinth. Health sits on the district
  // edges facing the centre, never out in the open middle.
  const pickups = [
    { id: 0, type: 'shotgun', x: 52, z: -60 },     // deep in the Yard maze
    { id: 1, type: 'shotgun', x: -40, z: -61.5 },  // inside the tenement
    { id: 2, type: 'longshot', x: -76, z: 50 },    // Strip dead end
    { id: 3, type: 'longshot', x: 54, z: 52 },     // out in the open in the Pits
    { id: 4, type: 'health', x: 34, z: -30 },
    { id: 5, type: 'health', x: -30, z: -24 },
    { id: 6, type: 'health', x: -34, z: 30 },
    { id: 7, type: 'health', x: 30, z: 34 },
    { id: 8, type: 'longshot', x: -4.4, z: 0 },    // the prize, on the plinth
  ];

  return { size: SIZE, obstacles, platforms, ground, props, spawns, pickups, pois };
}

// Feet height at (x,z): the dirt plane at 0, or the top of the highest platform
// whose footprint contains the point. Platform tops are always backed by a
// solid box of the same height, so there is never walkable space underneath one
// and this stays a well-defined heightfield.
export function groundHeightAt(x, z, world) {
  const pf = world.platforms;
  if (!pf) return 0;
  let y = 0;
  for (let i = 0; i < pf.length; i++) {
    const p = pf[i];
    if (x < p.x1 || x > p.x2 || z < p.z1 || z > p.z2) continue;
    if (p.y > y) y = p.y;
  }
  return y;
}
