'use strict';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function intOr(fallback, value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class SettingsPanel {
  constructor(cfg, { onChange } = {}) {
    this.cfg = cfg;
    this._defaults = {
      filterUpMode: Boolean(cfg.filterUpMode),
      minBlockSize: cfg.minBlockSize,
      maxBlockSize: cfg.maxBlockSize,
      colorRed: cfg.colorRed.slice(),
      colorGreen: cfg.colorGreen.slice(),
      colorBlack: cfg.colorBlack.slice(),
    };
    this._onChange = onChange || (() => {});
    this._el = {};
  }

  mount(panelEl) {
    panelEl.innerHTML = this._template();
    const q = id => panelEl.querySelector(`#${id}`);
    this._el = {
      filterUp: q('st-filter-up'),
      minBlockSize: q('st-min-block-size'),
      maxBlockSize: q('st-max-block-size'),
      red: ['r', 'g', 'b'].map(id => ({
        min: q(`st-red-${id}-min`),
        max: q(`st-red-${id}-max`),
        value: q(`st-red-${id}-value`),
        track: q(`st-red-${id}-track`),
      })),
      green: ['r', 'g', 'b'].map(id => ({
        min: q(`st-green-${id}-min`),
        max: q(`st-green-${id}-max`),
        value: q(`st-green-${id}-value`),
        track: q(`st-green-${id}-track`),
      })),
      black: ['r', 'g', 'b'].map(id => ({
        min: q(`st-black-${id}-min`),
        max: q(`st-black-${id}-max`),
        value: q(`st-black-${id}-value`),
        track: q(`st-black-${id}-track`),
      })),
      resetBtn: q('st-reset'),
    };

    this._syncFromCfg();
    this._bindEvents();
  }

  _bindEvents() {
    this._el.filterUp.addEventListener('change', () => {
      this.cfg.filterUpMode = this._el.filterUp.checked;
      this._emitChange();
    });

    this._el.minBlockSize.addEventListener('input', () => {
      const next = Math.max(1, intOr(this.cfg.minBlockSize, this._el.minBlockSize.value));
      this.cfg.minBlockSize = next;
      if (this.cfg.maxBlockSize < next) {
        this.cfg.maxBlockSize = next;
        this._el.maxBlockSize.value = String(next);
      }
      this._emitChange();
    });

    this._el.maxBlockSize.addEventListener('input', () => {
      const next = Math.max(this.cfg.minBlockSize, intOr(this.cfg.maxBlockSize, this._el.maxBlockSize.value));
      this.cfg.maxBlockSize = next;
      this._emitChange();
    });

    for (const [key, pairs] of [
      ['colorRed', this._el.red],
      ['colorGreen', this._el.green],
      ['colorBlack', this._el.black],
    ]) {
      pairs.forEach((pair, idx) => {
        pair.min.addEventListener('input', () => {
          const values = this.cfg[key].slice();
          values[idx * 2] = clamp(intOr(values[idx * 2], pair.min.value), 0, values[(idx * 2) + 1]);
          this.cfg[key] = values;
          this._syncColorPair(pair, values[idx * 2], values[(idx * 2) + 1]);
          this._emitChange();
        });
        pair.max.addEventListener('input', () => {
          const values = this.cfg[key].slice();
          values[(idx * 2) + 1] = clamp(intOr(values[(idx * 2) + 1], pair.max.value), values[idx * 2], 255);
          this.cfg[key] = values;
          this._syncColorPair(pair, values[idx * 2], values[(idx * 2) + 1]);
          this._emitChange();
        });
      });
    }

    this._el.resetBtn.addEventListener('click', () => {
      this.cfg.filterUpMode = this._defaults.filterUpMode;
      this.cfg.minBlockSize = this._defaults.minBlockSize;
      this.cfg.maxBlockSize = this._defaults.maxBlockSize;
      this.cfg.colorRed = this._defaults.colorRed.slice();
      this.cfg.colorGreen = this._defaults.colorGreen.slice();
      this.cfg.colorBlack = this._defaults.colorBlack.slice();
      this._syncFromCfg();
      this._emitChange();
    });
  }

  _syncFromCfg() {
    this._el.filterUp.checked = Boolean(this.cfg.filterUpMode);
    this._el.minBlockSize.value = String(this.cfg.minBlockSize);
    this._el.maxBlockSize.value = String(this.cfg.maxBlockSize);
    this._syncColorGroup(this._el.red, this.cfg.colorRed);
    this._syncColorGroup(this._el.green, this.cfg.colorGreen);
    this._syncColorGroup(this._el.black, this.cfg.colorBlack);
  }

  _emitChange() {
    this._syncColorGroup(this._el.red, this.cfg.colorRed);
    this._syncColorGroup(this._el.green, this.cfg.colorGreen);
    this._syncColorGroup(this._el.black, this.cfg.colorBlack);
    this._onChange(this.cfg);
  }

  _syncColorGroup(group, values) {
    for (let i = 0; i < group.length; i++) {
      this._syncColorPair(group[i], values[i * 2], values[(i * 2) + 1]);
    }
  }

  _syncColorPair(pair, min, max) {
    pair.min.value = String(min);
    pair.max.value = String(max);
    pair.value.textContent = `${min}-${max}`;
    pair.track.style.setProperty('--range-start', `${(min / 255) * 100}%`);
    pair.track.style.setProperty('--range-end', `${(max / 255) * 100}%`);
  }

  _template() {
    const rangeField = (prefix, channel, label) => `
      <label class="st-slider-field">
        <span class="st-slider-top"><span>${label}</span><output id="st-${prefix}-${channel}-value">0-255</output></span>
        <span class="st-range-shell">
          <span id="st-${prefix}-${channel}-track" class="st-range-track"></span>
          <input id="st-${prefix}-${channel}-min" type="range" min="0" max="255" step="1" />
          <input id="st-${prefix}-${channel}-max" type="range" min="0" max="255" step="1" />
        </span>
      </label>`;

    const colorGrid = (prefix, title) => `
      <div class="st-color-group">
        <div class="st-subtitle">${title}</div>
        <div class="st-range-grid">
          ${rangeField(prefix, 'r', 'R range')}
          ${rangeField(prefix, 'g', 'G range')}
          ${rangeField(prefix, 'b', 'B range')}
        </div>
      </div>`;

    return `
      <div class="settings-shell">
        <div class="settings-header">
          <span class="settings-title">Live Settings</span>
          <button id="st-reset" class="settings-reset" type="button">Reset Defaults</button>
        </div>

        <label class="st-toggle">
          <input id="st-filter-up" type="checkbox" />
          <span>Enable center-top filter</span>
        </label>

        <div class="st-size-grid">
          <label class="st-field">
            <span>Min blob size</span>
            <input id="st-min-block-size" type="number" min="1" />
          </label>
          <label class="st-field">
            <span>Max blob size</span>
            <input id="st-max-block-size" type="number" min="1" />
          </label>
        </div>

        ${colorGrid('red', 'Red Range')}
        ${colorGrid('green', 'Green Range')}
        ${colorGrid('black', 'Black Range')}
      </div>
    `;
  }
}
