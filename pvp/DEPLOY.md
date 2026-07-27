# DeadZone: Wasteland PvP — deployment

- **Play URL**: https://grand-menhir-631.higgsfield.gg/
- **game_id**: `22a03811-e25e-48ef-a749-56a3ad2d689e` (pass back to deploy_game to update in place — never omit it when updating, or a duplicate game is created)
- Mode: custom-server (server.js Durable Object, rooms = /ws/<room> shards)
- Card art: generated cover + skull-crosshair favicon (Higgsfield CDN, referenced in the deploy)

## Update flow
1. Edit sources in `pvp/`
2. `cd pvp && zip -r ../deadzone-pvp.zip server.js index.html client.js world.js strings.js design assets`
3. media_upload → PUT → media_confirm(file) → deploy_game with game_id above

## Verify
- `node tools/local-net.mjs 8920` runs the same GameServer locally with real sockets
- Sandbox note: the session proxy cannot carry browser WebSockets to the live host —
  verify the live server with Node `ws` clients, and the client rendering locally.
