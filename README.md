# DEADZONE

A round-based first-person zombie survival game that runs in the browser
(Three.js). Survive escalating waves in the starting room, buy weapons off
the walls, then open doors to fight your way upstairs and down into the
basement, where the upgrade bench waits.

## Run it

```bash
npm install
npx serve .          # or: python3 -m http.server 3000
```

Open http://localhost:3000 and click **ENTER THE DEADZONE**.
(It must be served over HTTP — opening `index.html` directly won't load the
ES modules.)

## How to play

| Input | Action |
|---|---|
| Mouse | Aim |
| Left click | Shoot (hold for full-auto weapons) |
| WASD | Move |
| Shift | Sprint |
| R | Reload |
| F | Buy weapon / open door / upgrade |
| 1 / 2 | Switch between your two weapons |
| Esc | Pause |

### The loop

- Zombies come in **rounds** — each round they're more numerous, tougher
  and faster. Runners start appearing around round 3.
- **Points**: 10 per hit, 60 per kill, 110 for a headshot kill. You start
  with 500.
- **Wall-buys** (chalk outlines on the walls): KOMPAKT-9 SMG (1000) and
  RIOT-12 shotgun (1200) in the starting room, LONGSHOT rifle (1500)
  upstairs, HELLFANG LMG (2500) in the basement. Buying a gun you already
  own refills its ammo for half price.
- **Doors**: UPSTAIRS costs 750, BASEMENT costs 1250. Opened areas add new
  zombie entry points — they stay dangerous.
- **Upgrade bench** (basement, 5000): 2.5× damage, bigger mags, double
  reserve ammo for the weapon in your hands.
- Health regenerates after ~4.5s without taking damage. Headshots do 2.5×
  damage and pop heads.

## Project layout

```
index.html        HUD, menus, styling
src/main.js       game wiring + loop
src/world.js      map geometry, collision, zones, doors, waypoint graph
src/player.js     FPS controller, health
src/weapons.js    weapon defs, viewmodels, firing, wall-buys, upgrades
src/zombies.js    zombie model/AI + round (horde) manager
src/gore.js       blood particles, splatter decals, gibs
src/audio.js      procedural sound effects
src/textures.js   procedural textures + label sprites
src/hud.js        DOM HUD
```

## Dropping in real assets

Everything visual/audible is currently procedural placeholder content,
isolated behind small factory functions so assets can replace them
piecemeal:

- **Zombie model** → replace the body construction in the `Zombie`
  constructor (`src/zombies.js`) with a loaded GLB (`GLTFLoader`); keep
  `userData = { zombie, part: 'head' | 'body' }` on the hit meshes so
  shooting and headshots keep working.
- **Gun models / viewmodels** → swap `buildViewmodel()` in
  `src/weapons.js`; keep the `userData.flash` / `userData.flashLight`
  references for muzzle flash.
- **Textures** → swap the functions in `src/textures.js` for
  `TextureLoader` calls (concrete, brick, wood, blood stain).
- **Sounds** → each effect is one named entry in `sfx` (`src/audio.js`);
  replace any entry with an `Audio`/`AudioBuffer` playback of a real file.
- Put asset files under `assets/` (e.g. `assets/models/`, `assets/sounds/`,
  `assets/textures/`).

## Tuning knobs

- Round scaling: `zombiesForRound`, `healthForRound`, `maxAlive`,
  `spawnInterval` in `src/zombies.js`.
- Weapon stats & prices: `WEAPON_DEFS` in `src/weapons.js`.
- Door prices: the `_makeDoor` calls in `src/world.js`.
- Map layout: `src/world.js` (`zoneAt` / `groundHeightAt` define the
  walkable zones and floor heights).
