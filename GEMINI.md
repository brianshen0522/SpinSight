# GEMINI.md

## Project Overview
This project is a **Dockerized real-time roulette stream analyzer**. It processes an RTMP video stream to identify and track colored segments (Red, Green, Black) on a roulette wheel. The system uses a multi-stage pipeline involving video transcoding, web serving, and client-side pixel-level computer vision.

### Key Technologies
- **Transcoding:** FFmpeg (in Alpine Linux) converts RTMP to HLS.
- **Web Server:** Nginx (in Alpine Linux) serves the static frontend, HLS segments, and manages runtime configuration.
- **Frontend:** Vanilla JavaScript (ES6 modules) with HLS.js for video playback and custom pixel-processing logic.
- **Computer Vision:** Custom browser-side implementation of:
  - Pixel-level RGB filtering.
  - Two-pass connected-component labeling (union-find).
  - Hole filling and blob detection.
  - Minimum-area rotated bounding box fitting (Convex Hull).
- **Calibration:** Python 3 (OpenCV, NumPy) for determining configuration parameters (ROI, ellipses, color ranges).

## Architecture
- **`transcoder` service:** Connects to an RTMP source (`STREAM_URL`) and produces HLS segments in a shared volume.
- **`web` service:** Serves the frontend and the HLS stream. It also injects environment variables into `config.json` via `envsubst` during startup.
- **Frontend Data Flow:**
  1. `app.js`: Entry point, fetches config, manages the 10fps processing loop.
  2. `stream-viewer.js`: Manages the HLS.js player and reconnection logic.
  3. `processor.js`: The "engine" that captures frames and performs blob detection and analysis.

## Development Workflow

### Building and Running
```bash
# Start the entire stack
docker compose up -d

# Rebuild and restart services
docker compose up --build

# View logs for both services
docker compose logs -f
```
The UI is available at `http://localhost:8080`.

### Configuration
Configuration is managed via the `.env` file. Key variables include:
- `STREAM_URL`: The source RTMP stream.
- `CROP_REGION`: `[x, y, w, h]` of the wheel in the video frame.
- `OUTER_ELLIPSE` / `INNER_ELLIPSE`: Parameters for the wheel ring masking.
- `COLOR_RED` / `COLOR_GREEN` / `COLOR_BLACK`: RGB bounds for detection.
- `MIN_BLOCK_SIZE` / `MAX_BLOCK_SIZE`: Pixel thresholds for valid blobs.

### Calibration
A Python tool (intended as `roulette_stream_calibrator.py`) is used to interactively determine the environment variable values. It requires `opencv-python` and `numpy`.

## Development Conventions
- **Performance:** The `processor.js` uses pre-allocated typed arrays and offscreen canvases to minimize GC pressure during high-frequency pixel processing.
- **Simplicity:** The frontend uses vanilla ES6 modules without a build step (Babel/Webpack/Vite).
- **Resilience:** The transcoder includes an auto-reconnect loop for the RTMP source; the frontend includes exponential backoff for HLS stream recovery.
