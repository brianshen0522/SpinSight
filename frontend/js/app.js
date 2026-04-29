'use strict';

import { RingProcessor } from './processor.js';
import { DatasetCollector } from './dataset.js';
import { SettingsPanel } from './settings-panel.js';
import { predict } from './predictor.js';

const PROCESS_INTERVAL_MS = 100;   // ~10 fps for heavy pixel work
const MOTION_SAMPLE_SIZE = 64;

async function init() {
  // ── Load config injected by Docker from .env ──────────────────────────────
  let cfg;
  try {
    const res = await fetch('/config.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cfg = await res.json();
  } catch (e) {
    console.error('[app] Failed to load config.json:', e);
    document.getElementById('status-label').textContent = 'Config load failed';
    return;
  }
  console.log('[app] Config:', cfg);
  if (typeof cfg.filterUpMode !== 'boolean') cfg.filterUpMode = false;

  // ── Size canvases ─────────────────────────────────────────────────────────
  const [, , cw, ch] = cfg.cropRegion;

  // q-orig shows the full video frame — set to 1920×1080 initially;
  // processor._processOrig() will correct it on the first frame.
  const qOrig = document.getElementById('q-orig');
  qOrig.width  = 1920;
  qOrig.height = 1080;

  // Filtered quadrants match the crop region
  for (const id of ['q-red', 'q-green', 'q-black']) {
    const el = document.getElementById(id);
    el.width  = cw;
    el.height = ch;
  }

  const ctxs = ['q-orig', 'q-red', 'q-green', 'q-black'].map(id =>
    document.getElementById(id).getContext('2d', { willReadFrequently: false })
  );

  // ── Stream viewer (HLS player + reconnect logic) ──────────────────────────
  const { StreamViewer } = await import('./stream-viewer.js');
  const sv = new StreamViewer({
    videoEl:     document.getElementById('stream-video'),
    statusDot:   document.getElementById('status-dot'),
    statusLabel: document.getElementById('status-label'),
    attemptEl:   document.getElementById('reconnect-attempt'),
    uptimeEl:    document.getElementById('uptime'),
    onLive:      () => overlay.classList.add('hidden'),
    onNotLive:   (txt) => { overlay.classList.remove('hidden'); overlayText.textContent = txt; },
  });

  const overlay     = document.getElementById('video-overlay');
  const overlayText = document.getElementById('overlay-text');
  const grid = document.getElementById('quad-grid');
  const panes = Array.from(grid.querySelectorAll('.quad-pane'));
  const focusExit = document.getElementById('focus-exit');
  const freezeBadge = document.getElementById('freeze-badge');
  const modeDebugBtn = document.getElementById('mode-debug');
  const modeSettingsBtn = document.getElementById('mode-settings');
  const modeDatasetBtn = document.getElementById('mode-dataset');
  const datasetPanel = document.getElementById('dataset-panel');
  const settingsPanelEl = document.getElementById('settings-panel');
  const viewerHint = document.getElementById('viewer-hint');
  const streamRefreshBtn = document.getElementById('stream-refresh');
  const blockListEl = document.getElementById('block-list');
  const blockListMetaEl = document.getElementById('block-list-meta');
  const predictionContent = document.getElementById('prediction-content');
  const predictionMeta = document.getElementById('prediction-meta');
  let activeView = null;
  let frozen = false;
  let mode = 'debug';
  let lastBlobs = { blobsR: [], blobsG: [], blobsB: [] };
  let lastPredResult = null;
  let motionMask = null;
  let lastMotionSample = null;
  let forcePreviewFrames = 0;
  const motionCanvas = Object.assign(document.createElement('canvas'), {
    width: MOTION_SAMPLE_SIZE,
    height: MOTION_SAMPLE_SIZE,
  });
  const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });

  function setFocusedPane(nextView) {
    activeView = nextView;
    grid.classList.toggle('is-focus', Boolean(nextView));
    for (const pane of panes) {
      pane.classList.toggle('is-active', pane.dataset.view === nextView);
    }
  }

  for (const pane of panes) {
    pane.addEventListener('click', () => {
      const view = pane.dataset.view;
      setFocusedPane(activeView === view ? null : view);
    });
  }
  focusExit.addEventListener('click', () => setFocusedPane(null));

  function setMode(nextMode) {
    mode = nextMode;
    grid.classList.toggle('is-dataset', mode === 'dataset');
    grid.classList.toggle('is-settings', mode === 'settings');
    datasetPanel.classList.toggle('hidden', mode !== 'dataset');
    settingsPanelEl.classList.toggle('hidden', mode !== 'settings');
    modeDebugBtn.classList.toggle('is-active', mode === 'debug');
    modeSettingsBtn.classList.toggle('is-active', mode === 'settings');
    modeDatasetBtn.classList.toggle('is-active', mode === 'dataset');
  }

  function setViewerHint(message) {
    viewerHint.textContent = message;
    viewerHint.classList.toggle('hidden', !message);
  }

  function syncViewerHint({ spinning, predResult }) {
    if (mode === 'dataset') {
      if (datasetCollector.isPaused()) {
        setViewerHint(datasetCollector.getStatusMessage());
        return;
      }
      if (datasetCollector.isRoundActive() && !spinning) {
        setViewerHint('Wheel is not spinning');
        return;
      }
      if (datasetCollector.isRoundActive() && !predResult) {
        setViewerHint('Waiting for green block');
        return;
      }
      setViewerHint(datasetCollector.getStatusMessage());
      return;
    }

    setViewerHint(spinning ? '' : 'Wheel is not spinning');
  }

  function buildMotionMask(ringMask, cropSize) {
    if (!ringMask || !cropSize?.width || !cropSize?.height) return null;
    const out = new Uint8Array(MOTION_SAMPLE_SIZE * MOTION_SAMPLE_SIZE);
    for (let y = 0; y < MOTION_SAMPLE_SIZE; y++) {
      const sy = Math.min(cropSize.height - 1, Math.floor((y / MOTION_SAMPLE_SIZE) * cropSize.height));
      for (let x = 0; x < MOTION_SAMPLE_SIZE; x++) {
        const sx = Math.min(cropSize.width - 1, Math.floor((x / MOTION_SAMPLE_SIZE) * cropSize.width));
        out[(y * MOTION_SAMPLE_SIZE) + x] = ringMask[(sy * cropSize.width) + sx] ? 1 : 0;
      }
    }
    return out;
  }

  function computeRingMotionDiff(cropCanvas) {
    motionCtx.drawImage(cropCanvas, 0, 0, MOTION_SAMPLE_SIZE, MOTION_SAMPLE_SIZE);
    const curr = motionCtx.getImageData(0, 0, MOTION_SAMPLE_SIZE, MOTION_SAMPLE_SIZE).data;
    if (!lastMotionSample) {
      lastMotionSample = new Uint8ClampedArray(curr);
      return Infinity;
    }

    let sum = 0;
    let samples = 0;
    for (let i = 0; i < curr.length; i += 4) {
      if (motionMask && motionMask[i >> 2] !== 1) continue;
      sum += Math.abs(curr[i] - lastMotionSample[i])
        + Math.abs(curr[i + 1] - lastMotionSample[i + 1])
        + Math.abs(curr[i + 2] - lastMotionSample[i + 2]);
      samples++;
    }
    lastMotionSample = new Uint8ClampedArray(curr);
    if (!samples) return Infinity;
    return sum / (samples * 3);
  }

  modeDebugBtn.addEventListener('click', () => setMode('debug'));
  modeSettingsBtn.addEventListener('click', () => setMode('settings'));
  modeDatasetBtn.addEventListener('click', () => setMode('dataset'));
  streamRefreshBtn.addEventListener('click', () => {
    frozen = false;
    freezeBadge.classList.add('hidden');
    sv.refresh();
  });

  function toggleFreeze() {
    frozen = !frozen;
    if (frozen) {
      sv.freeze();
      freezeBadge.classList.remove('hidden');
    } else {
      sv.unfreeze();
      freezeBadge.classList.add('hidden');
    }
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeView) {
      setFocusedPane(null);
    } else if (event.key === ' ') {
      event.preventDefault();
      if (mode === 'dataset') {
        datasetCollector.startRound();
      } else {
        toggleFreeze();
      }
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (mode === 'dataset') {
        datasetCollector.togglePause();
      }
    }
  });

  // ── Prediction helpers ────────────────────────────────────────────────────
  function chipBg(color) {
    if (color === 'red')    return 'rgba(192,57,43,0.88)';
    if (color === 'green')  return 'rgba(26,122,58,0.88)';
    if (color === 'orphan') return 'rgba(80,80,100,0.88)';
    return 'rgba(16,16,16,0.88)';
  }

  function drawNumberBadge(ctx, x, y, text, color) {
    ctx.save();
    ctx.font = 'bold 15px monospace';
    const tw = ctx.measureText(text).width;
    const pad = 5;
    const bw = tw + pad * 2;
    const bh = 20;
    ctx.fillStyle = chipBg(color);
    ctx.fillRect(x - bw / 2, y - bh / 2, bw, bh);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawPredictionOverlay(result) {
    const [ox, oy] = cfg.cropRegion;
    const colorCtxMap = { red: ctxs[1], green: ctxs[2], black: ctxs[3] };

    // Main chain — confirmed numbers
    for (const { blob, number, color } of result.chain) {
      const label = String(number);
      drawNumberBadge(ctxs[0], blob.cx + ox, blob.cy + oy, label, color);
      drawNumberBadge(colorCtxMap[color], blob.cx, blob.cy, label, color);
    }

    // Orphan groups
    for (const group of result.orphanGroups) {
      const members = group.numberedMembers || group.members;
      for (const m of members) {
        const hasNum     = group.resolved && m.number != null;
        const label      = hasNum ? String(m.number) : (group.resolved ? '~' : '?');
        const badgeColor = hasNum ? m.color : 'orphan';
        drawNumberBadge(ctxs[0], m.blob.cx + ox, m.blob.cy + oy, label, badgeColor);
        drawNumberBadge(colorCtxMap[m.color], m.blob.cx, m.blob.cy, label, badgeColor);
      }
    }
  }

  // Rate-limit panel chip redraws — chips are small DOM but no need every 100 ms
  let lastPanelPaint = 0;
  function updatePredictionPanel(result) {
    const now = performance.now();
    if (now - lastPanelPaint < 180) return;
    lastPanelPaint = now;

    if (!result) {
      predictionMeta.textContent = '';
      predictionContent.innerHTML =
        '<span class="prediction-empty">No green (0) detected</span>';
      return;
    }

    const orphanCount   = result.orphanGroups.length;
    const resolvedCount = result.orphanGroups.filter(g => g.resolved).length;
    let meta = `${result.chain.length} confirmed`;
    if (orphanCount) meta += ` · ${resolvedCount}/${orphanCount} orphan${orphanCount > 1 ? 's' : ''} resolved`;
    predictionMeta.textContent = meta;

    const frag = document.createDocumentFragment();

    // Confirmed chain chips
    for (const seg of result.chain) {
      const chip = document.createElement('span');
      chip.className = `pred-chip pred-chip--${seg.color}`;
      chip.textContent = seg.number;
      frag.appendChild(chip);
    }

    // Orphan groups
    for (const group of result.orphanGroups) {
      if (group.resolved && group.numberedMembers) {
        // Show inferred numbers as individual chips (slightly dimmed to distinguish from confirmed)
        for (const m of group.numberedMembers) {
          const chip = document.createElement('span');
          chip.className = `pred-chip pred-chip--${m.color} pred-chip--inferred`;
          chip.textContent = m.number;
          chip.title = `Orphan (inferred)${group.hiddenColor ? ` — hidden ${group.hiddenColor} block assumed` : ''}`;
          frag.appendChild(chip);
        }
      } else {
        const chip = document.createElement('span');
        chip.className = `pred-chip pred-chip--orphan${group.resolved ? ' pred-chip--orphan-resolved' : ''}`;
        chip.textContent = group.resolved ? `~${group.members.length}` : `?${group.members.length}`;
        chip.title = group.resolved ? 'Orphan — resolved (no number)' : 'Orphan — unresolved';
        frag.appendChild(chip);
      }
    }

    predictionContent.replaceChildren(frag);
  }

  // ── Build ring processor (computes ellipse mask once) ────────────────────
  const proc = new RingProcessor(cfg, {
    blockListEl,
    blockListMetaEl,
  });
  function syncRangeTitles() {
    const rangeInfo = [
      { id: 'label-red', range: cfg.colorRed },
      { id: 'label-green', range: cfg.colorGreen },
      { id: 'label-black', range: cfg.colorBlack },
    ];
    for (const { id, range } of rangeInfo) {
      const el = document.getElementById(id);
      if (el && range) {
        el.title = `R[${range[0]}-${range[1]}] G[${range[2]}-${range[3]}] B[${range[4]}-${range[5]}]`;
      }
    }
  }
  const datasetCollector = new DatasetCollector();
  datasetCollector.mount(datasetPanel);
  datasetCollector.setContext({
    getCropCanvas: () => proc.getCropCanvas(),
    exportDetectionCrop: (blob, classId) => proc.exportDetectionCrop(blob, classId),
    flashEl: qOrig,
    ringMask: proc.getRingMask(),
    cropSize: proc.getCropSize(),
  });
  const settingsPanel = new SettingsPanel(cfg, {
    onChange: () => {
      syncRangeTitles();
      forcePreviewFrames = 2;
    },
  });
  settingsPanel.mount(settingsPanelEl);
  motionMask = buildMotionMask(proc.getRingMask(), proc.getCropSize());
  setMode('debug');

  // ── Render loop ──────────────────────────────────────────────────────────
  const video = document.getElementById('stream-video');
  let lastT   = 0;

  function tick(now) {
    requestAnimationFrame(tick);
    const allowFrozenPreviewRefresh = frozen && (mode === 'settings' || forcePreviewFrames > 0);
    if (frozen && !allowFrozenPreviewRefresh) return;
    if (now - lastT < PROCESS_INTERVAL_MS) return;
    if (video.readyState < 2) return;   // no frame yet
    lastT = now;
    try {
      // 1. Process current frame → current blobs
      const cropCanvas = proc.captureCrop(video);
      const motionDiff = computeRingMotionDiff(cropCanvas);
      const isSpinning = motionDiff >= datasetCollector.getDiffThreshold();
      const bypassMotionGate = mode === 'settings' || forcePreviewFrames > 0;
      if (forcePreviewFrames > 0) forcePreviewFrames--;

      if (!isSpinning && !bypassMotionGate) {
        syncViewerHint({ spinning: false, predResult: null });
        overlay.classList.add('hidden');
        return;
      }

      const blobs = proc.process(video, ctxs);
      if (blobs) lastBlobs = blobs;

      // 2. Predict from current frame's blobs (no lag)
      const predResult = predict(lastBlobs.blobsR, lastBlobs.blobsG, lastBlobs.blobsB);
      lastPredResult = predResult;

      // Build predMap: blob → entry (for block list badge rendering)
      let predMap = null;
      if (predResult) {
        predMap = new Map();
        for (const s of predResult.chain) {
          predMap.set(s.blob, { number: s.number, color: s.color, orphan: false });
        }
        for (const g of predResult.orphanGroups) {
          const members = g.numberedMembers || g.members;
          for (const m of members) {
            predMap.set(m.blob, {
              number:   m.number ?? null,
              color:    m.color,
              orphan:   true,
              resolved: g.resolved,
            });
          }
        }
      }

      // 3. Draw badges on canvas at current positions
      if (predResult) drawPredictionOverlay(predResult);

      // 4. Render block list with current predMap (rate-limited inside)
      proc.renderBlockList(lastBlobs.blobsR, lastBlobs.blobsG, lastBlobs.blobsB, predMap);

      // 5. Update prediction panel chips (rate-limited)
      updatePredictionPanel(predResult);

      if (mode === 'dataset') {
        datasetCollector.onFrame(lastPredResult, now);
      }
      syncViewerHint({ spinning: isSpinning, predResult: lastPredResult });

      overlay.classList.add('hidden');
    } catch (e) {
      console.warn('[app] process error:', e);
    }
  }
  requestAnimationFrame(tick);

  // ── Footer clock ─────────────────────────────────────────────────────────
  const footerTime = document.getElementById('footer-time');
  setInterval(() => { footerTime.textContent = new Date().toLocaleTimeString(); }, 1000);

  // ── Color range display in quad labels ────────────────────────────────────
  syncRangeTitles();
}

init().catch(console.error);
