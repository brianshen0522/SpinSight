'use strict';

function todayStr() {
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function splitLines(text) {
  return text.replace(/\r/g, '').split('\n');
}

function formatTime(seconds) {
  if (seconds < 1) return `${Math.max(0, seconds).toFixed(1)}s`;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  return `${mins}m ${secs}s`;
}

export class DatasetCollector {
  constructor() {
    this._settings = {
      datasetName: todayStr(),
      targetMode: 'total',
      targetCount: 200,
      underbalance: true,
      framesPerRound: 3,
      intervalMode: 'seconds',
      intervalValue: 1,
      diffThreshold: 15,
    };

    this._entries = [];
    this._classCounts = new Map();
    this._classesText = '';
    this._classEntries = [];
    this._numberToClassId = new Map();
    this._classesValid = false;
    this._classesError = 'Upload a valid classes.txt to start capture';

    this._roundActive = false;
    this._paused = false;
    this._capturesRemaining = 0;
    this._framesUntilNext = 0;
    this._nextCaptureAt = 0;
    this._skipDuplicateCount = 0;
    this._skipNoGreenCount = 0;
    this._skipNoPredictionCount = 0;
    this._captureFrameCount = 0;
    this._fileIdx = 0;
    this._statusMessage = 'Upload a valid classes.txt to start capture';
    this._statusTone = 'error';

    this._lastDiff = null;
    this._diffCanvas = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
    this._diffCtx = this._diffCanvas.getContext('2d', { willReadFrequently: true });
    this._diffMask = null;
    this._diffMaskCount = 0;

    this._el = {};
    this._getCropCanvas = null;
    this._exportDetectionCrop = null;
    this._flashEl = null;
  }

  setContext({ getCropCanvas, exportDetectionCrop, flashEl, ringMask, cropSize }) {
    this._getCropCanvas = getCropCanvas;
    this._exportDetectionCrop = exportDetectionCrop;
    this._flashEl = flashEl;
    if (ringMask && cropSize) this._buildDiffMask(ringMask, cropSize);
  }

  mount(panelEl) {
    panelEl.innerHTML = this._template();
    const q = id => panelEl.querySelector(`#${id}`);
    this._el = {
      panel: q('ds-panel'),
      nameInput: q('ds-name'),
      classesUpload: q('ds-classes-upload'),
      classesBtn: q('ds-classes-btn'),
      classesText: q('ds-classes-text'),
      classesStatus: q('ds-classes-status'),
      targetMode: panelEl.querySelectorAll('input[name="ds-target-mode"]'),
      targetCount: q('ds-target-count'),
      underbalance: q('ds-undersample'),
      framesPerRound: q('ds-frames-per-round'),
      intervalMode: q('ds-interval-mode'),
      intervalValue: q('ds-interval-value'),
      diffSlider: q('ds-diff-threshold'),
      diffValue: q('ds-diff-value'),
      statusMsg: q('ds-status'),
      totalProgress: q('ds-total-progress'),
      overallFill: q('ds-overall-fill'),
      classList: q('ds-class-list'),
      duplicateSkips: q('ds-duplicate-skips'),
      greenSkips: q('ds-green-skips'),
      predictionSkips: q('ds-prediction-skips'),
      roundState: q('ds-round-state'),
      downloadBtn: q('ds-download'),
      resetBtn: q('ds-reset'),
    };

    this._bindEvents();
    this._syncSettingsToDOM();
    this._setStatus(this._classesError, 'error');
    this._updateUI();
  }

  _bindEvents() {
    const el = this._el;

    el.nameInput.addEventListener('input', () => {
      this._settings.datasetName = el.nameInput.value.trim() || todayStr();
    });

    el.classesBtn.addEventListener('click', () => el.classesUpload.click());
    el.classesUpload.addEventListener('change', async event => {
      const file = event.target.files[0];
      if (!file) return;
      const text = await file.text();
      el.classesText.value = text;
      this._parseClassesText(text);
      this._updateUI();
    });
    el.classesText.addEventListener('change', () => {
      this._parseClassesText(el.classesText.value);
      this._updateUI();
    });

    el.targetMode.forEach(radio => {
      radio.addEventListener('change', () => {
        this._settings.targetMode = radio.value;
        this._updateUI();
      });
    });
    el.targetCount.addEventListener('input', () => {
      this._settings.targetCount = Math.max(1, parseInt(el.targetCount.value, 10) || 1);
      this._updateUI();
    });
    el.underbalance.addEventListener('change', () => {
      this._settings.underbalance = el.underbalance.checked;
      this._updateUI();
    });
    el.framesPerRound.addEventListener('input', () => {
      this._settings.framesPerRound = Math.max(1, parseInt(el.framesPerRound.value, 10) || 1);
      this._updateUI();
    });
    el.intervalMode.addEventListener('change', () => {
      this._settings.intervalMode = el.intervalMode.value;
      this._updateUI();
    });
    el.intervalValue.addEventListener('input', () => {
      const value = parseFloat(el.intervalValue.value);
      this._settings.intervalValue = Math.max(0, Number.isFinite(value) ? value : 0);
      this._updateUI();
    });
    el.diffSlider.addEventListener('input', () => {
      this._settings.diffThreshold = parseInt(el.diffSlider.value, 10);
      el.diffValue.textContent = String(this._settings.diffThreshold);
    });

    el.downloadBtn.addEventListener('click', () => this.downloadZip());
    el.resetBtn.addEventListener('click', () => {
      if (confirm('Reset the dataset buffer? Captured images and labels will be removed.')) {
        this.reset();
      }
    });
  }

  _syncSettingsToDOM() {
    const el = this._el;
    el.nameInput.value = this._settings.datasetName;
    el.targetCount.value = String(this._settings.targetCount);
    el.underbalance.checked = this._settings.underbalance;
    el.framesPerRound.value = String(this._settings.framesPerRound);
    el.intervalMode.value = this._settings.intervalMode;
    el.intervalValue.value = String(this._settings.intervalValue);
    el.diffSlider.value = String(this._settings.diffThreshold);
    el.diffValue.textContent = String(this._settings.diffThreshold);
    el.targetMode.forEach(r => { r.checked = r.value === this._settings.targetMode; });
  }

  _parseClassesText(text) {
    const previousText = this._classesText;
    const hadCapturedData = this._entries.length > 0;
    this._classesText = text;
    const lines = splitLines(text);
    const trimmed = lines.map(line => line.trim());
    const entries = trimmed.map((name, id) => ({ id, name }));
    const numberToClassId = new Map();

    for (const entry of entries) {
      if (entry.name !== '' && /^([0-9]|[12][0-9]|3[0-6])$/.test(entry.name) && !numberToClassId.has(entry.name)) {
        numberToClassId.set(entry.name, entry.id);
      }
    }

    const missing = [];
    for (let n = 0; n <= 36; n++) {
      const key = String(n);
      if (!numberToClassId.has(key)) missing.push(key);
    }

    this._classEntries = entries.filter(entry => entry.name !== '');
    this._numberToClassId = new Map();
    for (const [num, classId] of numberToClassId) {
      this._numberToClassId.set(parseInt(num, 10), classId);
    }

    if (!text.trim()) {
      this._classesValid = false;
      this._classesError = 'Upload a valid classes.txt to start capture';
    } else if (missing.length) {
      this._classesValid = false;
      this._classesError = `classes.txt is missing: ${missing.join(', ')}`;
    } else {
      this._classesValid = true;
      this._classesError = '';
    }

    if (this._el.classesStatus) {
      this._el.classesStatus.textContent = this._classesValid
        ? `${this._classEntries.length} classes loaded`
        : this._classesError;
      this._el.classesStatus.className = this._classesValid ? 'ds-muted ds-success' : 'ds-muted ds-error';
    }

    if (!this._classesValid) this._roundActive = false;
    if (hadCapturedData && text !== previousText) {
      this.reset();
      this._setStatus(this._classesValid
        ? 'classes.txt changed — existing captures were reset'
        : `${this._classesError} — existing captures were reset`,
      this._classesValid ? 'warning' : 'error');
    }
  }

  startRound() {
    if (!this._classesValid) {
      this._setStatus(this._classesError || 'classes.txt is invalid', 'error');
      return false;
    }
    if (this._roundActive) {
      this._setStatus(`Round already running — ${this._capturesRemaining} capture${this._capturesRemaining === 1 ? '' : 's'} remaining`, 'active');
      return false;
    }
    if (this._isTargetReached()) {
      this._setStatus('Target reached — download ZIP or reset', 'done');
      return false;
    }
    if (!this._getCropCanvas || !this._exportDetectionCrop) {
      this._setStatus('Capture context is not ready yet', 'error');
      return false;
    }

    this._roundActive = true;
    this._paused = false;
    this._capturesRemaining = this._settings.framesPerRound;
    this._framesUntilNext = 0;
    this._nextCaptureAt = 0;
    this._setStatus(`Round armed — waiting for ${this._capturesRemaining} valid frame${this._capturesRemaining === 1 ? '' : 's'}`, 'waiting');
    this._updateUI();
    return true;
  }

  onFrame(predResult, now = performance.now()) {
    if (!this._roundActive) return;
    if (this._paused) return;

    if (this._isTargetReached()) {
      this._finishRound('Target reached — download ZIP', 'done');
      return;
    }

    if (this._settings.intervalMode === 'frames') {
      if (this._framesUntilNext > 0) {
        this._framesUntilNext--;
        this._updateUI();
        return;
      }
    } else if (now < this._nextCaptureAt) {
      this._updateUI();
      return;
    }

    if (!predResult) {
      this._skipNoGreenCount++;
      this._setStatus(`Waiting for green block — ${this._capturesRemaining} frame${this._capturesRemaining === 1 ? '' : 's'} left`, 'waiting');
      this._updateUI();
      return;
    }

    const cropCanvas = this._getCropCanvas();
    if (!cropCanvas) {
      this._skipNoPredictionCount++;
      this._setStatus('Waiting for crop canvas to become ready', 'error');
      return;
    }

    const diff = this._computeDiff(cropCanvas);
    if (diff < this._settings.diffThreshold) {
      this._skipDuplicateCount++;
      this._setStatus(`Duplicate frame skipped (diff ${diff.toFixed(1)} < ${this._settings.diffThreshold})`, 'warning');
      this._updateUI();
      return;
    }

    const captured = this._captureFrame(predResult);
    if (!captured) {
      this._skipNoPredictionCount++;
      this._setStatus('No eligible predicted blocks in this frame', 'warning');
      this._updateUI();
      return;
    }

    this._captureFrameCount++;
    this._capturesRemaining--;
    this._updateDiffRef();
    this._flash();

    if (this._settings.intervalMode === 'frames') {
      this._framesUntilNext = Math.max(0, Math.round(this._settings.intervalValue));
    } else {
      this._nextCaptureAt = now + (this._settings.intervalValue * 1000);
    }

    if (this._isTargetReached()) {
      this._finishRound('Target reached — download ZIP', 'done');
      return;
    }

    if (this._capturesRemaining <= 0) {
      this._finishRound(`Round complete — ${this._entries.length} image${this._entries.length === 1 ? '' : 's'} captured`, 'done');
      return;
    }

    this._setStatus(`Captured frame ${this._captureFrameCount} — ${this._capturesRemaining} valid frame${this._capturesRemaining === 1 ? '' : 's'} left`, 'active');
    this._updateUI();
  }

  _captureFrame(predResult) {
    const segments = [];
    for (const seg of predResult.chain || []) {
      if (seg.number != null) segments.push(seg);
    }
    for (const group of predResult.orphanGroups || []) {
      if (!group.resolved || !group.numberedMembers) continue;
      for (const member of group.numberedMembers) {
        if (member.number != null) {
          segments.push({ number: member.number, color: member.color, blob: member.blob });
        }
      }
    }

    if (!segments.length) return false;

    const eligible = segments
      .map(seg => {
        const classId = this._numberToClassId.get(seg.number);
        if (classId == null) return null;
        return { ...seg, classId };
      })
      .filter(Boolean)
      .filter(seg => !this._shouldSkipClass(seg.classId));

    if (!eligible.length) return false;

    let saved = 0;
    for (const seg of eligible) {
      const exportData = this._exportDetectionCrop(seg.blob, seg.classId);
      if (!exportData) continue;
      this._fileIdx++;
      this._entries.push({
        id: this._fileIdx,
        classId: seg.classId,
        jpegB64: exportData.jpegB64,
        labelLine: exportData.labelLine,
      });
      this._classCounts.set(seg.classId, (this._classCounts.get(seg.classId) ?? 0) + 1);
      saved++;
    }

    if (!saved) return false;
    this._updateUI();
    return true;
  }

  _shouldSkipClass(classId) {
    const count = this._classCounts.get(classId) ?? 0;
    if (this._settings.targetMode === 'perClass' && count >= this._settings.targetCount) {
      return true;
    }
    if (!this._settings.underbalance || this._settings.targetMode !== 'total') {
      return false;
    }

    const capturableIds = this._capturableClassIds();
    let minCount = Infinity;
    for (const id of capturableIds) {
      minCount = Math.min(minCount, this._classCounts.get(id) ?? 0);
    }
    return count > minCount;
  }

  _capturableClassIds() {
    return [...this._numberToClassId.values()].sort((a, b) => a - b);
  }

  _computeDiff(cropCanvas) {
    const ctx = this._diffCtx;
    ctx.drawImage(cropCanvas, 0, 0, 64, 64);
    const curr = ctx.getImageData(0, 0, 64, 64).data;
    if (!this._lastDiff) return 255;

    let sum = 0;
    let samples = 0;
    for (let i = 0; i < curr.length; i += 4) {
      if (this._diffMask && this._diffMask[i >> 2] !== 1) continue;
      sum += Math.abs(curr[i] - this._lastDiff[i])
        + Math.abs(curr[i + 1] - this._lastDiff[i + 1])
        + Math.abs(curr[i + 2] - this._lastDiff[i + 2]);
      samples++;
    }
    if (!samples) return 255;
    return sum / (samples * 3);
  }

  _updateDiffRef() {
    const ctx = this._diffCtx;
    this._lastDiff = new Uint8ClampedArray(ctx.getImageData(0, 0, 64, 64).data);
  }

  _isTargetReached() {
    if (this._settings.targetMode === 'total') {
      return this._entries.length >= this._settings.targetCount;
    }

    const requiredIds = this._capturableClassIds();
    if (!requiredIds.length) return false;
    for (const id of requiredIds) {
      if ((this._classCounts.get(id) ?? 0) < this._settings.targetCount) return false;
    }
    return true;
  }

  _targetTotal() {
    if (this._settings.targetMode === 'total') return this._settings.targetCount;
    return this._settings.targetCount * this._capturableClassIds().length;
  }

  _finishRound(message, tone = 'done') {
    this._roundActive = false;
    this._paused = false;
    this._capturesRemaining = 0;
    this._framesUntilNext = 0;
    this._nextCaptureAt = 0;
    this._setStatus(message, tone);
    this._updateUI();
  }

  _flash() {
    if (!this._flashEl) return;
    this._flashEl.classList.remove('ds-capture-flash');
    void this._flashEl.offsetWidth;
    this._flashEl.classList.add('ds-capture-flash');
    setTimeout(() => this._flashEl.classList.remove('ds-capture-flash'), 220);
  }

  _setStatus(message, tone = 'neutral') {
    this._statusMessage = message;
    this._statusTone = tone;
    if (!this._el.statusMsg) return;
    this._el.statusMsg.textContent = message;
    this._el.statusMsg.className = `ds-status-msg ds-status-msg--${tone}`;
  }

  _buildDiffMask(ringMask, cropSize) {
    const srcW = cropSize.width;
    const srcH = cropSize.height;
    if (!ringMask || !srcW || !srcH) return;

    const out = new Uint8Array(64 * 64);
    let count = 0;
    for (let y = 0; y < 64; y++) {
      const sy = Math.min(srcH - 1, Math.floor((y / 64) * srcH));
      for (let x = 0; x < 64; x++) {
        const sx = Math.min(srcW - 1, Math.floor((x / 64) * srcW));
        const on = ringMask[(sy * srcW) + sx] ? 1 : 0;
        out[(y * 64) + x] = on;
        if (on) count++;
      }
    }
    this._diffMask = out;
    this._diffMaskCount = count;
  }

  _updateUI() {
    if (!this._el.totalProgress) return;

    const total = this._entries.length;
    const target = this._targetTotal();
    const pct = target > 0 ? Math.min(100, (total / target) * 100) : 0;
    this._el.totalProgress.textContent =
      `${total} image${total === 1 ? '' : 's'} collected · target ${target}`;
    this._el.overallFill.style.width = `${pct.toFixed(1)}%`;
    this._el.duplicateSkips.textContent = `Duplicate frames skipped: ${this._skipDuplicateCount}`;
    this._el.greenSkips.textContent = `No-green waits: ${this._skipNoGreenCount}`;
    this._el.predictionSkips.textContent = `No-eligible-frame skips: ${this._skipNoPredictionCount}`;

    if (this._roundActive) {
      if (this._paused) {
        this._el.roundState.textContent =
          `Round paused · ${this._capturesRemaining} valid frame${this._capturesRemaining === 1 ? '' : 's'} left`;
      } else if (this._settings.intervalMode === 'frames' && this._framesUntilNext > 0) {
        this._el.roundState.textContent =
          `Round active · ${this._capturesRemaining} frame${this._capturesRemaining === 1 ? '' : 's'} left · next in ${this._framesUntilNext} frame${this._framesUntilNext === 1 ? '' : 's'}`;
      } else if (this._settings.intervalMode === 'seconds' && this._nextCaptureAt > performance.now()) {
        const secs = (this._nextCaptureAt - performance.now()) / 1000;
        this._el.roundState.textContent =
          `Round active · ${this._capturesRemaining} frame${this._capturesRemaining === 1 ? '' : 's'} left · next in ${formatTime(secs)}`;
      } else {
        this._el.roundState.textContent =
          `Round active · ${this._capturesRemaining} valid frame${this._capturesRemaining === 1 ? '' : 's'} left`;
      }
    } else if (this._isTargetReached()) {
      this._el.roundState.textContent = 'Target reached · capture stopped';
    } else {
      this._el.roundState.textContent = 'Idle · press Space to start a round';
    }

    const classEntries = this._classEntries.length ? this._classEntries : this._capturableClassIds().map(id => ({ id, name: String(id) }));
    const maxCount = this._settings.targetMode === 'perClass'
      ? this._settings.targetCount
      : Math.max(1, ...classEntries.map(entry => this._classCounts.get(entry.id) ?? 0));
    this._el.classList.innerHTML = classEntries.map(entry => {
      const count = this._classCounts.get(entry.id) ?? 0;
      const barPct = Math.min(100, maxCount > 0 ? (count / maxCount) * 100 : 0);
      const full = this._settings.targetMode === 'perClass' && count >= this._settings.targetCount;
      return `<div class="ds-class-row${full ? ' ds-class-full' : ''}">
        <span class="ds-class-name"><span class="ds-class-id">#${entry.id}</span><span class="ds-class-label">${entry.name}</span></span>
        <div class="ds-mini-bar"><div style="width:${barPct.toFixed(1)}%"></div></div>
        <span class="ds-class-count">${count}${this._settings.targetMode === 'perClass' ? `/${this._settings.targetCount}` : ''}</span>
      </div>`;
    }).join('');

    const canDownload = this._entries.length > 0;
    this._el.downloadBtn.disabled = !canDownload;
    this._el.downloadBtn.textContent = this._isTargetReached() ? 'Download ZIP' : 'Download Partial ZIP';
  }

  async downloadZip() {
    if (!this._entries.length) return;
    if (!window.JSZip) {
      this._setStatus('JSZip is not loaded', 'error');
      return;
    }

    this._setStatus('Building ZIP…', 'active');
    const name = this._settings.datasetName || todayStr();
    const zip = new JSZip();
    const root = zip.folder(name);
    const images = root.folder('images');
    const labels = root.folder('labels');

    root.file('classes.txt', this._classesText);

    for (const entry of this._entries) {
      const stem = String(entry.id).padStart(6, '0');
      images.file(`${stem}.jpg`, entry.jpegB64, { base64: true });
      labels.file(`${stem}.txt`, `${entry.labelLine}\n`);
    }

    const blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this._setStatus(`Downloaded ${this._entries.length} image${this._entries.length === 1 ? '' : 's'}`, 'done');
  }

  reset() {
    this._entries = [];
    this._classCounts.clear();
    this._roundActive = false;
    this._paused = false;
    this._capturesRemaining = 0;
    this._framesUntilNext = 0;
    this._nextCaptureAt = 0;
    this._skipDuplicateCount = 0;
    this._skipNoGreenCount = 0;
    this._skipNoPredictionCount = 0;
    this._captureFrameCount = 0;
    this._fileIdx = 0;
    this._lastDiff = null;
    this._setStatus(
      this._classesValid ? 'Reset complete — press Space to start a round' : this._classesError,
      this._classesValid ? 'neutral' : 'error'
    );
    this._updateUI();
  }

  getDiffThreshold() {
    return this._settings.diffThreshold;
  }

  isRoundActive() {
    return this._roundActive;
  }

  isPaused() {
    return this._paused;
  }

  togglePause() {
    if (!this._roundActive) {
      this._setStatus('No active capture round to pause', 'neutral');
      this._updateUI();
      return false;
    }

    this._paused = !this._paused;
    this._setStatus(
      this._paused
        ? `Capture paused — ${this._capturesRemaining} valid frame${this._capturesRemaining === 1 ? '' : 's'} left`
        : `Capture resumed — ${this._capturesRemaining} valid frame${this._capturesRemaining === 1 ? '' : 's'} left`,
      this._paused ? 'warning' : 'active'
    );
    this._updateUI();
    return this._paused;
  }

  getStatusMessage() {
    return this._statusMessage;
  }

  getStatusTone() {
    return this._statusTone;
  }

  _template() {
    return `
<div class="ds-grid" id="ds-panel">
  <div class="ds-section ds-settings-col">
    <div class="ds-section-title">Dataset Setup</div>

    <label class="ds-field">
      <span class="ds-label">Dataset name</span>
      <input id="ds-name" type="text" class="ds-input" placeholder="${todayStr()}" />
    </label>

    <div class="ds-field">
      <span class="ds-label">classes.txt</span>
      <div class="ds-label-row">
        <input id="ds-classes-upload" type="file" accept=".txt" style="display:none" />
        <button id="ds-classes-btn" class="ds-btn-sm" type="button">Upload classes.txt</button>
        <span id="ds-classes-status" class="ds-muted">Upload a valid classes.txt to start capture</span>
      </div>
      <textarea id="ds-classes-text" class="ds-textarea" placeholder="ball&#10;0&#10;1&#10;...&#10;36&#10;invalid"></textarea>
    </div>

    <div class="ds-field">
      <span class="ds-label">Target</span>
      <div class="ds-radio-row">
        <label class="ds-radio"><input type="radio" name="ds-target-mode" value="total" checked /> Total images</label>
        <label class="ds-radio"><input type="radio" name="ds-target-mode" value="perClass" /> Per class</label>
        <input id="ds-target-count" type="number" class="ds-num" min="1" value="200" />
      </div>
    </div>

    <label class="ds-field ds-check-field">
      <input id="ds-undersample" type="checkbox" checked />
      <span>Undersample balance</span>
    </label>

    <div class="ds-inline-fields">
      <label class="ds-field">
        <span class="ds-label">Frames per round</span>
        <input id="ds-frames-per-round" type="number" class="ds-num" min="1" value="3" />
      </label>
      <label class="ds-field">
        <span class="ds-label">Interval mode</span>
        <select id="ds-interval-mode" class="ds-select">
          <option value="seconds">Seconds</option>
          <option value="frames">Frames</option>
        </select>
      </label>
      <label class="ds-field">
        <span class="ds-label">Interval value</span>
        <input id="ds-interval-value" type="number" class="ds-num" min="0" step="0.1" value="1" />
      </label>
    </div>

    <div class="ds-field">
      <span class="ds-label">Duplicate threshold <span id="ds-diff-value" class="ds-muted">15</span></span>
      <input id="ds-diff-threshold" type="range" class="ds-slider" min="1" max="50" value="15" />
    </div>
  </div>

  <div class="ds-section ds-progress-col">
    <div class="ds-section-title">Capture Progress</div>
    <div id="ds-total-progress" class="ds-total-line">0 images collected · target 0</div>
    <div class="ds-bar-track"><div id="ds-overall-fill" class="ds-bar-fill" style="width:0%"></div></div>
    <div id="ds-round-state" class="ds-total-line">Idle · press Space to start a round</div>
    <div id="ds-class-list" class="ds-class-list"></div>
    <div id="ds-duplicate-skips" class="ds-skip-line">Duplicate frames skipped: 0</div>
    <div id="ds-green-skips" class="ds-skip-line">No-green waits: 0</div>
    <div id="ds-prediction-skips" class="ds-skip-line">No-eligible-frame skips: 0</div>
  </div>

  <div class="ds-section ds-actions-col">
    <div class="ds-section-title">Controls</div>
    <div id="ds-status" class="ds-status-msg ds-status-msg--error">Upload a valid classes.txt to start capture</div>
    <div class="ds-hotkeys">
      <span><code>Space</code>: start one capture round</span>
      <span><code>F</code>: freeze or resume live playback</span>
    </div>
    <div class="ds-action-btns">
      <button id="ds-download" class="ds-btn ds-btn-primary" type="button" disabled>Download ZIP</button>
      <button id="ds-reset" class="ds-btn ds-btn-danger" type="button">Reset</button>
    </div>
  </div>
</div>`;
  }
}
