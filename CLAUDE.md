# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Dockerized real-time roulette stream analyzer. An RTMP stream is transcoded to HLS by FFmpeg, served by Nginx, and processed in the browser by a vanilla JS frontend that performs pixel-level color detection to identify roulette wheel segments.

## Running the Project

```bash
# Start all services (builds if needed)
docker-compose up -d

# Rebuild and restart
docker-compose up --build

# View logs
docker-compose logs -f

# UI is at http://localhost:8080
```

There is no build step for the frontend — it is plain ES6 modules served directly by Nginx.

## Calibration Tool

```bash
# Requires Python 3.8+, OpenCV, NumPy, python-dotenv
python roulette_stream_calibrator.py
```

Used interactively to determine values for `CROP_REGION`, `OUTER_ELLIPSE`, `INNER_ELLIPSE`, and `COLOR_*` env vars.

## Configuration

Runtime config flows through `.env` → `docker-compose.yml` → `web-entrypoint.sh` → `config.json` (served at `/config.json`, loaded by `app.js` at startup). The template is `config.json.template`; `envsubst` does the substitution.

Key `.env` variables:
- `STREAM_URL` — RTMP source URL
- `CROP_REGION` — `[x, y, w, h]` region of interest on the stream frame
- `OUTER_ELLIPSE` / `INNER_ELLIPSE` — `[cx, cy, w, h, angle]` ring boundaries
- `COLOR_RED` / `COLOR_GREEN` / `COLOR_BLACK` — `[R_lo, R_hi, G_lo, G_hi, B_lo, B_hi]` detection ranges
- `MIN_BLOCK_SIZE` / `MAX_BLOCK_SIZE` — pixel-count thresholds for blob filtering
- `FILTER_UP_MODE` — if true, ignores blobs above the ring center

## Architecture

```
RTMP Stream
    └── transcoder (FFmpeg, Alpine) → /hls/ volume → .m3u8 + .ts segments
                                              ↓
                                   web (Nginx, Alpine)
                                        ├── /hls/ — HLS segments
                                        ├── /stream-health — health probe (checks .m3u8 exists)
                                        └── / — SPA (frontend/)
```

**Frontend data flow** (`frontend/js/`):

1. `app.js` — fetches `/config.json`, wires UI event listeners, owns the 100 ms processing loop
2. `stream-viewer.js` — wraps HLS.js; polls `/stream-health` before connecting; exponential backoff reconnection (1.5 s → 30 s); stall watchdog
3. `processor.js` (`RingProcessor`) — the core engine:
   - Captures a frame from the hidden `<video>` onto an offscreen canvas
   - Single-pass RGB filtering over the crop region using configurable color ranges
   - Two-pass connected-component labeling with union-find + hole-filling
   - Minimum-area rotated bounding box fitting per blob
   - Draws overlays (ellipse guides, blob boxes, center crosshair) onto the display canvas
   - Renders a scrollable block list with per-blob thumbnails and stats

The UI is a 4-pane grid (stream, processed overlay, block list, stats). Clicking a pane expands it; Esc collapses back.

## Key Implementation Notes

- `processor.js` uses pre-allocated typed arrays and a single offscreen canvas to avoid per-frame GC pressure.
- Blob detection uses a union-find structure (two-pass labeling). Blobs are filtered by pixel area, not bounding-box size.
- `FILTER_UP_MODE` masks out blobs whose centroid is above the ring center Y coordinate (eliminates ceiling reflections).
- `transcoder/entrypoint.sh` runs FFmpeg in a reconnect loop with configurable `RECONNECT_WAIT`; the HLS window is 10 segments.
- Nginx CORS headers are open (`*`) so the frontend can be served cross-origin during development.
