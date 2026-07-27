# INSTALL / RUN

Three playable games live in this repo. All of them run in a browser on
Windows, macOS and Linux. Nothing needs a game engine installed.

Requirements: **Node.js 18+** and a WebGL2 browser (Chrome, Edge, Firefox,
Safari 16+). A GPU helps — these are real 3D games.

```bash
git clone https://github.com/zerocool-source/DeadZone.git
cd DeadZone
```

---

## 1. Wasteland PvP — online shooter with AI bots  (`pvp/`)

**Easiest: just play the hosted build, no install.**
https://grand-menhir-631.higgsfield.gg/ — bots fill the match instantly, and the
invite link in the corner drops friends into your room.

**Run your own local server** (LAN play, offline hacking on the code):

```bash
npm install ws                 # only dependency the harness needs
node tools/local-net.mjs 8920  # serves pvp/ and runs the real game server
```

Open <http://localhost:8920>. Others on your network can join at
`http://<your-lan-ip>:8920/?room=whatever` — same room id = same match.

`tools/local-net.mjs` loads the **actual** `pvp/server.js` game server (the same
authoritative simulation that runs in production, with the Cloudflare import
stubbed) and bridges WebSockets to it, so local play is not a mock.

### Controls

| Action | Keyboard / Mouse | Xbox / PlayStation pad | Touch |
|---|---|---|---|
| Move | WASD | Left stick | Left-half stick |
| Look | Mouse | Right stick | Drag right half |
| Fire | Left click | RT / R2 | FIRE |
| Aim (ADS) | Right click | — | — |
| Jump | Space | A / Cross | JMP |
| Crouch | Ctrl or C | B / Circle | — |
| Sprint | Shift | L3 (click left stick) | — |
| Reload | R | X / Square | RLD |
| Grenade | G | RB / R1 | NADE |
| Scoreboard | Hold Tab | — | — |

**Xbox controller over USB:** plug it in *before* or during play, press any
button to wake it, then click the page once so it has focus. Chrome and Edge
expose it through the Gamepad API with the standard mapping automatically — no
driver, no config. Wireless (Bluetooth or the Xbox dongle) works identically.
If nothing happens, open `chrome://device-log` or test at
<https://hardwaretester.com/gamepad> to confirm the browser sees the pad.

Add `?dev=1` to the URL for an FPS and draw-call overlay.

---

## 2. DeadZone Zombies — round survival  (`/` repo root)

```bash
npm install        # pulls three.js
npx serve -l 3000 .
```

Open <http://localhost:3000>. (Any static server works —
`python3 -m http.server 3000` is fine. Opening `index.html` from disk will
**not** work: ES modules require http://.)

WASD move, mouse aim, click to shoot, R reload, F to buy weapons/doors/upgrades,
1 / 2 to switch weapons, Shift to sprint.

---

## 3. Claude-of-Duty engine  (`cod/`, MIT, vendored from mshumer/Claude-of-Duty)

A 55k-line procedural FPS engine — every texture, mesh and sound generated at
load time. Heavy: wants a real GPU.

```bash
cd cod
npm install
npm run dev      # http://127.0.0.1:5173
```

A prebuilt static copy is committed at `cod/dist/` if you would rather not build.

---

## Troubleshooting

**Black screen / very low frame rate** — software rendering. Check
`chrome://gpu`; enable hardware acceleration in browser settings.

**"Cannot use import statement outside a module"** — the page was opened from
the filesystem. Serve it over http:// as shown above.

**Multiplayer says connecting forever** — the local harness must be running, and
the port in the URL must match the port you passed to `local-net.mjs`.

**Mouse look does nothing** — click the game canvas once to capture the pointer
(browsers require a click before pointer lock). Esc releases it.

**Port already in use** — pass a different port: `node tools/local-net.mjs 8931`.
