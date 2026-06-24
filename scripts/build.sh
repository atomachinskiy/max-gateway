#!/usr/bin/env bash
# Rebuild the self-contained node bundles that clients run (no bun/npm needed on
# their side — they already have node via Claude Code). Run this (needs bun) after
# editing gateway/gateway.ts or bridge/server.ts, then commit the dist/ outputs.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p gateway/dist bridge/dist
bun build gateway/gateway.ts --target=node --outfile=gateway/dist/gateway.js
bun build bridge/server.ts  --target=node --outfile=bridge/dist/bridge.js
echo "built: gateway/dist/gateway.js + bridge/dist/bridge.js"
