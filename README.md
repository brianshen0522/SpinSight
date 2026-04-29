# SpinSight

**SpinSight** is a Dockerized real-time roulette stream analyzer and dataset capture tool. It transforms raw RTMP broadcasts into structured, rectified roulette-segment crops and exports YOLO-style labels directly from the browser.

![Project Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Tech](https://img.shields.io/badge/Tech-Vanilla%20JS%20|%20FFmpeg%20|%20Docker-blue)

## 🎯 Purpose

While many systems focus on just "seeing" the wheel, **SpinSight** is built for **Dataset Generation**. It doesn't just detect blocks; it standardizes them. It extracts every wheel segment, rectifies its rotation so the inner-edge is always at the bottom, and overlays precise ground-truth labels—making the output perfect for training Convolutional Neural Networks (CNNs).

## 🚀 Key Features

*   **Real-time Pipeline**: Transcodes RTMP to HLS on-the-fly and serves a low-latency browser viewer.
*   **Edge Processing**: Performs pixel-level analysis (blob detection, connected components, convex hull) directly in the browser using pre-allocated typed arrays.
*   **Automatic Rectification**: Rotates each detected block into a consistent upright view for review and export.
*   **Debug + Dataset Modes**: Switch between RGB/debug inspection and guided dataset capture without leaving the stream view.
*   **YOLO Export**: Saves per-block JPG crops plus one YOLO label file per crop and bundles them with the uploaded `classes.txt` in a ZIP.

## 🏗 Architecture

```text
[RTMP Stream] 
      │
      ▼
[Transcoder Service (FFmpeg)] ──► Shared HLS Volume (.m3u8 / .ts)
                                           │
                                           ▼
[Web Service (Nginx)] ◄────────────────────┘
      │
      ├──► Injects .env config into config.json
      └──► Serves SPA (Frontend)
             │
             └──► [HLS.js Viewer]
             └──► [RingProcessor (CV Engine)] ──► [Standardized Dataset View]
```

## 🛠 Quick Start

### 1. Prerequisites
*   Docker & Docker Compose
*   A valid RTMP stream URL

### 2. Configuration
Copy the template and fill in your stream details:
```bash
# Configuration is managed via the .env file
# Ensure STREAM_URL and calibration values are set
```

### 3. Launch
```bash
docker compose up -d --build
```
Open `http://localhost:8081` in your browser.

## 🎮 Viewer Controls

### Debug mode
*   `Space`: freeze / resume the stream
*   `↻`: manually refresh the HLS connection from the latest live position

### Dataset mode
*   `Space`: start one capture round
*   `F`: pause / resume dataset capture without freezing the stream
*   Viewer hints show capture state such as `Wheel is not spinning` and `Waiting for green block`

## 🗂 Dataset Capture Workflow

1.  Switch to **Dataset** mode.
2.  Upload `classes.txt`.
    * The file is preserved as-is in the export ZIP.
    * It must contain class names `0` through `36`.
    * Class IDs are the uploaded file's line numbers.
3.  Set a dataset name or leave it blank to use `YYMMDD`.
4.  Choose target mode:
    * total image count, or
    * per-class image count
5.  Configure:
    * undersample balancing
    * frames per round
    * interval by seconds or frames
    * duplicate threshold
6.  Press `Space` to start a round.

Capture rules:
*   A frame is skipped if the wheel is not moving.
*   A frame is skipped until a green block is detected.
*   Only successfully predicted blocks are exported.
*   One valid frame can produce multiple files: one rectified JPG per predicted block.
*   Each JPG receives one YOLO label file using the precise label box normalized to the crop image.
*   Capture stops automatically when the target is reached.

## 📏 Calibration

To achieve high-quality detection, you must calibrate the vision engine for your specific camera angle:

1.  Use the `roulette_stream_calibrator.py` tool to determine ROI and ellipse parameters.
2.  Tune the **Color Ranges** in `.env` until the red, green, and black blocks are cleanly isolated.
3.  Adjust `MIN_BLOCK_SIZE` to filter out noise.

## 📊 Dataset Standards

Every block displayed in the "Detected Blocks" list follows these rules:
*   **Alignment**: The "Inner Side" (cyan line) is rotated to the bottom.
*   **Crop Box**: The colored box represents the sampling area.
*   **Label Box**: The orange box represents the precise pixel-cluster boundary (Ground Truth).
*   **Consistency**: The thumbnails are 100% spatially consistent with the original stream coordinates.
*   **Ordering**: The block list is ordered from the top of the wheel and then clockwise.

## 📦 Export Format

Dataset ZIP contents:
*   `images/*.jpg`: one rectified crop per predicted block
*   `labels/*.txt`: one YOLO label file per crop
*   `classes.txt`: the exact uploaded class mapping file

Each label file contains one line:
```text
<class_id> <cx> <cy> <w> <h>
```
Coordinates are normalized to the exported crop, not the full source frame.

## 🧰 Tech Stack

*   **Engine**: FFmpeg (Alpine-based)
*   **Server**: Nginx (Alpine-based)
*   **Frontend**: Vanilla ES6 JavaScript, HLS.js, CSS Grid
*   **CV Logic**: Custom Union-Find Labeling, Convex Hull (Graham scan), Affine Transformation for rectification.

---
*Developed for high-precision roulette video analysis and machine learning pre-processing.*
