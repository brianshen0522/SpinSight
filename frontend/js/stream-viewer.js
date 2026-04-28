'use strict';

const HLS_URL          = '/hls/stream.m3u8';
const HEALTH_URL       = '/stream-health';
const STALL_TIMEOUT_MS = 8_000;   // no currentTime advance → stall
const HEALTH_POLL_MS   = 3_000;   // probe /stream-health while offline
const BASE_BACKOFF_MS  = 1_500;
const MAX_BACKOFF_MS   = 30_000;

// ── Status definitions ─────────────────────────────────────────────────────────

const STATUS = {
  waiting:      { label: 'Waiting for stream',  cls: 'waiting'      },
  connecting:   { label: 'Connecting',           cls: 'connecting'   },
  live:         { label: 'Live',                 cls: 'live'         },
  buffering:    { label: 'Buffering',            cls: 'buffering'    },
  reconnecting: { label: 'Reconnecting',         cls: 'reconnecting' },
  error:        { label: 'Error',                cls: 'error'        },
};

// ── StreamViewer class ─────────────────────────────────────────────────────────

class StreamViewer {
  constructor({ videoEl, statusDot, statusLabel, attemptEl, uptimeEl, onLive, onNotLive }) {
    this.video       = videoEl;
    this.statusDot   = statusDot;
    this.statusLabel = statusLabel;
    this.attemptEl   = attemptEl;
    this.uptimeEl    = uptimeEl;
    this._onLiveCb    = onLive    || (() => {});
    this._onNotLiveCb = onNotLive || (() => {});

    this.hls             = null;
    this.reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._stallTimer     = null;
    this._healthTimer    = null;
    this._startedAt      = null;      // Date when stream first went live
    this._uptimeTick     = null;

    this._lastCurrentTime  = 0;
    this._lastAdvanceStamp = 0;

    this._bindVideoEvents();
    this._startHealthWait();
  }

  // ── Status display ───────────────────────────────────────────────────────────

  _setStatus(key, detail = '') {
    const s = STATUS[key] || STATUS.error;
    this.statusDot.className   = `dot ${s.cls}`;
    this.statusLabel.textContent = detail ? `${s.label} — ${detail}` : s.label;
    this.attemptEl.textContent =
      this.reconnectAttempt > 0 ? `attempt #${this.reconnectAttempt}` : '';
  }

  // ── Health probe: wait until transcoder has created the manifest ─────────────

  _startHealthWait() {
    this._setStatus('waiting');
    this._pollHealth();
  }

  _pollHealth() {
    fetch(HEALTH_URL)
      .then(r => {
        if (r.ok) {
          this._connect();
        } else {
          this._healthTimer = setTimeout(() => this._pollHealth(), HEALTH_POLL_MS);
        }
      })
      .catch(() => {
        this._healthTimer = setTimeout(() => this._pollHealth(), HEALTH_POLL_MS);
      });
  }

  // ── HLS setup ───────────────────────────────────────────────────────────────

  _connect() {
    this._clearAllTimers();
    this._setStatus('connecting');

    // Safari native HLS
    if (!window.Hls || !Hls.isSupported()) {
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.video.src = HLS_URL;
        this.video.play().catch(() => {});
        this._onLive();
      } else {
        this._setStatus('error', 'HLS not supported in this browser');
      }
      return;
    }

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    this.hls = new Hls({
      // Low-latency tuning
      liveSyncDurationCount:      3,
      liveMaxLatencyDurationCount: 8,
      maxBufferLength:             20,
      maxMaxBufferLength:          40,
      enableWorker:                true,
      lowLatencyMode:              true,
      // Aggressive fragment retry
      fragLoadingMaxRetry:         6,
      fragLoadingRetryDelay:       500,
      manifestLoadingMaxRetry:     8,
      manifestLoadingRetryDelay:   1_000,
    });

