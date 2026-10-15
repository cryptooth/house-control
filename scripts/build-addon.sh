#!/usr/bin/env bash
# Builds the web UI into the Home Assistant add-on (homeassistant/house_control/www).
# Then copy homeassistant/house_control into the "addons" folder of your Home Assistant.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d web/node_modules ] || npm ci --prefix web --no-audit --no-fund
npm run build --prefix web
rm -rf homeassistant/house_control/www
cp -R web/dist homeassistant/house_control/www
echo "Add-on ready in homeassistant/house_control"
