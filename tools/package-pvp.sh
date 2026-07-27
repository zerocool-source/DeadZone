#!/usr/bin/env bash
# Package Wasteland PvP for deployment. The platform requires server.js and
# index.html at the ARCHIVE ROOT (no wrapper directory), everything else ships
# alongside as assets.
#
#   bash tools/package-pvp.sh            -> ./deadzone-pvp.zip
#
# Deploy flow after this (Higgsfield): media_upload -> PUT bytes -> media_confirm
# type "file" -> deploy_game passing the SAME game_id from pvp/DEPLOY.md so the
# live game updates in place instead of spawning a duplicate.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-deadzone-pvp.zip}"
rm -f "$OUT"
cd pvp
zip -r "../$OUT" \
  server.js index.html client.js world.js strings.js design assets \
  -x '*.DS_Store' > /dev/null
cd ..
echo "$OUT  $(du -h "$OUT" | cut -f1)"
unzip -l "$OUT" | tail -3
