# DeadZone — project notes

Round-based FPS zombie survival in the browser. No build step: vanilla ES
modules + Three.js (importmap to `node_modules`). Serve statically
(`npx serve .`) — `file://` won't load modules.

## Stack & layout

- **Engine**: Three.js (WebGL), pointer-lock FPS. No bundler, no framework.
- `src/world.js` — map geometry, collision (AABB list), zones &
  floor-height function, doors, zombie waypoint graph, set dressing.
- `src/zombies.js` — zombie model/AI + `Horde` round manager (all wave
  tuning lives here).
- `src/weapons.js` — `WEAPON_DEFS` (stats/prices), viewmodels, hitscan
  firing, wall-buys, upgrades.
- `src/player.js`, `src/gore.js`, `src/audio.js`, `src/hud.js`,
  `src/textures.js`, `src/main.js` (wiring + loop).

## Asset pipeline (important)

All art/audio is procedural placeholder behind named slots.
`src/assets.js` probes `assets/` at load and hot-swaps any file it finds
— see `assets/README.md` for the exact slot filenames. When adding new
visual/audio elements, always route them through a slot + procedural
fallback rather than hard-requiring a file.

## Conventions

- Keep modules dependency-light and single-purpose; game state flows
  through the `game` object in `main.js`.
- Distances in meters, y-up. Floor heights come from `groundHeightAt` —
  never hardcode a floor y outside `world.js`.
- New purchasables = entry in the `interactables` list in `main.js`.
- Test changes with a headless-browser smoke run before pushing
  (puppeteer; check `window.__dz` debug handle for game state).

## Design docs

`design/` holds the GDD and design registry; update them when gameplay
systems or tuning change meaningfully.
