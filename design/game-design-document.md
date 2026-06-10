# DeadZone — Game Design Document

## Concept

Round-based first-person zombie survival in a derelict multi-floor
building. Classic "zombies mode" loop: kill for points, spend points on
wall guns, doors, and upgrades, survive as long as possible against
endlessly scaling waves. Tone: dark, wet, industrial-grim — flickering
bulbs, rusted metal, heavy gore.

## Core loop

1. Round starts → zombies break in through boarded windows.
2. Player kills for points (hits 10, kills 60, headshot kills 110).
3. Between rounds: buy wall guns / open doors / upgrade.
4. Each round: more zombies, more health, more speed, more runners.
5. Death is permanent → score screen → restart.

## Map (current)

- **Ground room** (spawn): 3 windows, KOMPAKT-9 + RIOT-12 wall-buys.
- **Upstairs** (door: 750): 3 windows, LONGSHOT wall-buy.
- **Basement** (door: 1250): 3 windows, HELLFANG wall-buy,
  **upgrade bench** (5000 — 2.5× damage, 1.5× mag, 2× reserve).
- Opened areas keep spawning zombies (75% player's zone / 25% elsewhere).

## Tuning (authoritative values in code)

- Waves: `src/zombies.js` → `zombiesForRound 5+2.6r (cap 45)`,
  `health 80+45r`, `maxAlive 7+r (cap 17)`, runners from round 3.
- Weapons: `src/weapons.js` → `WEAPON_DEFS`.
- Player: 100 hp, regen after 4.5s, zombie swipe 22 dmg.

## Pillars

1. **Tension over twitch** — darkness, audio cues, and ammo scarcity do
   the work; zombies are slow but relentless.
2. **Every point has a job** — doors vs guns vs upgrade is the strategy.
3. **Gore is feedback** — blood/gibs/headpops communicate damage clearly.

## Roadmap / backlog

- [ ] Real assets: textures, decals, zombie + gun models, sounds
      (drop-in pipeline already live — `assets/README.md`).
- [ ] Window board repair + zombie board-tearing.
- [ ] Mystery box / random weapon.
- [ ] Perk machines (speed reload, extra health).
- [ ] Power switch gating the upgrade bench.
- [ ] Grenades / melee.
- [ ] Score persistence (localStorage leaderboard).
