# DeadZone Studio — Roadmap

Three codebases, one goal: converge into the best playable shooter we can ship.

| Project | What it is | Play |
|---|---|---|
| **`/` (DeadZone Zombies)** | Round-based zombie survival, wall-buys, upgrade bench | githack link (repo root `index.html`) |
| **`pvp/` (Wasteland PvP)** | Online multiplayer FPS, server-authoritative, bots, live on Higgsfield | https://grand-menhir-631.higgsfield.gg/ |
| **`cod/` (Claude-of-Duty, MIT)** | 55k-line procedural FPS engine: HDR rendering, physics, AI squads | `cod/dist/index.html` via githack |

## AAA checklist — status map

**Shipped (Wasteland PvP)**: authoritative multiplayer over WebSockets, prediction,
interpolation, FFA to 15 kills, respawning, kill feed, scoreboard, minimap, HUD,
invite-link rooms, AI bots (3 difficulty tiers: roam, LOS target acquisition,
burst fire, aim error, stuck recovery, pickups), grenades (server-simulated arc,
bounce, radius damage with wall attenuation), generated 3D weapons (rifle /
shotgun / longshot), weapon pickups, health packs, hitmarkers, damage vignette,
explosion shake, keyboard + touch + gamepad, external strings, generated
SFX/music, day-haze fog wasteland (open arena ~180×180m).

**Shipped (Zombies)**: rounds, points economy, wall-buys, upgrades, doors,
gore (decals/gibs/headshots), GLB zombie models, asset drop-in pipeline.

**Shipped (cod/ engine, upstream)**: slide/vault/mantle/lean/ADS movement, spring
recoil + procedural reloads, ballistics with travel time, from-scratch physics
(BVH, swept capsule, ragdolls, penetration), AI soldiers with navmesh + cover,
HDR pipeline (CSM, GTAO, TAA, bloom, motion blur), day/night sky + volumetrics,
procedural materials (19 surfaces), city block with enterable interiors,
minimap/compass/killfeed HUD, Web Audio synthesis with HRTF + reverb.

## Next (in order)

1. **TDM + Domination** in Wasteland PvP — teams, 3 capture flags, team score tick.
2. **Market Street Zombies** — graft the DeadZone horde loop into the cod/ engine
   map (its AI bodies + ragdolls as zombies). The flagship visual experience.
3. **Bigger open world** for PvP — scale the arena, add vehicles-lite (drivable
   buggy = fast capsule with turn physics) once flags exist.
4. **Weapon attachments** — optics/suppressor/extended mag as pickup modifiers.
5. **Settings menu** — sensitivity, volume, graphics toggles, persisted to
   localStorage (PvP + zombies).
6. **PvP netcode into cod/ engine** — the long-term convergence; largest lift.

## Working agreements

- Every deployed change is verified end-to-end (local netcode harness +
  live WS probes; browser WS can't traverse the dev sandbox proxy).
- All art/audio flows through the style formula + asset manifests
  (`pvp/design/assets.csv`, `assets/README.md`).
- `pvp/DEPLOY.md` holds the Higgsfield `game_id` — updates must pass it back.
