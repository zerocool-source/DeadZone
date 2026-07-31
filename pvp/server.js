// DeadZone: Wasteland PvP — authoritative realtime server.
// One GameServer instance runs per room shard (/ws/<room>); it owns the
// simulation: movement, hitscan, damage, pickups, respawns, match flow.
// Clients only send inputs and render snapshots.
import { DurableObject } from 'cloudflare:workers';

// Shared world definition — the same function is embedded verbatim in
// server.js (which may not import local modules). KEEP THE TWO COPIES
// BYTE-IDENTICAL: collision, spawns and pickups must match on both sides.
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
  // 1.85 clears a 1.55 standing eye, so a wreck actually breaks a sightline
  // instead of sitting in the dead band where it blocks movement but nothing else
  const car = (cx, cz, alongX) =>
    add(cx, cz, alongX ? 4.6 : 2.1, alongX ? 2.1 : 4.6, 1.85, 'car');
  const jersey = (cx, cz, alongX) =>
    add(cx, cz, alongX ? 3.8 : 0.7, alongX ? 0.7 : 3.8, 1.15, 'barrier');
  // same footprint as a jersey, tall enough to hide a standing body behind
  const hesco = (cx, cz, alongX) =>
    add(cx, cz, alongX ? 3.8 : 0.7, alongX ? 0.7 : 3.8, 1.9, 'barrier');
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
  // `wide` is the cross-axis size: it has to match the thing being climbed, or
  // the overhanging lip sits inside the neighbour's push radius and a step onto
  // it shoves the body back off the crate.
  const stack = (cx, cz, dx, dz, top, wide) => {
    const w = wide || 3;
    for (let i = 0; i < top; i++) {
      const o = i * 2.4 + 1.2;
      // 2.5 deep on a 2.4 pitch: every crate overlaps its neighbour by 100 mm
      // so no float seam can open a hole in the heightfield between two steps
      deck(cx + dx * o, cz + dz * o, dx ? 2.5 : w, dz ? 2.5 : w, top - i, 'crate');
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
  // The parapet cap is standable. A jump from the deck (apex 3.88) clears the
  // ring's collision top of 3.4, so a body WILL end up over the cap; if the cap
  // were not a floor it would land inside a solid box and have to be shoved out
  // of it, which throws it off the tower.
  pois.push({ name: 'THE TOWER', x: 0, z: 0 });
  deck(0, 0, 14, 14, 2.6, 'building');
  add(0, 0, 4.2, 4.2, 9.4, 'tower');
  deck(0, -6.5, 13.6, 0.6, 3.6, 'barrier');
  deck(0, 6.5, 13.6, 0.6, 3.6, 'barrier');
  deck(-6.5, 0, 0.6, 13.6, 3.6, 'barrier');
  deck(6.5, 0, 0.6, 13.6, 3.6, 'barrier');
  // butted flush against the parapet face: a gap here reads as deck height,
  // and a body standing in it is inside the crate box and gets ejected
  stack(0, -6.85, 0, -1, 3);                   // climb in from the north,
  stack(6.85, 0, 1, 0, 3);                     // the east
  stack(0, 6.85, 0, 1, 3);                     // or the south

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
  stack(46.5, -43.1, 0, 1, 2, 2.5);            // 2.5 wide = flush with the run
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
  cont(-76, 34, 0); cont(-46, 36, 1);
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
  add(33, 27, 2.8, 2.8, 1.9, 'rock');   // astride the (80,-20)-(-20,80) spawn diagonal
  add(66, 60, 2.4, 2.4, 1.4, 'rock');

  // ------------------------------------------------------- the ring road
  // Every district hangs off this loop, and the four radials run inward from
  // it. Wrecks and barriers along it keep the 90 m straights honest.
  // nothing here may sit inside a district shell: the ring road runs over the
  // depot's footprint, so its furniture stays clear of x -45..-27 on that leg
  car(-22, -40, 1); car(-10, -42, 1); car(20, -43, 1);
  hesco(-24, -43, 1); jersey(6, -37, 1); hesco(34, -38, 1);
  car(43, -27, 0); car(42, -2, 0); car(43, 26, 0);
  hesco(37, -16, 0); hesco(38, 12, 0); jersey(37, 38, 0);
  car(-34, 43, 1); car(-6, 42, 1); car(22, 43, 1);
  hesco(-20, 37, 1); jersey(8, 38, 1); hesco(30, 37, 1);
  car(-43, 30, 0); car(-42, 2, 0); car(-43, -23, 0);
  jersey(-37, 16, 0); hesco(-38, -12, 0); jersey(-37, -24, 0);
  // the eight radial shoulders: 1.75 so a body pinned on a radial has somewhere
  // to break a sightline, not just something to trip over
  add(-8, -30, 5, 1.2, 1.75, 'rubble');
  add(9, -27, 1.2, 5, 1.75, 'rubble');
  add(30, -8, 1.2, 5, 1.75, 'rubble');
  add(27, 9, 5, 1.2, 1.75, 'rubble');
  add(8, 30, 5, 1.2, 1.75, 'rubble');
  add(-9, 27, 1.2, 5, 1.75, 'rubble');
  add(-30, 8, 1.2, 5, 1.75, 'rubble');
  add(-27, -9, 5, 1.2, 1.75, 'rubble');
  // outer band cover, so the run in from a spawn is never a bare 25 m
  add(-62, -14, 1.3, 8, 1.75, 'rubble');
  add(-62, 12, 1.3, 8, 1.75, 'rubble');
  add(62, -12, 1.3, 8, 1.75, 'rubble');
  add(62, 14, 1.3, 8, 1.75, 'rubble');
  add(-14, -62, 8, 1.3, 1.75, 'rubble');
  add(12, -62, 8, 1.3, 1.75, 'rubble');
  add(-12, 62, 8, 1.3, 1.75, 'rubble');
  add(14, 62, 8, 1.3, 1.75, 'rubble');
  // these four straddle the |x| = 80 spawn line the way the |z| = 80 pair does,
  // so the two spawns on each side cannot see each other down it
  add(-80, -14, 2.8, 2.8, 1.8, 'rock');
  add(-80, 14, 2.6, 2.6, 1.6, 'rock');
  add(80, -14, 2.6, 2.6, 1.7, 'rock');
  add(80, 14, 2.8, 2.8, 1.8, 'rock');
  add(-14, -80, 2.6, 2.6, 1.6, 'rock');
  add(14, -80, 2.8, 2.8, 1.8, 'rock');
  add(-14, 80, 2.8, 2.8, 1.7, 'rock');
  add(14, 80, 2.6, 2.6, 1.6, 'rock');
  // and these break the remaining spawn-to-spawn lines: the 50 m pairs along
  // each edge, and the two 160 m runs straight down z = +/-20 from one side of
  // the arena to the other
  add(-45, -80, 3, 3, 2.1, 'rock');
  add(45, -80, 3, 3, 2.1, 'rock');
  add(-45, 80, 3, 3, 2.1, 'rock');
  add(48, 80, 3, 3, 2.1, 'rock');
  add(-55, -20, 3, 3, 2.1, 'rock');
  add(55, -20, 3, 3, 2.1, 'rock');
  add(-55, 20, 3, 3, 2.1, 'rock');
  add(55, 20, 3, 3, 2.1, 'rock');
  add(76, 50, 3, 3, 2.1, 'rock');
  add(0, -46, 7, 1.3, 1.75, 'rubble');
  add(0, 46, 7, 1.3, 1.75, 'rubble');
  add(-46, 0, 1.3, 7, 1.75, 'rubble');
  add(46, 0, 1.3, 7, 1.75, 'rubble');
  add(-74, 2, 1.3, 8, 1.4, 'rubble');
  add(74, -2, 1.3, 8, 1.4, 'rubble');
  add(2, -74, 8, 1.3, 1.4, 'rubble');
  add(-2, 74, 8, 1.3, 1.4, 'rubble');
  add(-70, -8, 2.6, 2.6, 1.6, 'rock');
  add(70, 8, 2.6, 2.6, 1.6, 'rock');
  add(-8, 70, 2.6, 2.6, 1.6, 'rock');
  add(8, -70, 2.6, 2.6, 1.6, 'rock');
  add(-50, -46, 2.6, 2.6, 1.6, 'rock');
  add(62, 40, 2.6, 2.6, 1.6, 'rock');
  add(-36, 62, 2.6, 2.6, 1.6, 'rock');
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
    // the prize, on the plinth. Deliberately NOT the longshot: the deck already
    // sees most of the walkable map, and no bot can climb up to contest it.
    { id: 8, type: 'shotgun', x: -4.4, z: 0 },
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

// --- tuning (mirror of client constants; server values are authoritative)
const TICK_MS = 50;                 // 20 Hz simulation + snapshots
const WALK = 5.2, SPRINT = 7.6, CROUCH_SPEED = 2.5;  // m/s
const STEP_DIST = 2.1;              // metres of travel per footstep event
const GRAV = -22, JUMP_V = 7.5;
const PLAYER_R = 0.45;
const KILL_TARGET = 15;
const RESPAWN_S = 3;
const INTERMISSION_S = 8;
const PICKUP_RESPAWN_S = 25;
const MAX_PLAYERS = 24;
// bots keep the battlefield full: fill to TARGET_COMBATANTS, retire as humans join
const TARGET_COMBATANTS = 20;
const TEAM_TARGET = 75;            // team kills that win the round
// Two squads. A bot's name tells you which side it is on at a glance.
const BOT_NAMES = [
  // team 0 — WOLFPACK (your squad)
  'RUST', 'ASH', 'CROW', 'HOLLOW', 'GRIM', 'SPUR', 'DUST', 'REAPER', 'MULE', 'TICK',
  // team 1 — VULTURES
  'VULTURE', 'JACKAL', 'CINDER', 'RASP', 'GHOUL', 'SCAB', 'MAW', 'BRIAR', 'HUSK', 'VERM',
];
const TEAM_NAMES = ['WOLFPACK', 'VULTURES'];

// ---- air support -----------------------------------------------------------
// Gunships and jets are hazards owned by the server: they fly a scripted path,
// broadcast their transform every tick, and damage whoever is underneath.
const GUNSHIP_EVERY = [38000, 62000];   // ms between gunship sorties
const GUNSHIP_LIFE = 34000;
const GUNSHIP_ALT = 34;
const GUNSHIP_DPS_HIT = 17;             // per burst round that lands
const JET_EVERY = [52000, 84000];       // ms between jet strike runs
const JET_ALT = 58;
const JET_SPEED = 105;
const BOMB_COUNT = 6, BOMB_SPACING = 15, BOMB_RADIUS = 13, BOMB_DMG = 130;
// Difficulty = mechanics. How fast the bot can slew its aim (turn, rad/s), how
// tight a cone it needs before it pulls the trigger (tol), how much its hands
// shake (jitter), how long it takes to react, how well it leads a runner.
const BOT_DIFFS = [
  { react: 620, reactJit: 400, turn: 2.7, gain: 6.5, tol: 0.090, jitter: 0.030,
    burst: 3, burstJit: 2, rest: 520, restJit: 460, lead: 0.35, head: 0.02, nade: 0.4 },
  { react: 380, reactJit: 270, turn: 4.5, gain: 8.5, tol: 0.052, jitter: 0.016,
    burst: 5, burstJit: 3, rest: 380, restJit: 320, lead: 0.70, head: 0.12, nade: 0.6 },
  { react: 210, reactJit: 170, turn: 7.0, gain: 11.0, tol: 0.030, jitter: 0.008,
    burst: 7, burstJit: 4, rest: 260, restJit: 240, lead: 1.00, head: 0.28, nade: 0.8 },
];
// Personality = intent. dist/band is the engagement envelope the bot tries to
// hold, hold is how happy it is to plant instead of dancing around.
const BOT_PERSONAS = [
  { dist: 11, band: 5,  cover: 0.20, flank: 0.15, crouchAt: 34, nade: 0.5, hold: 0.15 }, // pusher
  { dist: 23, band: 7,  cover: 0.72, flank: 0.60, crouchAt: 20, nade: 0.9, hold: 0.45 }, // cover user
  { dist: 38, band: 12, cover: 0.85, flank: 0.10, crouchAt: 15, nade: 0.6, hold: 0.80 }, // camper
];
const S_ROAM = 0, S_ENGAGE = 1, S_COVER = 2, S_RETREAT = 3, S_SEARCH = 4;
const BOT_SIGHT = 80;    // metres a bot can acquire a target at
const BOT_PROBE = 2.6;   // whisker length used to steer around geometry
const BOT_CLEAR = PLAYER_R + 0.3;         // radius a bot wants to keep free
const AVOID_A = [0.62, 1.2, 1.9, 2.7];    // avoidance turns, tried both ways
const TAU = Math.PI * 2;
// shortest signed angle into [-PI, PI)
function angWrap(a) { return a - TAU * Math.floor((a + Math.PI) / TAU); }
const GRENADE_FUSE = 2.2, GRENADE_RADIUS = 7, GRENADE_DMG = 85, GRENADE_CD = 8000;
const WEAPONS = {
  rifle:    { dmg: 16, rpm: 540, range: 80,  pellets: 1, spread: 0.022, mag: 30, reload: 1.8 },
  shotgun:  { dmg: 9,  rpm: 85,  range: 24,  pellets: 8, spread: 0.09,  mag: 6,  reload: 2.4 },
  longshot: { dmg: 70, rpm: 45,  range: 130, pellets: 1, spread: 0.003, mag: 5,  reload: 2.6 },
  // always-carried sidearm: the thing you switch to instead of reloading
  pistol:   { dmg: 22, rpm: 300, range: 45,  pellets: 1, spread: 0.028, mag: 12, reload: 1.3 },
};

// ray vs AABB (slab), returns t or Infinity; boxes rise from y=0 to h.
// Unrolled per axis: this is the hottest function on the server (hitscan and
// every bot line-of-sight query), so it must not allocate.
function rayBox(ox, oy, oz, dx, dy, dz, b) {
  let tmin = 0, tmax = Infinity, t1, t2, t;
  if (dx > -1e-9 && dx < 1e-9) { if (ox < b.x1 || ox > b.x2) return Infinity; }
  else {
    t1 = (b.x1 - ox) / dx; t2 = (b.x2 - ox) / dx;
    if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (dy > -1e-9 && dy < 1e-9) { if (oy < 0 || oy > b.h) return Infinity; }
  else {
    t1 = (0 - oy) / dy; t2 = (b.h - oy) / dy;
    if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  if (dz > -1e-9 && dz < 1e-9) { if (oz < b.z1 || oz > b.z2) return Infinity; }
  else {
    t1 = (b.z1 - oz) / dz; t2 = (b.z2 - oz) / dz;
    if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

// ray vs sphere, returns t or Infinity
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return Infinity;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  if (d2 > r * r) return Infinity;
  return tca - Math.sqrt(r * r - d2);
}

export class GameServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.world = buildWorld();
    this.players = new Map();      // ws -> player
    this.byId = new Map();         // id -> player
    // y is the floor the pickup rests on — the tower prize sits on the deck
    this.pickups = this.world.pickups.map(p => ({
      ...p, y: groundHeightAt(p.x, p.z, this.world), active: true, respawnAt: 0,
    }));
    this.events = [];              // transient, flushed with each snapshot
    this.phase = 'play';           // play | over
    this.winner = null;
    this.phaseEndsAt = 0;
    this.nextId = 1;
    this.timer = null;
    this.grenades = [];
    this.teamKills = [0, 0];
    this.air = [];                 // gunships and jets currently over the map
    this.bombs = [];               // ordnance in flight from a jet run
    this.nextAirId = 1;
    this.scheduleAir(Date.now());

    // Bounding sphere per obstacle (cx, cy, cz, r) — lets a LOS ray reject most
    // boxes in ~10 ops instead of running the full slab test on all of them.
    const obs = this.world.obstacles;
    this.obSph = new Float64Array(obs.length * 4);
    for (let i = 0, j = 0; i < obs.length; i++, j += 4) {
      const b = obs[i];
      const hx = (b.x2 - b.x1) / 2, hy = b.h / 2, hz = (b.z2 - b.z1) / 2;
      this.obSph[j] = b.x1 + hx; this.obSph[j + 1] = hy; this.obSph[j + 2] = b.z1 + hz;
      this.obSph[j + 3] = Math.sqrt(hx * hx + hy * hy + hz * hz);
    }
    // AI navigation data, built lazily on the first bot tick
    this.cover = null;
    this.roam = null;
    // scratch: bot AI runs 20x/s for up to 7 bots, so it must not allocate
    this._sa = { x: 0, y: 0, z: 0 };
    this._dir = [0, 0, 0];
    this._ci = new Int32Array(6);
    this._cs = new Float64Array(6);
    this._sx = 0; this._sz = 0;
  }

  // ---- bots ---------------------------------------------------------------
  humanCount() { return this.players.size; }
  botCount() { return [...this.byId.values()].filter(p => p.bot).length; }

  balanceBots() {
    const want = Math.max(0, Math.min(TARGET_COMBATANTS - this.humanCount(),
      MAX_PLAYERS - this.humanCount()));
    let have = this.botCount();
    while (have < want) {
      const used = new Set([...this.byId.values()].map(p => p.name));
      // name pool is split down the middle so a callsign always reads as a side
      const team = this.thinnestTeam();
      const half = BOT_NAMES.length / 2;
      const pool = team === 0 ? BOT_NAMES.slice(0, half) : BOT_NAMES.slice(half);
      const name = pool.find(n => !used.has(n)) ||
        BOT_NAMES.find(n => !used.has(n)) || ('BOT' + this.nextId);
      const p = this.spawnPlayer(name, team);
      p.bot = true;
      p.diff = BOT_DIFFS[(Math.random() * BOT_DIFFS.length) | 0];
      // one random skill x personality combination per bot
      p.ai = {
        per: BOT_PERSONAS[(Math.random() * BOT_PERSONAS.length) | 0],
        state: S_ROAM, targetId: 0, vis: false, lostAt: -9999, lx: 0, lz: 0,
        // aim: current smoothed angles + angular velocity + tremor + overshoot
        aimYaw: p.yaw, aimPitch: 0, avY: 0, avP: 0, over: 0, overAt: 0,
        jy: 0, jp: 0, jyT: 0, jpT: 0, jitAt: 0, errY: 9, errP: 9,
        turnMul: 0.85 + Math.random() * 0.35, phase: Math.random() * TAU,
        fireAt: 0, nextShotAt: 0, burstLeft: 0, aimHead: false,
        // staggered so the expensive work of 7 bots never lands on one tick
        reacqAt: Math.random() * 300, coverAt: Math.random() * 900,
        nadeAt: Math.random() * 900,
        hurtAt: -9999, lastHp: p.hp,
        hasWp: false, wpX: 0, wpZ: 0, wpAt: 0,
        coverX: 0, coverZ: 0, coverLow: 0, coverUntil: 0,
        peek: false, peekAt: 0, peekSide: 1,
        searchUntil: 0, sweepAt: 0, sweepYaw: 0,
        strafe: Math.random() < 0.5 ? -1 : 1, strafeAt: 0,
        flank: 0, flankUntil: 0, jumpAt: 0,
        avoidA: 0, avoidUntil: 0, avoidSide: Math.random() < 0.5 ? -1 : 1,
        stuck: 0, lastX: p.x, lastZ: p.z, sprinter: Math.random() < 0.5,
      };
      this.byId.set(p.id, p);
      this.events.push(['join', p.id, p.name]);
      have++;
    }
    while (have > want) {
      // retire from the fuller side so leaving humans cannot unbalance the game
      let a = 0, b = 0;
      for (const p of this.byId.values()) (p.team === 0 ? a++ : b++);
      const fat = a > b ? 0 : 1;
      const bot = [...this.byId.values()].find(p => p.bot && p.team === fat) ||
        [...this.byId.values()].find(p => p.bot);
      if (!bot) break;
      this.byId.delete(bot.id);
      this.events.push(['leave', bot.id, bot.name]);
      have--;
    }
  }

  // is the segment origin -> origin + dir*dist blocked by world geometry?
  segBlocked(ox, oy, oz, dx, dy, dz, dist) {
    const sph = this.obSph, obs = this.world.obstacles;
    for (let i = 0, j = 0; i < obs.length; i++, j += 4) {
      const r = sph[j + 3];
      const lx = sph[j] - ox, ly = sph[j + 1] - oy, lz = sph[j + 2] - oz;
      const tca = lx * dx + ly * dy + lz * dz;
      if (tca < -r || tca > dist + r) continue;            // behind, or past the end
      if (lx * lx + ly * ly + lz * lz - tca * tca > r * r) continue;  // misses the sphere
      if (rayBox(ox, oy, oz, dx, dy, dz, obs[i]) < dist) return true;
    }
    return false;
  }

  // line of sight between two players' eye positions
  los(a, b) {
    const ox = a.x, oy = a.y + 1.55, oz = a.z;
    let dx = b.x - ox, dy = (b.y + 1.2) - oy, dz = b.z - oz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return true;
    dx /= dist; dy /= dist; dz /= dist;
    return !this.segBlocked(ox, oy, oz, dx, dy, dz, dist);
  }

  // ---- bot navigation data (static world → built once per room) -----------
  ensureNav() {
    if (this.cover) return;
    const OFF = 1.2, S = this.world.size;
    const cx = [], cz = [], chi = [];
    for (const b of this.world.obstacles) {
      if (b.kind === 'wall' || b.h < 0.9) continue;   // arena shell / ankle height
      const tall = b.h >= 1.7 ? 1 : 0;
      const mx = (b.x1 + b.x2) / 2, mz = (b.z1 + b.z2) / 2;
      for (let k = 0; k < 8; k++) {
        // corners then edge midpoints, pushed OFF metres outside the box
        const x = k === 0 || k === 2 ? b.x1 - OFF : k === 1 || k === 3 ? b.x2 + OFF
          : k === 4 || k === 5 ? mx : k === 6 ? b.x1 - OFF : b.x2 + OFF;
        const z = k === 0 || k === 1 ? b.z1 - OFF : k === 2 || k === 3 ? b.z2 + OFF
          : k === 4 ? b.z1 - OFF : k === 5 ? b.z2 + OFF : mz;
        if (Math.abs(x) > S - 1.5 || Math.abs(z) > S - 1.5) continue;
        if (groundHeightAt(x, z, this.world) > 0) continue;    // on top of a deck
        if (this.blocked(x, z, PLAYER_R + 0.35, 0)) continue;
        cx.push(x); cz.push(z); chi.push(tall);
      }
    }
    this.cover = {
      n: cx.length, x: Float32Array.from(cx), z: Float32Array.from(cz),
      hi: Uint8Array.from(chi),
    };
    // patrol targets: spawn ring, pickups, and an inner ring through the middle.
    // Bots path on the ground plane, so anything standing on a deck or wedged
    // inside geometry is dropped rather than walked into forever.
    const roam = [];
    const okRoam = (x, z) =>
      groundHeightAt(x, z, this.world) === 0 && !this.blocked(x, z, PLAYER_R + 0.2, 0);
    for (const s of this.world.spawns) if (okRoam(s.x, s.z)) roam.push(s.x, s.z);
    for (const pk of this.world.pickups) if (okRoam(pk.x, pk.z)) roam.push(pk.x, pk.z);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      const rx = Math.cos(a) * 26, rz = Math.sin(a) * 26;
      if (okRoam(rx, rz)) roam.push(rx, rz);
    }
    for (const poi of this.world.pois) if (okRoam(poi.x, poi.z)) roam.push(poi.x, poi.z);
    this.roam = Float64Array.from(roam);
  }

  // does a disc of radius r at (x,z) overlap any obstacle a body standing at
  // height y would hit? y matters now: a bot that ends up on a container top
  // must read the container as floor, not as a wall on every side of it.
  blocked(x, z, r, y) {
    const r2 = r * r;
    for (const b of this.world.obstacles) {
      if (y > b.h - 0.2) continue;                 // same rule the mover uses
      const nx = x < b.x1 ? b.x1 : (x > b.x2 ? b.x2 : x);
      const nz = z < b.z1 ? b.z1 : (z > b.z2 ? b.z2 : z);
      const dx = x - nx, dz = z - nz;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  // whisker probe: three overlapping discs along a direction
  pathClear(x, z, dx, dz, len, y) {
    const s = len / 3;
    return !this.blocked(x + dx * s, z + dz * s, BOT_CLEAR, y)
      && !this.blocked(x + dx * s * 2, z + dz * s * 2, BOT_CLEAR, y)
      && !this.blocked(x + dx * len, z + dz * len, BOT_CLEAR, y);
  }

  // nearest active pickup index of a class ('health' or 'weapon'), or -1
  nearestPickup(p, kind, maxD) {
    let best = -1, bestD = maxD;
    for (let i = 0; i < this.pickups.length; i++) {
      const pk = this.pickups[i];
      if (!pk.active) continue;
      if (kind === 'health' ? pk.type !== 'health' : pk.type === 'health') continue;
      if (Math.abs(pk.y - p.y) > 1.2) continue;        // on a deck we cannot path to
      const d = Math.hypot(pk.x - p.x, pk.z - p.z);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ---- bot AI -------------------------------------------------------------
  // nearest visible enemy, sticky toward the one already being fought
  botAcquire(p) {
    let best = null, bestScore = -Infinity;
    for (const o of this.byId.values()) {
      if (o === p || o.hp <= 0) continue;
      if (o.team === p.team) continue;             // squadmates are not targets
      const dx = o.x - p.x, dz = o.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > BOT_SIGHT * BOT_SIGHT) continue;
      let sc = -Math.sqrt(d2);
      if (o.id === p.ai.targetId) sc += 12;
      if (o.hp < 40) sc += 10;
      if (sc <= bestScore) continue;
      if (!this.los(p, o)) continue;
      bestScore = sc; best = o;
    }
    return best;
  }

  // pick a spot that breaks line of sight from (tx,tz); bounded scan, then at
  // most six LOS rays. Returns true and stores it on the bot's ai.
  pickCover(p, tx, ty, tz) {
    const c = this.cover, ai = p.ai;
    if (!c || c.n === 0) return false;
    const idx = this._ci, sco = this._cs, K = idx.length;
    let m = 0;
    let ax = p.x - tx, az = p.z - tz;
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;                                  // away from the threat
    for (let i = 0; i < c.n; i++) {
      const dx = c.x[i] - p.x, dz = c.z[i] - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 169 || d2 < 1.5) continue;                // 1.2 .. 13 m from here
      const tdx = c.x[i] - tx, tdz = c.z[i] - tz;
      if (tdx * tdx + tdz * tdz < 49) continue;          // not in the enemy's lap
      const s = (dx * ax + dz * az) * 0.6 - Math.sqrt(d2) * 0.5 + (c.hi[i] ? 1.5 : 0);
      if (m < K) {
        let j = m++;
        while (j > 0 && sco[j - 1] < s) { sco[j] = sco[j - 1]; idx[j] = idx[j - 1]; j--; }
        sco[j] = s; idx[j] = i;
      } else if (s > sco[K - 1]) {
        let j = K - 1;
        while (j > 0 && sco[j - 1] < s) { sco[j] = sco[j - 1]; idx[j] = idx[j - 1]; j--; }
        sco[j] = s; idx[j] = i;
      }
    }
    const sa = this._sa;
    for (let k = 0; k < m; k++) {
      const i = idx[k];
      // the threat's eye is ty + 1.55, not 1.55: assuming ground level picks
      // spots in plain view of anyone holding a deck
      sa.x = c.x[i]; sa.z = c.z[i];
      sa.y = groundHeightAt(c.x[i], c.z[i], this.world) + 0.2;  // chest height there
      if (this.losPoint(tx, ty + 1.55, tz, sa)) continue; // still exposed there
      ai.coverX = c.x[i]; ai.coverZ = c.z[i]; ai.coverLow = c.hi[i] ? 0 : 1;
      return true;
    }
    return false;
  }

  // steer a desired world direction around geometry; result in _sx/_sz
  steer(p, dx, dz, now) {
    const ai = p.ai;
    if (now < ai.avoidUntil) {
      // stay committed to the turn for a moment, otherwise bots shuffle
      const ca = Math.cos(ai.avoidA), sa = Math.sin(ai.avoidA);
      const rx = dx * ca - dz * sa, rz = dx * sa + dz * ca;
      if (this.pathClear(p.x, p.z, rx, rz, BOT_PROBE, p.y)) { this._sx = rx; this._sz = rz; return; }
      ai.avoidUntil = 0;
    }
    if (this.pathClear(p.x, p.z, dx, dz, BOT_PROBE, p.y)) { this._sx = dx; this._sz = dz; return; }
    for (let i = 0; i < AVOID_A.length; i++) {
      for (let s = 0; s < 2; s++) {
        const a = AVOID_A[i] * (s === 0 ? ai.avoidSide : -ai.avoidSide);
        const ca = Math.cos(a), sa = Math.sin(a);
        const rx = dx * ca - dz * sa, rz = dx * sa + dz * ca;
        if (!this.pathClear(p.x, p.z, rx, rz, BOT_PROBE, p.y)) continue;
        ai.avoidA = a; ai.avoidUntil = now + 320;
        this._sx = rx; this._sz = rz;
        return;
      }
    }
    // Boxed in. A bot that wandered up onto a platform sees walls on every side
    // (the parapet, the next container) and would shuffle there forever, so
    // walk it at the nearest edge and let it fall back to the ground plane.
    if (p.y > 0.05) {
      for (let i = 0; i < 8; i++) {
        const a = i * (TAU / 8), cx = Math.cos(a), cz = Math.sin(a);
        if (groundHeightAt(p.x + cx * 1.6, p.z + cz * 1.6, this.world) < p.y - 0.05) {
          this._sx = cx; this._sz = cz;
          return;
        }
      }
    }
    this._sx = -dx; this._sz = -dz;   // boxed in: back out
  }

  // turn the aim toward (yawT,pitchT) at a limited rate, with tremor and a
  // small flick overshoot. Leaves the residual error in ai.errY/errP.
  aimToward(p, dt, yawT, pitchT, now) {
    const ai = p.ai, d = p.diff;
    if (now >= ai.jitAt) {
      ai.jitAt = now + 140 + Math.random() * 260;
      ai.jyT = (Math.random() - 0.5) * 2 * d.jitter;
      ai.jpT = (Math.random() - 0.5) * 2 * d.jitter * 0.7;
    }
    const k = Math.min(1, dt * 6);
    ai.jy += (ai.jyT - ai.jy) * k;
    ai.jp += (ai.jpT - ai.jp) * k;

    let dy = angWrap(yawT + ai.jy + ai.over - ai.aimYaw);
    if (Math.abs(dy) > 0.5 && now >= ai.overAt) {
      ai.over = (dy > 0 ? 1 : -1) * (0.02 + Math.random() * 0.06);
      ai.overAt = now + 500;
      dy = angWrap(yawT + ai.jy + ai.over - ai.aimYaw);
    }
    ai.over -= ai.over * Math.min(1, dt * 4);
    const maxV = d.turn * ai.turnMul;
    let want = dy * d.gain;
    if (want > maxV) want = maxV; else if (want < -maxV) want = -maxV;
    ai.avY += (want - ai.avY) * Math.min(1, dt * 14);
    ai.aimYaw = angWrap(ai.aimYaw + ai.avY * dt);

    const maxP = maxV * 0.8;
    let wantP = (pitchT + ai.jp - ai.aimPitch) * d.gain;
    if (wantP > maxP) wantP = maxP; else if (wantP < -maxP) wantP = -maxP;
    ai.avP += (wantP - ai.avP) * Math.min(1, dt * 14);
    ai.aimPitch += ai.avP * dt;
    if (ai.aimPitch > 1.2) ai.aimPitch = 1.2;
    else if (ai.aimPitch < -1.2) ai.aimPitch = -1.2;

    ai.errY = Math.abs(angWrap(yawT - ai.aimYaw));
    ai.errP = Math.abs(pitchT - ai.aimPitch);
    p.yaw = ai.aimYaw; p.pitch = ai.aimPitch;
  }

  // lob a grenade at (tx,tz); the vertical share of the throw vector is tuned
  // against SPEED/GRAV/fuse in throwGrenade + tickGrenades
  botNade(p, tx, tz, dist) {
    let dx = tx - p.x, dz = tz - p.z;
    const h = Math.hypot(dx, dz);
    if (h < 1e-3) return;
    dx /= h; dz /= h;
    const sa = this._sa;
    sa.x = p.x + dx * 2.5; sa.y = 1.0; sa.z = p.z + dz * 2.5;
    if (!this.losPoint(p.x, p.y + 1.5, p.z, sa)) return;   // would bounce back
    let s = (dist - 8.8) / 20;
    if (s < 0) s = 0; else if (s > 0.62) s = 0.62;
    const c = Math.sqrt(1 - s * s), v = this._dir;
    v[0] = dx * c; v[1] = s; v[2] = dz * c;
    this.throwGrenade(p, v);
  }

  botThink(p, dt, now) {
    this.ensureNav();
    const ai = p.ai, d = p.diff, per = ai.per, inp = p.input;
    inp.mx = 0; inp.mz = 0; inp.sprint = false; inp.jump = false; inp.crouch = false;

    if (p.hp < ai.lastHp) { ai.hurtAt = now; ai.reacqAt = 0; }   // took a hit
    ai.lastHp = p.hp;

    // --- target: sticky while visible, staggered re-acquire otherwise
    let tgt = ai.targetId ? this.byId.get(ai.targetId) : null;
    if (tgt && (tgt.hp <= 0 || tgt === p)) { tgt = null; ai.targetId = 0; }
    let vis = tgt ? this.los(p, tgt) : false;
    if (!vis && now >= ai.reacqAt) {
      ai.reacqAt = now + 240 + Math.random() * 260;
      const nt = this.botAcquire(p);
      if (nt) { tgt = nt; vis = true; }
    }
    if (vis) {
      const fresh = tgt.id !== ai.targetId;
      if (fresh || !ai.vis) {
        const full = d.react + Math.random() * d.reactJit;
        ai.fireAt = now + (fresh || now - ai.lostAt > 800 ? full : full * 0.35);
        ai.burstLeft = 0;
        ai.aimHead = Math.random() < d.head;
        if (fresh) {
          ai.flank = Math.random() < per.flank ? (Math.random() < 0.5 ? -1 : 1) : 0;
          ai.flankUntil = now + 2200 + Math.random() * 2800;
        }
      }
      ai.targetId = tgt.id;
      ai.lx = tgt.x; ai.lz = tgt.z;
    } else if (ai.vis) {
      ai.lostAt = now;
    }
    ai.vis = vis;
    const dist = tgt ? Math.hypot(tgt.x - p.x, tgt.z - p.z) : 0;

    // --- state machine
    let st = ai.state;
    const hurt = now - ai.hurtAt < 1500;
    // 55 m cap: a medkit on the far side of the arena is not worth the walk
    const healI = p.hp < 70 ? this.nearestPickup(p, 'health', 55) : -1;
    if (p.hp <= 35 && healI >= 0) {
      st = S_RETREAT;
    } else if (st === S_RETREAT) {
      st = vis ? S_ENGAGE : (tgt ? S_SEARCH : S_ROAM);
      if (st === S_SEARCH) ai.searchUntil = now + 2500;
    }
    if (st !== S_RETREAT) {
      if (st === S_COVER && (!tgt || now >= ai.coverUntil)) st = vis ? S_ENGAGE : S_ROAM;
      if (st !== S_COVER) {
        if (vis) {
          st = S_ENGAGE;
          // reloading or bleeding: the tactical types break contact
          if (now >= ai.coverAt && (p.reloading > 0 || hurt)) {
            const ok = Math.random() < per.cover && this.pickCover(p, tgt.x, tgt.y, tgt.z);
            ai.coverAt = now + (ok ? 5000 : 1400);
            if (ok) {
              st = S_COVER;
              ai.coverUntil = now + 3000 + Math.random() * 3000;
              ai.peek = false;
              ai.peekAt = now + 700 + Math.random() * 700;
              ai.peekSide = Math.random() < 0.5 ? -1 : 1;
            }
          }
        } else if (tgt && now - ai.lostAt < 7000) {
          if (st !== S_SEARCH) { st = S_SEARCH; ai.searchUntil = now + 3000 + Math.random() * 2500; }
          else if (now >= ai.searchUntil) { st = S_ROAM; ai.targetId = 0; tgt = null; }
        } else {
          if (st !== S_ROAM) ai.hasWp = false;
          st = S_ROAM; ai.targetId = 0; tgt = null;
        }
      }
    }
    ai.state = st;

    // --- what the state wants: a move vector, a facing, and firing rights
    let mvx = 0, mvz = 0, mvScale = 0;
    let gx = 0, gz = 0, stopAt = 0, hasGoal = false;
    let faceMove = true, fireOk = false, crouch = false, sprint = false;
    let yawT = ai.aimYaw, pitchT = 0;

    if (st === S_ENGAGE && tgt) {
      const ux = (tgt.x - p.x) / (dist || 1), uz = (tgt.z - p.z) / (dist || 1);
      let want = per.dist;
      if (p.weapon === 'shotgun') want = Math.min(want, 9);
      else if (p.weapon === 'longshot') want = Math.max(want, 30);
      let radial = 0;
      if (dist > want + per.band) radial = 1;
      else if (dist < want - per.band) radial = -1;
      if (now >= ai.strafeAt) { ai.strafe = -ai.strafe; ai.strafeAt = now + 700 + Math.random() * 1300; }
      if (ai.flank && now < ai.flankUntil && dist > 7) {
        // swing wide instead of walking straight down the sightline
        const a = ai.flank * 1.25, ca = Math.cos(a), sa = Math.sin(a);
        mvx = ux * ca - uz * sa; mvz = ux * sa + uz * ca; mvScale = 1;
      } else {
        const lat = (1 - per.hold) * (radial === 0 ? 0.9 : 0.5) * ai.strafe;
        mvx = ux * radial - uz * lat;
        mvz = uz * radial + ux * lat;
        const l = Math.hypot(mvx, mvz);
        if (l > 1e-3) { mvx /= l; mvz /= l; mvScale = Math.min(1, l); }
      }
      fireOk = true; faceMove = false;
      crouch = radial === 0 && dist > per.crouchAt;
      // LOS is measured standing: don't duck behind waist-high rubble and then
      // shoot into it — a human would notice and stay up
      if (crouch && !this.losPoint(p.x, p.y + 1.1, p.z, tgt)) crouch = false;
      // sprint only to close a big gap, and never mid-burst
      sprint = radial > 0 && dist > want + 14 && (now < ai.fireAt || now < ai.nextShotAt);
      if (radial > 0 && dist > 6 && dist < 22 && now >= ai.jumpAt && Math.random() < 0.03) {
        inp.jump = true; ai.jumpAt = now + 2200 + Math.random() * 3500;
      }
    } else if (st === S_COVER) {
      if (now >= ai.peekAt) {
        ai.peek = !ai.peek;
        ai.peekAt = now + (ai.peek ? 900 + Math.random() * 900 : 800 + Math.random() * 1000);
      }
      if (p.reloading > 0) ai.peek = false;              // finish the reload down
      gx = ai.coverX; gz = ai.coverZ;
      if (ai.peek && tgt) {
        // lean out perpendicular to the cover -> threat line
        let nx = tgt.x - ai.coverX, nz = tgt.z - ai.coverZ;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;
        gx += -nz * ai.peekSide * 1.2; gz += nx * ai.peekSide * 1.2;
      }
      hasGoal = true; stopAt = 0.5;
      const toCover = Math.hypot(gx - p.x, gz - p.z);
      sprint = toCover > 6;
      crouch = !ai.peek && toCover < 1.5;
      fireOk = ai.peek;
      if (tgt) {
        faceMove = false;                                 // watch the threat's lane
        yawT = Math.atan2(-(ai.lx - p.x), -(ai.lz - p.z));
      }
    } else if (st === S_RETREAT) {
      const pk = healI >= 0 ? this.pickups[healI] : null;   // guarded: see above
      if (pk) { gx = pk.x; gz = pk.z; hasGoal = true; stopAt = 0.8; sprint = true; }
      fireOk = vis && dist < 20;
      if (fireOk) faceMove = false;
    } else if (st === S_SEARCH) {
      gx = ai.lx; gz = ai.lz; hasGoal = true; stopAt = 2.2;
      const toLast = Math.hypot(gx - p.x, gz - p.z);
      sprint = toLast > 10 && per.hold < 0.5;
      if (toLast <= stopAt) {
        // arrived: sweep the area in discrete head turns
        if (now >= ai.sweepAt) {
          ai.sweepAt = now + 800 + Math.random() * 900;
          ai.sweepYaw = angWrap(ai.aimYaw + (Math.random() < 0.5 ? -1 : 1) * (0.7 + Math.random() * 0.8));
        }
        yawT = ai.sweepYaw; faceMove = false;
      }
    } else {
      // ROAM: heal first, then grab a better gun, otherwise patrol
      if (!ai.hasWp || now >= ai.wpAt ||
          (p.x - ai.wpX) * (p.x - ai.wpX) + (p.z - ai.wpZ) * (p.z - ai.wpZ) < 6) {
        ai.hasWp = true; ai.wpAt = now + 14000;
        let i = healI >= 0 && p.hp < 70 ? healI : -1;
        if (i < 0 && p.weapon === 'rifle') i = this.nearestPickup(p, 'weapon', 55);
        if (i >= 0) { ai.wpX = this.pickups[i].x; ai.wpZ = this.pickups[i].z; }
        else {
          const r = this.roam, k = ((Math.random() * (r.length >> 1)) | 0) << 1;
          ai.wpX = r[k]; ai.wpZ = r[k + 1];
        }
      }
      gx = ai.wpX; gz = ai.wpZ; hasGoal = true; stopAt = 1.2;
      sprint = ai.sprinter;
    }

    if (hasGoal) {
      const ddx = gx - p.x, ddz = gz - p.z;
      const dl = Math.hypot(ddx, ddz);
      if (dl > stopAt) { mvx = ddx / dl; mvz = ddz / dl; mvScale = 1; }
      else { mvScale = 0; sprint = false; }
    }

    // --- steer around geometry, then aim, then convert to local input
    if (mvScale > 0.01) {
      this.steer(p, mvx, mvz, now);
      mvx = this._sx; mvz = this._sz;
    }
    inp.crouch = crouch;

    if (tgt && vis && !faceMove) {
      // lead the target a little: bullets are hitscan, this just reads as intent
      const lead = Math.min(0.25, dist / 200) * d.lead;
      const ddx = (tgt.x + tgt.vx * lead) - p.x;
      const ddz = (tgt.z + tgt.vz * lead) - p.z;
      const flat = Math.hypot(ddx, ddz) || 1e-3;
      const aimY = tgt.y + (tgt.input.crouch ? 0.72 : (ai.aimHead ? 1.6 : 1.05));
      yawT = Math.atan2(-ddx, -ddz);
      pitchT = Math.atan2(aimY - (p.y + (crouch ? 1.1 : 1.55)), flat);
    } else if (faceMove && mvScale > 0.01) {
      yawT = angWrap(Math.atan2(-mvx, -mvz) + Math.sin(now / 1400 + ai.phase) * 0.35);
    }
    this.aimToward(p, dt, yawT, pitchT, now);

    if (mvScale > 0.01) {
      const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
      // inverse of the movement transform in tick(): right = (cos,-sin)
      inp.mx = (mvx * cos - mvz * sin) * mvScale;
      inp.mz = (-mvx * sin - mvz * cos) * mvScale;
      // never sprint and shoot: gate on being ready to pull the trigger this
      // tick, not on merely being allowed to (fireOk is always true in ENGAGE)
      inp.sprint = sprint && !crouch &&
        !(fireOk && vis && now >= ai.fireAt && now >= ai.nextShotAt);
    }

    // --- shooting: only inside the aim cone, in bursts, after the reaction.
    // faceMove states aim down their path, so they must never pull the trigger.
    const w = WEAPONS[p.weapon];
    if (fireOk && !faceMove && vis && tgt && this.phase === 'play' && now >= ai.fireAt &&
        now >= ai.nextShotAt && p.reloading <= 0 && p.mag > 0 && dist < w.range * 0.9 &&
        ai.errY < d.tol && ai.errP < d.tol * 1.6) {
      if (ai.burstLeft <= 0) {
        ai.burstLeft = p.weapon === 'rifle' ? d.burst + ((Math.random() * d.burstJit) | 0)
          : (p.weapon === 'shotgun' ? 2 : 1);
      }
      const cp = Math.cos(ai.aimPitch), v = this._dir;
      v[0] = -Math.sin(ai.aimYaw) * cp;
      v[1] = Math.sin(ai.aimPitch);
      v[2] = -Math.cos(ai.aimYaw) * cp;
      const before = p.lastFire;
      this.fire(p, v);
      if (p.lastFire !== before && --ai.burstLeft <= 0) {
        ai.nextShotAt = now + d.rest + Math.random() * d.restJit;
        ai.aimHead = Math.random() < d.head;
      }
    }

    // --- reload discipline: top up when nobody has eyes on us
    if (p.reloading <= 0 && p.mag < w.mag * 0.3 && (!vis || st === S_COVER || dist > 45)) {
      p.reloading = w.reload;
      this.events.push(['reload', p.id]);
    }

    // --- grenades: flush out cover, or soften a mid-range fight
    if (tgt && now >= ai.nadeAt && this.phase === 'play') {
      ai.nadeAt = now + 900;
      const gx2 = vis ? tgt.x : ai.lx, gz2 = vis ? tgt.z : ai.lz;
      const gd = Math.hypot(gx2 - p.x, gz2 - p.z);
      const known = vis || now - ai.lostAt < 3000;
      // 26 m is about as far as the arc + roll reaches before the fuse ends
      if (known && gd > 12 && gd < 26 && now - (p.lastNade || 0) >= GRENADE_CD &&
          Math.random() < per.nade * d.nade * (vis ? 0.35 : 1)) {
        this.botNade(p, gx2, gz2, gd);
      }
    }

    // --- stuck watchdog: wanted to move but did not, so ditch the plan
    if (mvScale > 0.1) {
      // measure against what was actually commanded: a crouched micro-strafe is
      // slower than any fixed floor by design and must not read as wedged
      const cmd = mvScale * (crouch ? CROUCH_SPEED : (inp.sprint ? SPRINT : WALK)) * dt * 0.35;
      const sdx = p.x - ai.lastX, sdz = p.z - ai.lastZ;
      if (sdx * sdx + sdz * sdz < cmd * cmd) ai.stuck += dt; else ai.stuck = 0;
    } else ai.stuck = 0;
    ai.lastX = p.x; ai.lastZ = p.z;
    if (ai.stuck > 1.2) {
      ai.stuck = 0; ai.hasWp = false; ai.strafe = -ai.strafe;
      ai.avoidSide = -ai.avoidSide;
      ai.avoidA = ai.avoidSide * (1.6 + Math.random());
      ai.avoidUntil = now + 700;
    }
  }

  // ---- grenades -----------------------------------------------------------
  throwGrenade(p, d) {
    const now = Date.now();
    if (p.hp <= 0 || this.phase !== 'play') return;
    if (now - (p.lastNade || 0) < GRENADE_CD) return;
    if (!Array.isArray(d) || d.length !== 3 || d.some(v => !Number.isFinite(v))) return;
    let [dx, dy, dz] = d;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    dx /= len; dy /= len; dz /= len;
    p.lastNade = now;
    const SPEED = 16;
    this.grenades.push({
      x: p.x + dx * 0.6, y: p.y + 1.5, z: p.z + dz * 0.6,
      vx: dx * SPEED, vy: dy * SPEED + 3.5, vz: dz * SPEED,
      fuse: GRENADE_FUSE, owner: p.id,
    });
    this.events.push(['nade', p.id]);
  }

  tickGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      const wasY = g.y;
      g.fuse -= dt;
      g.vy += GRAV * dt;
      g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
      // rest on whatever floor is underneath, but only bounce when the grenade
      // crossed that surface from above — otherwise one flying past the side of
      // a platform would be flicked up onto its roof
      const fy = groundHeightAt(g.x, g.z, this.world) + 0.12;
      if (g.y <= fy && g.vy < 0 && wasY >= fy) {
        g.y = fy; g.vy = -g.vy * 0.45; g.vx *= 0.7; g.vz *= 0.7;
      }
      // dirt backstop: a grenade that rolls under a platform edge fails the
      // wasY test forever after, so without this it free-falls out of the world
      // and detonates tens of metres down where it can hit nothing
      if (g.y < 0.12) {
        g.y = 0.12;
        if (g.vy < 0) g.vy = -g.vy * 0.45;
        g.vx *= 0.7; g.vz *= 0.7;
      }
      // wall bounce: push out of AABBs, reflect the bigger axis velocity
      for (const b of this.world.obstacles) {
        if (g.y > b.h) continue;
        const nx = Math.max(b.x1, Math.min(g.x, b.x2));
        const nz = Math.max(b.z1, Math.min(g.z, b.z2));
        const ddx = g.x - nx, ddz = g.z - nz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < 0.04 && d2 > 1e-9) {
          const dist = Math.sqrt(d2);
          g.x = nx + (ddx / dist) * 0.2; g.z = nz + (ddz / dist) * 0.2;
          if (Math.abs(ddx) > Math.abs(ddz)) g.vx = -g.vx * 0.5; else g.vz = -g.vz * 0.5;
        }
      }
      const S = this.world.size;
      g.x = Math.max(-S + 0.3, Math.min(S - 0.3, g.x));
      g.z = Math.max(-S + 0.3, Math.min(S - 0.3, g.z));
      if (g.fuse <= 0) {
        this.grenades.splice(i, 1);
        this.events.push(['boom', +g.x.toFixed(1), +g.y.toFixed(1), +g.z.toFixed(1)]);
        const owner = this.byId.get(g.owner);
        for (const o of this.byId.values()) {
          if (o.hp <= 0) continue;
          const d = Math.hypot(o.x - g.x, (o.y + 1) - g.y, o.z - g.z);
          if (d > GRENADE_RADIUS) continue;
          // half damage through walls
          const blocked = !this.losPoint(g.x, Math.max(0.4, g.y), g.z, o);
          const dmg = Math.round(GRENADE_DMG * (1 - d / GRENADE_RADIUS) * (blocked ? 0.35 : 1));
          if (dmg <= 0) continue;
          o.hp -= dmg;
          this.events.push(['hit', g.owner, o.id, dmg, 0]);
          if (o.hp <= 0 && owner && owner !== o) this.onKill(owner, o);
          else if (o.hp <= 0) { o.hp = 0; o.deaths++; o.respawn = RESPAWN_S; this.events.push(['kill', o.id, o.id, 'grenade']); }
        }
      }
    }
  }

  losPoint(x, y, z, o) {
    let dx = o.x - x, dy = (o.y + 1) - y, dz = o.z - z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return true;
    dx /= dist; dy /= dist; dz /= dist;
    return !this.segBlocked(x, y, z, dx, dy, dz, dist);
  }

  fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, ws] = Object.values(pair);
    ws.accept();
    ws.addEventListener('message', e => this.onMessage(ws, e));
    ws.addEventListener('close', () => this.onClose(ws));
    ws.addEventListener('error', () => this.onClose(ws));
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws, e) {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const p = this.players.get(ws);

    if (m.t === 'j' && !p) {                         // join
      if (this.players.size >= MAX_PLAYERS) {
        try { ws.send(JSON.stringify({ t: 'full' })); ws.close(); } catch {}
        return;
      }
      const player = this.spawnPlayer(String(m.name || '').slice(0, 14) || 'DRIFTER');
      this.players.set(ws, player);
      this.byId.set(player.id, player);
      this.events.push(['join', player.id, player.name]);
      try {
        ws.send(JSON.stringify({ t: 'w', id: player.id, killTarget: KILL_TARGET,
          team: player.team, teamTarget: TEAM_TARGET, teamNames: TEAM_NAMES }));
      } catch {}
      this.balanceBots();
      this.startTicking();
      return;
    }
    if (!p) return;

    if (m.t === 'i') {                               // input state
      const num = v => (Number.isFinite(v) ? v : 0);
      p.input.mx = Math.max(-1, Math.min(1, num(m.mx)));
      p.input.mz = Math.max(-1, Math.min(1, num(m.mz)));
      p.input.sprint = !!m.sp;
      p.input.jump = !!m.jp;
      p.input.crouch = !!m.cr;
      p.yaw = num(m.yaw) % (Math.PI * 2);
      p.pitch = Math.max(-1.55, Math.min(1.55, num(m.pitch)));
    } else if (m.t === 'f') {                        // fire
      this.fire(p, m.d);
    } else if (m.t === 'g') {                        // grenade
      this.throwGrenade(p, m.d);
    } else if (m.t === 'r') {                        // reload
      const w = WEAPONS[p.weapon];
      if (p.hp > 0 && !p.reloading && p.mag < w.mag) {
        p.reloading = w.reload;
        this.events.push(['reload', p.id]);
      }
    } else if (m.t === 'sw') {                       // switch weapon slot
      this.switchSlot(p, m.i | 0);
    }
  }

  onClose(ws) {
    const p = this.players.get(ws);
    if (p) {
      this.players.delete(ws);
      this.byId.delete(p.id);
      this.events.push(['leave', p.id, p.name]);
    }
    if (this.players.size === 0) {
      // room empty: drop bots and stop the clock
      for (const b of [...this.byId.values()]) if (b.bot) this.byId.delete(b.id);
      this.grenades = [];
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    } else {
      this.balanceBots();
    }
  }

  startTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  spawnPlayer(name, team) {
    const p = {
      id: this.nextId++, name,
      team: team === undefined ? this.thinnestTeam() : team,
      x: 0, y: 0, z: 0, vy: 0, yaw: 0, pitch: 0,
      px: 0, pz: 0, vx: 0, vz: 0,        // last tick position + planar velocity
      hp: 100, kills: 0, deaths: 0,
      // two carried weapons; slot 0 is the one in your hands
      slots: [
        { weapon: 'rifle', mag: WEAPONS.rifle.mag },
        { weapon: 'pistol', mag: WEAPONS.pistol.mag },
      ],
      slot: 0,
      weapon: 'rifle', mag: WEAPONS.rifle.mag, reloading: 0,
      respawn: 0, lastFire: 0, switchAt: 0,
      input: { mx: 0, mz: 0, sprint: false, jump: false, crouch: false },
      speedNorm: 0, stepAcc: 0, airborne: false,
    };
    this.placeAtSpawn(p);
    return p;
  }

  // keep the sides even; ties go to the side the fewest humans are on
  thinnestTeam() {
    let a = 0, b = 0;
    for (const p of this.byId.values()) (p.team === 0 ? a++ : b++);
    return a <= b ? 0 : 1;
  }

  // mirror the live slot back into the flat fields the rest of the sim reads
  syncSlot(p) {
    const s = p.slots[p.slot];
    p.weapon = s.weapon;
    p.mag = s.mag;
  }
  stashSlot(p) { p.slots[p.slot].mag = p.mag; p.slots[p.slot].weapon = p.weapon; }

  switchSlot(p, i) {
    const now = Date.now();
    if (p.hp <= 0 || i === p.slot || i < 0 || i >= p.slots.length) return;
    if (now < p.switchAt) return;
    this.stashSlot(p);
    p.slot = i;
    p.reloading = 0;
    p.switchAt = now + 450;              // swap time; also gates spam
    p.lastFire = now + 200;              // can't fire mid-swap
    this.syncSlot(p);
    this.events.push(['swap', p.id, p.weapon]);
  }

  placeAtSpawn(p) {
    // furthest spawn from living enemies
    let best = this.world.spawns[0], bestD = -1;
    for (const s of this.world.spawns) {
      let d = Infinity;
      for (const o of this.byId.values()) {
        if (o === p || o.hp <= 0) continue;
        d = Math.min(d, Math.hypot(s.x - o.x, s.z - o.z));
      }
      if (d === Infinity) d = Math.random() * 100; // empty room: any spawn
      if (d > bestD) { bestD = d; best = s; }
    }
    p.x = best.x; p.z = best.z; p.y = groundHeightAt(best.x, best.z, this.world); p.vy = 0;
    p.yaw = Math.atan2(-best.x, -best.z); // face the center
    // the only teleport in the sim: reset velocity tracking and any bot plan
    p.px = p.x; p.pz = p.z; p.vx = 0; p.vz = 0;
    const ai = p.ai;
    if (ai) {
      ai.state = S_ROAM; ai.targetId = 0; ai.vis = false; ai.hasWp = false;
      ai.aimYaw = p.yaw; ai.aimPitch = 0; ai.avY = 0; ai.avP = 0; ai.over = 0;
      ai.burstLeft = 0; ai.stuck = 0; ai.lastX = p.x; ai.lastZ = p.z;
      ai.lastHp = 100; ai.hurtAt = -9999; ai.lostAt = -9999; ai.avoidUntil = 0;
    }
  }

  fire(p, d) {
    if (p.hp <= 0 || p.reloading > 0 || this.phase !== 'play') return;
    const w = WEAPONS[p.weapon];
    const now = Date.now();
    if (now - p.lastFire < (60000 / w.rpm) * 0.9) return;   // server-side rate cap
    if (p.mag <= 0) return;
    if (!Array.isArray(d) || d.length !== 3 || d.some(v => !Number.isFinite(v))) return;
    let [dx, dy, dz] = d;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    dx /= len; dy /= len; dz /= len;
    p.lastFire = now;
    p.mag--;
    this.events.push(['shot', p.id, p.weapon, [+dx.toFixed(2), +dy.toFixed(2), +dz.toFixed(2)]]);

    const ox = p.x, oy = p.y + (p.input.crouch ? 1.1 : 1.55), oz = p.z;
    for (let n = 0; n < w.pellets; n++) {
      const jx = dx + (Math.random() - 0.5) * 2 * w.spread;
      const jy = dy + (Math.random() - 0.5) * 2 * w.spread;
      const jz = dz + (Math.random() - 0.5) * 2 * w.spread;
      const jl = Math.hypot(jx, jy, jz);
      const rx = jx / jl, ry = jy / jl, rz = jz / jl;

      let wallT = w.range;
      for (const b of this.world.obstacles) {
        const t = rayBox(ox, oy, oz, rx, ry, rz, b);
        if (t < wallT) wallT = t;
      }
      let hit = null, hitT = wallT, head = false;
      for (const o of this.byId.values()) {
        if (o === p || o.hp <= 0) continue;
        if (o.team === p.team) continue;                  // no friendly fire
        const low = o.input.crouch;                       // crouching = smaller target
        const tb = raySphere(ox, oy, oz, rx, ry, rz, o.x, o.y + (low ? 0.68 : 1.0), o.z, low ? 0.48 : 0.55);
        const th = raySphere(ox, oy, oz, rx, ry, rz, o.x, o.y + (low ? 1.15 : 1.62), o.z, 0.3);
        const t = Math.min(tb, th);
        if (t < hitT) { hitT = t; hit = o; head = th < tb; }
      }
      if (hit) {
        const dmg = Math.round(w.dmg * (head ? 1.5 : 1));
        hit.hp -= dmg;
        this.events.push(['hit', p.id, hit.id, dmg, +head]);
        if (hit.hp <= 0) this.onKill(p, hit);
      }
    }
    this.stashSlot(p);
    if (p.mag === 0) { p.reloading = w.reload; this.events.push(['reload', p.id]); }
  }

  // ---- air support ---------------------------------------------------------
  // Everything here is server-owned: the client only draws what the snapshot
  // says. Air units damage BOTH teams — they are weather with guns.
  scheduleAir(now) {
    this.nextGunship = now + GUNSHIP_EVERY[0] +
      Math.random() * (GUNSHIP_EVERY[1] - GUNSHIP_EVERY[0]);
    this.nextJet = now + JET_EVERY[0] +
      Math.random() * (JET_EVERY[1] - JET_EVERY[0]);
  }

  spawnGunship(now) {
    const S = this.world.size;
    this.air.push({
      kind: 'heli', id: this.nextAirId++,
      // slow orbit of the arena; it hunts whatever is under it
      ang: Math.random() * Math.PI * 2, rad: S * 0.55, spin: 0.13,
      x: 0, y: GUNSHIP_ALT, z: 0, yaw: 0,
      until: now + GUNSHIP_LIFE, nextShot: now + 2500, targetId: 0,
    });
    this.events.push(['air', 'heli']);
  }

  spawnJet(now) {
    const S = this.world.size;
    // a straight run across the whole map through a random offset from centre
    const a = Math.random() * Math.PI * 2;
    const off = (Math.random() - 0.5) * S * 0.7;
    const dx = Math.cos(a), dz = Math.sin(a);
    this.air.push({
      kind: 'jet', id: this.nextAirId++,
      x: -dx * (S + 60) - dz * off, z: -dz * (S + 60) + dx * off,
      y: JET_ALT, dx, dz, yaw: Math.atan2(-dx, -dz),
      // bombs are released around the midpoint so they land inside the arena
      dropAt: (S + 60) - (BOMB_COUNT * BOMB_SPACING) / 2, dropped: 0,
      until: now + 20000,
    });
    this.events.push(['air', 'jet']);
  }

  tickAir(dt, now) {
    if (now >= this.nextGunship && !this.air.some(a => a.kind === 'heli')) {
      this.spawnGunship(now);
      this.nextGunship = now + GUNSHIP_EVERY[0] +
        Math.random() * (GUNSHIP_EVERY[1] - GUNSHIP_EVERY[0]);
    }
    if (now >= this.nextJet && !this.air.some(a => a.kind === 'jet')) {
      this.spawnJet(now);
      this.nextJet = now + JET_EVERY[0] +
        Math.random() * (JET_EVERY[1] - JET_EVERY[0]);
    }

    for (let i = this.air.length - 1; i >= 0; i--) {
      const a = this.air[i];
      if (a.kind === 'heli') {
        a.ang += a.spin * dt;
        a.x = Math.cos(a.ang) * a.rad;
        a.z = Math.sin(a.ang) * a.rad;
        a.yaw = a.ang + Math.PI / 2;     // nose along the orbit
        if (now >= a.nextShot && this.phase === 'play') {
          a.nextShot = now + 260;
          // strafe the nearest living body under the flight path
          let tgt = null, bestD = 46;
          for (const o of this.byId.values()) {
            if (o.hp <= 0) continue;
            const d = Math.hypot(o.x - a.x, o.z - a.z);
            if (d < bestD) { bestD = d; tgt = o; }
          }
          if (tgt) {
            a.targetId = tgt.id;
            // walking fire: scattered around the target, not a laser
            const sx = tgt.x + (Math.random() - 0.5) * 7;
            const sz = tgt.z + (Math.random() - 0.5) * 7;
            this.events.push(['strafe', +a.x.toFixed(1), +a.y.toFixed(1), +a.z.toFixed(1),
              +sx.toFixed(1), +sz.toFixed(1)]);
            for (const o of this.byId.values()) {
              if (o.hp <= 0) continue;
              if (Math.hypot(o.x - sx, o.z - sz) > 2.6) continue;
              o.hp -= GUNSHIP_DPS_HIT;
              this.events.push(['hit', 0, o.id, GUNSHIP_DPS_HIT, 0]);
              if (o.hp <= 0) {
                o.hp = 0; o.deaths++; o.respawn = RESPAWN_S;
                this.events.push(['kill', 0, o.id, 'gunship']);
              }
            }
          } else { a.targetId = 0; }
        }
        if (now >= a.until) { this.air.splice(i, 1); continue; }
      } else {
        const step = JET_SPEED * dt;
        a.x += a.dx * step; a.z += a.dz * step;
        a.travelled = (a.travelled || 0) + step;
        const travelled = a.travelled;
        if (a.dropped < BOMB_COUNT && travelled >= a.dropAt + a.dropped * BOMB_SPACING) {
          a.dropped++;
          this.bombs.push({ x: a.x, y: a.y, z: a.z, vy: -2, dx: a.dx, dz: a.dz });
        }
        if (now >= a.until || travelled > (this.world.size + 60) * 2.4) {
          this.air.splice(i, 1); continue;
        }
      }
    }

    // falling bombs
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.vy += GRAV * dt;
      b.y += b.vy * dt;
      b.x += b.dx * JET_SPEED * 0.35 * dt;
      b.z += b.dz * JET_SPEED * 0.35 * dt;
      const floor = groundHeightAt(b.x, b.z, this.world);
      if (b.y <= floor) {
        this.bombs.splice(i, 1);
        this.events.push(['airburst', +b.x.toFixed(1), +floor.toFixed(1), +b.z.toFixed(1)]);
        for (const o of this.byId.values()) {
          if (o.hp <= 0) continue;
          const d = Math.hypot(o.x - b.x, (o.y + 1) - floor, o.z - b.z);
          if (d > BOMB_RADIUS) continue;
          const blocked = !this.losPoint(b.x, floor + 0.6, b.z, o);
          const dmg = Math.round(BOMB_DMG * (1 - d / BOMB_RADIUS) * (blocked ? 0.3 : 1));
          if (dmg <= 0) continue;
          o.hp -= dmg;
          this.events.push(['hit', 0, o.id, dmg, 0]);
          if (o.hp <= 0) {
            o.hp = 0; o.deaths++; o.respawn = RESPAWN_S;
            this.events.push(['kill', 0, o.id, 'airstrike']);
          }
        }
      }
    }
  }

  onKill(killer, victim) {
    victim.hp = 0;
    victim.deaths++;
    victim.respawn = RESPAWN_S;
    killer.kills++;
    // team score only for a genuine enemy kill; the air hazard credits nobody
    if (killer.team !== victim.team) this.teamKills[killer.team]++;
    this.events.push(['kill', killer.id, victim.id, killer.weapon]);
    if (this.teamKills[killer.team] >= TEAM_TARGET && this.phase === 'play') {
      this.phase = 'over';
      this.winner = TEAM_NAMES[killer.team];
      this.phaseEndsAt = Date.now() + INTERMISSION_S * 1000;
      this.events.push(['end', killer.id, TEAM_NAMES[killer.team]]);
    }
  }

  tick() {
    const dt = TICK_MS / 1000;
    const now = Date.now();

    for (const p of this.byId.values()) {
      if (p.bot && p.hp > 0) this.botThink(p, dt, now);
    }
    this.tickGrenades(dt);
    this.tickAir(dt, now);

    // match reset
    if (this.phase === 'over' && now >= this.phaseEndsAt) {
      this.phase = 'play';
      this.winner = null;
      this.teamKills = [0, 0];
      this.air = []; this.bombs = [];
      this.scheduleAir(now);
      for (const p of this.byId.values()) {
        p.kills = 0; p.deaths = 0; p.hp = 100; p.respawn = 0;
        p.slot = 0;
        p.slots = [
          { weapon: 'rifle', mag: WEAPONS.rifle.mag },
          { weapon: 'pistol', mag: WEAPONS.pistol.mag },
        ];
        p.reloading = 0;
        this.syncSlot(p);
        this.placeAtSpawn(p);
      }
      for (const pk of this.pickups) { pk.active = true; pk.respawnAt = 0; }
      this.events.push(['restart']);
    }

    for (const p of this.byId.values()) {
      // respawn countdown
      if (p.hp <= 0) {
        p.respawn -= dt;
        if (p.respawn <= 0) {
          p.hp = 100; p.weapon = 'rifle'; p.mag = WEAPONS.rifle.mag; p.reloading = 0;
          this.placeAtSpawn(p);
          this.events.push(['spawn', p.id]);
        }
        continue;
      }
      // reload
      if (p.reloading > 0) {
        p.reloading -= dt;
        if (p.reloading <= 0) {
          p.reloading = 0; p.mag = WEAPONS[p.weapon].mag; this.stashSlot(p);
        }
      }
      // movement: rotate input into world space, integrate, collide
      const { mx, mz, sprint, jump, crouch } = p.input;
      const l = Math.hypot(mx, mz);
      const grounded = p.y <= groundHeightAt(p.x, p.z, this.world) + 1e-4;
      if (l > 0.01) {
        const nx = mx / Math.max(1, l), nz = mz / Math.max(1, l);
        const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
        const wx = nx * cos - nz * sin;
        const wz = -nx * sin - nz * cos;
        // crouch beats sprint; sprint only counts moving forward-ish
        const sp = crouch ? CROUCH_SPEED : (sprint ? SPRINT : WALK);
        p.x += wx * sp * dt;
        p.z += wz * sp * dt;
      }
      // jump + gravity. The floor is whatever groundHeightAt says it is under
      // the post-move position, so stepping off a platform edge starts a fall
      // and stepping onto one lands. A platform top is always the top of a
      // solid box, and no walk step (0.38 m) can carry a body PLAYER_R deep
      // into a box it was pushed out of last tick, so this can only ever snap a
      // player up by the 0.2 m the collision skip already tolerates.
      const gh = groundHeightAt(p.x, p.z, this.world);
      if (jump && grounded) p.vy = JUMP_V;
      if (p.y > gh || p.vy > 0) {
        p.vy += GRAV * dt;
        p.y += p.vy * dt;
        if (p.y <= gh) { p.y = gh; p.vy = 0; }
      } else if (p.y !== gh) { p.y = gh; p.vy = 0; }
      if (p.airborne && p.y <= gh + 0.05) this.events.push(['land', p.id]);
      p.airborne = p.y > gh + 0.05;
      // collide with obstacles (circle vs AABB in XZ, only below box top)
      for (const b of this.world.obstacles) {
        if (p.y > b.h - 0.2) continue;
        const nx = Math.max(b.x1, Math.min(p.x, b.x2));
        const nz = Math.max(b.z1, Math.min(p.z, b.z2));
        const ddx = p.x - nx, ddz = p.z - nz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 < PLAYER_R * PLAYER_R && d2 > 1e-9) {
          const dist = Math.sqrt(d2);
          p.x = nx + (ddx / dist) * PLAYER_R;
          p.z = nz + (ddz / dist) * PLAYER_R;
        } else if (d2 <= 1e-9) {
          // centre is strictly inside the box (the clamp returns the point
          // itself), so there is no push direction: leave through the nearest
          // face. A fixed direction here throws the body the full width of the
          // box — across the plinth, out of a ruin, or over the whole arena.
          const dw = p.x - b.x1, de = b.x2 - p.x, dn = p.z - b.z1, ds = b.z2 - p.z;
          const mn = Math.min(dw, de, dn, ds);
          if (mn === dw) p.x = b.x1 - PLAYER_R;
          else if (mn === de) p.x = b.x2 + PLAYER_R;
          else if (mn === dn) p.z = b.z1 - PLAYER_R;
          else p.z = b.z2 + PLAYER_R;
        }
      }
      // arena bounds
      const S = this.world.size;
      p.x = Math.max(-S + 0.6, Math.min(S - 0.6, p.x));
      p.z = Math.max(-S + 0.6, Math.min(S - 0.6, p.z));

      // planar velocity from the actual post-collision delta (bots lead with it).
      // Footsteps and speedNorm come off the same real delta, so a body jammed
      // against geometry neither runs on the spot nor emits step events.
      const realDX = p.x - p.px, realDZ = p.z - p.pz;
      p.vx = realDX / dt; p.vz = realDZ / dt;
      p.px = p.x; p.pz = p.z;
      const realMoved = Math.hypot(realDX, realDZ);
      p.speedNorm = Math.min(1, realMoved / dt / SPRINT);
      // footsteps: one event per STEP_DIST travelled on the ground
      if (grounded && realMoved > 1e-4) {
        p.stepAcc += realMoved;
        const need = crouch ? STEP_DIST * 1.6 : STEP_DIST;
        if (p.stepAcc >= need) { p.stepAcc = 0; this.events.push(['step', p.id]); }
      }

      // pickups
      for (const pk of this.pickups) {
        if (!pk.active) {
          if (now >= pk.respawnAt) pk.active = true;
          continue;
        }
        if (Math.hypot(pk.x - p.x, pk.z - p.z) < 1.4 && Math.abs(p.y - pk.y) < 1) {
          if (pk.type === 'health') {
            if (p.hp >= 100) continue;
            p.hp = Math.min(100, p.hp + 50);
          } else {
            // a picked-up long gun always lands in the primary slot, so the
            // sidearm in slot 1 is never lost
            p.slot = 0;
            p.slots[0] = { weapon: pk.type, mag: WEAPONS[pk.type].mag };
            p.reloading = 0;
            this.syncSlot(p);
          }
          pk.active = false;
          pk.respawnAt = now + PICKUP_RESPAWN_S * 1000;
          this.events.push(['pickup', p.id, pk.type]);
        }
      }
    }

    // snapshot
    const snap = JSON.stringify({
      t: 's',
      now,
      ph: this.phase,
      win: this.winner,
      endsIn: this.phase === 'over' ? Math.max(0, this.phaseEndsAt - now) : 0,
      // row: [0]id [1]x [2]y [3]z [4]yaw [5]pitch [6]hp [7]kills [8]deaths
      //      [9]weapon [10]mag [11]reloading [12]name [13]speed0..1
      //      [14]flags(1 sprint, 2 crouch, 4 bot, 8 airborne)
      p: [...this.byId.values()].map(p => [
        p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
        +p.yaw.toFixed(3), +p.pitch.toFixed(3),
        p.hp, p.kills, p.deaths, p.weapon, p.mag,
        +(p.reloading > 0), p.name,
        +p.speedNorm.toFixed(2),
        (p.input.sprint ? 1 : 0) | (p.input.crouch ? 2 : 0) |
        (p.bot ? 4 : 0) | (p.airborne ? 8 : 0),
        p.team,                                    // [15]
        p.slots[1 - p.slot].weapon,                // [16] the gun on your back
      ]),
      // air units: [kind, x, y, z, yaw]
      air: this.air.map(a => [a.kind, +a.x.toFixed(1), +a.y.toFixed(1),
        +a.z.toFixed(1), +a.yaw.toFixed(2)]),
      bm: this.bombs.map(b => [+b.x.toFixed(1), +b.y.toFixed(1), +b.z.toFixed(1)]),
      ts: this.teamKills,
      pk: this.pickups.map(pk => [pk.id, +pk.active]),
      g: this.grenades.map(g => [+g.x.toFixed(2), +g.y.toFixed(2), +g.z.toFixed(2)]),
      ev: this.events,
    });
    this.events = [];
    for (const ws of this.players.keys()) {
      try { ws.send(snap); } catch {}
    }
  }
}
