'use strict';

import { RingProcessor } from './processor.js';
import { predict } from './predictor.js';

const PROCESS_INTERVAL_MS = 100;   // ~10 fps for heavy pixel work

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
  const blockListEl = document.getElementById('block-list');
  const blockListMetaEl = document.getElementById('block-list-meta');
  const predictionContent = document.getElementById('prediction-content');
  const predictionMeta = document.getElementById('prediction-meta');
  let activeView = null;
  let frozen = false;
  let lastBlobs = { blobsR: [], blobsG: [], blobsB: [] };

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
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeView) {
      setFocusedPane(null);
    } else if (event.key === ' ') {
      event.preventDefault();
      frozen = !frozen;
      if (frozen) {
        sv.freeze();
        freezeBadge.classList.remove('hidden');
      } else {
        sv.unfreeze();
        freezeBadge.classList.add('hidden');
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

  // ── Render loop ──────────────────────────────────────────────────────────
  const video = document.getElementById('stream-video');
  let lastT   = 0;

  function tick(now) {
    requestAnimationFrame(tick);
    if (frozen) return;
    if (now - lastT < PROCESS_INTERVAL_MS) return;
    if (video.readyState < 2) return;   // no frame yet
    lastT = now;
    try {
      // 1. Process current frame → current blobs
      const blobs = proc.process(video, ctxs);
      if (blobs) lastBlobs = blobs;

      // 2. Predict from current frame's blobs (no lag)
      const predResult = predict(lastBlobs.blobsR, lastBlobs.blobsG, lastBlobs.blobsB);

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
  const rangeInfo = [
    { id: 'label-red',   range: cfg.colorRed   },
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

init().catch(console.error);
