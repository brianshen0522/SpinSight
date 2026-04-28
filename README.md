# SpinSight

**SpinSight** is a high-performance, Dockerized real-time roulette stream analyzer. It transforms raw RTMP broadcasts into a structured, rectified visual dataset of roulette wheel segments (Red, Green, and Black) using client-side computer vision.

![Project Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Tech](https://img.shields.io/badge/Tech-Vanilla%20JS%20|%20FFmpeg%20|%20Docker-blue)

## 🎯 Purpose

While many systems focus on just "seeing" the wheel, **SpinSight** is built for **Dataset Generation**. It doesn't just detect blocks; it standardizes them. It extracts every wheel segment, rectifies its rotation so the inner-edge is always at the bottom, and overlays precise ground-truth labels—making the output perfect for training Convolutional Neural Networks (CNNs).

## 🚀 Key Features

*   **Real-time Pipeline**: Transcodes RTMP to HLS on-the-fly with sub-second segmenting.
*   **Edge Processing**: Performs heavy pixel-level analysis (Blob detection, Union-Find labeling, Convex Hull) directly in the browser using pre-allocated typed arrays to maintain 10+ FPS.
*   **Automatic Rectification**: Uses specialized "Bottom-Edge Detection" logic to rotate every detected block to a vertical orientation.
*   **Dataset-Ready UI**: A dedicated "Detected Blocks" feed shows standardized crops with 1:1 consistent labeling for immediate verification.
*   **Calibration Suite**: Includes interactive tools to tune ROI (Region of Interest), elliptical masks, and color thresholds.

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
docker-compose up -d --build
```
Open `http://localhost:8080` in your browser.

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

## 🧰 Tech Stack

*   **Engine**: FFmpeg (Alpine-based)
*   **Server**: Nginx (Alpine-based)
*   **Frontend**: Vanilla ES6 JavaScript, HLS.js, CSS Grid
*   **CV Logic**: Custom Union-Find Labeling, Convex Hull (Graham scan), Affine Transformation for rectification.

---
*Developed for high-precision roulette video analysis and machine learning pre-processing.*
