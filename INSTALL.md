# INSTALL / RUN

Three playable games live in this repo. All of them run in a browser on
Windows, macOS and Linux. Nothing needs a game engine installed.

Requirements: **Node.js 18+** and a WebGL2 browser (Chrome, Edge, Firefox,
Safari 16+). A real GPU helps — these are 3D games.

```bash
git clone https://github.com/zerocool-source/DeadZone.git
cd DeadZone
npm install
```

---

## 1. Wasteland PvP — your own dedicated server  (`pvp/` + `server/`)

This is a **self-hosted game server**. Nothing calls out to any third-party
platform: your machine serves the game and runs the authoritative simulation.

```bash
npm start                      # http://localhost:8080
npm start -- --port 9000       # different port
PORT=9000 npm start            # same, via env
```

It prints every address it is reachable on:

```
  DEADZONE dedicated server
  ─────────────────────────
  play here      http://localhost:8080
  on your LAN    http://192.168.1.24:8080
  health check   http://localhost:8080/health
```

**Playing with other people.** Anyone who can reach your machine opens the LAN
address and lands in your match. Everyone in the same `?room=<name>` shares a
match, so `http://192.168.1.24:8080/?room=friday` is a private lobby. Over the
internet, forward the port on your router or put it behind a tunnel
(`cloudflared tunnel --url http://localhost:8080`, `ngrok http 8080`, or a
reverse proxy — the WebSocket upgrade on `/ws/…` must be passed through).

Rooms fill to 20 combatants with AI, split into two squads, so a solo session
is still a full battlefield. `/health` reports live room and player counts.

`server/index.mjs` loads `pvp/server.js` — the exact same rules module the
hosted build runs — and supplies the two things the platform normally provides:
a base class and a browser-shaped WebSocket. There is no second copy of the
game logic to drift.

### Controls

| Action | Keyboard / Mouse | Xbox / PlayStation pad | Touch |
|---|---|---|---|
| Move | WASD | Left stick | Left-half stick |
| Look | Mouse | Right stick | Drag right half |
| Fire | Left click | RT / R2 | FIRE |
| Aim (ADS) | Right click | LT / L2 | AIM |
| Jump | Space | A / Cross | JMP |
| Crouch | Ctrl or C | B / Circle | — |
| Sprint | Shift | L3 (click left stick) | — |
| Reload | R | X / Square | RLD |
| Swap weapon | Q, or 1 / 2 | Y / Triangle | SWAP |
| Grenade | G | RB / R1 | NADE |
| Scoreboard | Hold Tab | — | — |
| Graphics quality | K | — | — |
| Controller diagnostics | F1 | — | — |

### Controller troubleshooting

The bottom-left of the HUD shows **PAD: READY** when the browser can see your
controller. If it is blank, the browser has not detected a pad yet.

1. **Press a button on the pad after the page loads.** Browsers deliberately
   hide gamepads until the pad sends input — this is the single most common
   reason a controller "does not work".
2. **Click the game window once** so the page has focus.
3. **Press F1** for the live diagnostic overlay. It prints the pad's reported
   id, its mapping, and every axis and button as you move them. If that overlay
   says `NO GAMEPAD SEEN BY THE BROWSER`, the problem is between the OS and the
   browser, not in the game.
4. **macOS**: an Xbox controller works over both USB-C/USB-A cable and
   Bluetooth with no driver on Chrome, Edge and Safari. On Bluetooth, pair it
   in System Settings → Bluetooth first. If macOS pairs it but the browser
   shows nothing, quit and reopen the browser after pairing.
5. **Non-standard mappings are handled.** Some pads and some browsers (notably
   Safari, and certain third-party or Bluetooth Xbox stacks) report
   `mapping: ""` with the sticks and triggers on different indices, and report
   triggers as axes rather than buttons. The game reads both layouts. The F1
   overlay tells you which one you have.
6. Cross-check the pad itself at <https://hardwaretester.com/gamepad>. If it
   does not move there either, it is an OS/pairing issue.

### Graphics quality

Press **K** in-game to cycle **low → medium → high**; the choice is saved.

- **high** — renders at your display's real pixel density (a Retina or 4K panel
  gets its full resolution), 2048px sun shadows.
- **medium** (default) — capped at 1.5× density, 1024px shadows.
- **low** — 1× density, shadows off. For weak GPUs and integrated graphics.

Shadow map changes take effect on reload; resolution changes are immediate.
Add `?dev=1` to the URL for an FPS and draw-call overlay.

---

## 2. DeadZone Zombies — round survival  (`/` repo root)

```bash
npm run zombies      # http://localhost:3000
```

Any static server works. Opening `index.html` from disk will **not** work: ES
modules require `http://`.

WASD move, mouse aim, click to shoot, R reload, F to buy weapons/doors/upgrades,
1 / 2 to switch weapons, Shift to sprint.

---

## 3. Claude-of-Duty engine  (`cod/`, MIT, from mshumer/Claude-of-Duty)

A 55k-line procedural FPS engine — every texture, mesh and sound generated at
load time. Heavy: wants a real GPU.

```bash
cd cod && npm install && npm run dev      # http://127.0.0.1:5173
```

A prebuilt static copy is committed at `cod/dist/`.

---

## Troubleshooting

**Black screen / very low frame rate** — software rendering. Check
`chrome://gpu` and enable hardware acceleration. Press **K** to drop to low.

**"Cannot use import statement outside a module"** — the page was opened from
the filesystem. Serve it over `http://` as shown above.

**Multiplayer stuck on connecting** — the server must be running and the port
in the URL must match. Check `http://localhost:8080/health`.

**Mouse look does nothing** — click the canvas once to capture the pointer.
Esc releases it.

**Port already in use** — `npm start -- --port 8081`.
