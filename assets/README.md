# DeadZone asset drop-in guide

The game probes this folder at load time. **Drop a file in with the right
name and it's used automatically — no code changes.** Anything missing
falls back to the built-in procedural placeholder.

> Note for uploads: images pasted into chat don't reach the repo — commit
> the files into this folder (or upload them somewhere the session can
> download from) so they can be wired in.

## Textures — `assets/textures/<slot>.jpg|png|webp`

These map to the six-tile grunge wall sheet (crop each tile to its own
file, ideally 1024×1024, seamless if possible):

| Slot file | Used on | Suggested tile |
|---|---|---|
| `wall_concrete` | stairwell walls, ceilings | wet cracked concrete (tile 1) |
| `wall_brick` | ground + upper room walls | grungy red brick (tile 2) |
| `wall_metal` | basement walls + ceiling | rusted riveted metal panels (tile 3) |
| `floor_wood` | ground-floor floorboards | — |
| `floor_concrete` | upper floor + stair ramps | dark grime concrete (tile 4) |
| `floor_basement` | basement floor | mossy/wet ground (tile 6) |
| `wood` | window boards, doors, crates | — |

## Decals — `assets/decals/<slot>.png` (transparent background)

| Slot file | Used for |
|---|---|
| `blood_splatter` | floor/wall blood decals (crop one splatter from the decal sheet) |

More decal slots (moss, cracks, grime, footprints) get wired in as the
sheets are added — one PNG per decal works best.

## Sounds — `assets/sounds/<name>.mp3|ogg|wav`

One file per effect, named exactly:

`pistolShot, smgShot, rifleShot, shotgunShot, dryFire, reload, fleshHit,
headPop, zombieGroan, zombieAttack, playerHurt, purchase, denied,
doorOpen, upgrade, roundStart, roundEnd`

## Models — `assets/models/*.glb` (coming)

GLB loading for zombies/guns/props gets wired when the first model lands.
Prop renders on transparent backgrounds (pipes, crates, machinery sheets)
can also be used as alpha-card set dressing — commit them and they'll be
placed.
