'use strict';

import { RingProcessor } from './processor.js';

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
  const blockListEl = document.getElementById('block-list');
  const blockListMetaEl = document.getElementById('block-list-meta');
  let activeView = null;

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
    if (event.key === 'Escape' && activeView) setFocusedPane(null);
  });

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
    if (now - lastT < PROCESS_INTERVAL_MS) return;
    if (video.readyState < 2) return;   // no frame yet
    lastT = now;
    try {
      proc.process(video, ctxs);
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