    this.hls.loadSource(HLS_URL);
    this.hls.attachMedia(this.video);

    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.video.play().catch(() => {});
    });

    this.hls.on(Hls.Events.ERROR, (_evt, data) => {
      console.warn('[hls]', data.type, data.details, data.fatal);
      if (data.fatal) {
        this._scheduleReconnect('HLS fatal: ' + data.details);
      } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        this._setStatus('buffering');
      }
    });
  }

  // ── Stall watchdog ───────────────────────────────────────────────────────────

  _startStallWatcher() {
    this._lastCurrentTime  = this.video.currentTime;
    this._lastAdvanceStamp = Date.now();

    const tick = () => {
      if (!this.video || this.video.paused || this.video.ended) {
        // Reset baseline so a manual pause doesn't trip the watchdog
        this._lastCurrentTime  = this.video.currentTime;
        this._lastAdvanceStamp = Date.now();
        this._stallTimer = setTimeout(tick, 1_000);
        return;
      }

      const now     = Date.now();
      const advance = this.video.currentTime - this._lastCurrentTime;

      if (advance > 0.05) {
        this._lastCurrentTime  = this.video.currentTime;
        this._lastAdvanceStamp = now;
        this._onLive();
      } else if (now - this._lastAdvanceStamp > STALL_TIMEOUT_MS) {
        this._scheduleReconnect('stream stalled');
        return;
      } else if (now - this._lastAdvanceStamp > 2_000) {
        this._setStatus('buffering');
      }

      this._stallTimer = setTimeout(tick, 1_000);
    };

    this._stallTimer = setTimeout(tick, 1_000);
  }

  // ── Reconnect logic ──────────────────────────────────────────────────────────

  _scheduleReconnect(reason = '') {
    this._clearAllTimers();
    if (this.hls) { this.hls.destroy(); this.hls = null; }

    this.reconnectAttempt++;
    const delay = Math.min(
      BASE_BACKOFF_MS * Math.pow(1.5, this.reconnectAttempt - 1),
      MAX_BACKOFF_MS
    );
    const secs = (delay / 1_000).toFixed(1);
    this._setStatus('reconnecting', `${reason} — retry in ${secs}s`);
    console.warn(`[viewer] ${reason} — reconnect #${this.reconnectAttempt} in ${secs}s`);

    // First check health again before reconnecting (stream may be down at source)
    this._reconnectTimer = setTimeout(() => {
      fetch(HEALTH_URL)
        .then(r => r.ok ? this._connect() : this._scheduleReconnect('stream offline'))
        .catch(() => this._scheduleReconnect('network unreachable'));
    }, delay);
  }

  // ── Callbacks from video element events ─────────────────────────────────────

  _onLive() {
    if (!this._startedAt) {
      this._startedAt = Date.now();
      this._startUptimeTick();
    }
    this.reconnectAttempt = 0;
    this._setStatus('live');
    this._onLiveCb();
  }

  _bindVideoEvents() {
    this.video.addEventListener('playing', () => {
      this._onLive();
      this._startStallWatcher();
    });
    this.video.addEventListener('waiting',  () => this._setStatus('buffering'));
    this.video.addEventListener('stalled',  () => this._setStatus('buffering'));
    this.video.addEventListener('error', () => {
      if (!this.hls) return;  // native fallback; hls.js handles its own errors
      this._scheduleReconnect('video element error');
    });
  }

  // ── Uptime counter ───────────────────────────────────────────────────────────

  _startUptimeTick() {
    if (this._uptimeTick) clearInterval(this._uptimeTick);
    this._uptimeTick = setInterval(() => {
      const s = Math.floor((Date.now() - this._startedAt) / 1_000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      this.uptimeEl.textContent =
        `up ${h ? h + 'h ' : ''}${m ? m + 'm ' : ''}${ss}s`;
    }, 1_000);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  _clearAllTimers() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer);   this._reconnectTimer = null; }
    if (this._stallTimer)     { clearTimeout(this._stallTimer);       this._stallTimer     = null; }
    if (this._healthTimer)    { clearTimeout(this._healthTimer);      this._healthTimer    = null; }
  }

  destroy() {
    this._clearAllTimers();
    if (this._uptimeTick) clearInterval(this._uptimeTick);
    if (this.hls) { this.hls.destroy(); this.hls = null; }
  }
}

// Export for app.js
export { StreamViewer };
