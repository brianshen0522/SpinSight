#!/bin/sh
set -e

# Defaults for optional vars (prevents envsubst leaving empty → invalid JSON)
export CROP_REGION="${CROP_REGION:-[0,0,1920,1080]}"
export OUTER_ELLIPSE="${OUTER_ELLIPSE:-null}"
export INNER_ELLIPSE="${INNER_ELLIPSE:-null}"
export COLOR_RED="${COLOR_RED:-[0,255,0,255,0,255]}"
export COLOR_GREEN="${COLOR_GREEN:-[0,255,0,255,0,255]}"
export COLOR_BLACK="${COLOR_BLACK:-[0,255,0,255,0,255]}"
export MIN_BLOCK_SIZE="${MIN_BLOCK_SIZE:-50}"
export MAX_BLOCK_SIZE="${MAX_BLOCK_SIZE:-999999}"
export FILTER_UP_MODE="${FILTER_UP_MODE:-false}"

envsubst < /config.json.template > /usr/share/nginx/html/config.json
echo "[web] config.json written:"
cat /usr/share/nginx/html/config.json

exec nginx -g 'daemon off;'
