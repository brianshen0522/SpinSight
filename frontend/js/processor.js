'use strict';

// Non-matching pixel fill — matches Python's `np.full_like(img, 70)`
const BG = 70;
const LABEL_CROP_PADDING = 15;

// ── Two-pass union-find connected components ──────────────────────────────────

function convexHull(points) {
  if (points.length <= 1) return points.slice();
  const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o, a, b) => ((a.x - o.x) * (b.y - o.y)) - ((a.y - o.y) * (b.x - o.x));
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function normalizeAngleDeg(angle) {
  let out = angle;
  while (out < -90) out += 180;
  while (out >= 90) out -= 180;
  return out;
}

function boxPoints(rect) {
  const { cx, cy, w, h, angle } = rect;
  const th = angle * Math.PI / 180;
  const ux = Math.cos(th);
  const uy = Math.sin(th);
  const vx = -uy;
  const vy = ux;
  const hw = w / 2;
  const hh = h / 2;
  return [
    { x: cx - ux * hw - vx * hh, y: cy - uy * hw - vy * hh },
    { x: cx + ux * hw - vx * hh, y: cy + uy * hw - vy * hh },
    { x: cx + ux * hw + vx * hh, y: cy + uy * hw + vy * hh },
    { x: cx - ux * hw + vx * hh, y: cy - uy * hw + vy * hh },
  ];
}

function bottomEdgeIndex(pts, rcx, rcy) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 4; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % 4];
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const d = Math.hypot(mx - rcx, my - rcy);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function minAreaRect(points) {
  if (!points.length) return null;
  if (points.length === 1) {
    return { cx: points[0].x, cy: points[0].y, w: 1, h: 1, angle: 0 };
  }

  const hull = convexHull(points);
  if (hull.length === 2) {
    const [p0, p1] = hull;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    return {
      cx: (p0.x + p1.x) / 2,
      cy: (p0.y + p1.y) / 2,
      w: Math.hypot(dx, dy),
      h: 1,
      angle: normalizeAngleDeg(Math.atan2(dy, dx) * 180 / Math.PI),
    };
  }

  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const p0 = hull[i];
    const p1 = hull[(i + 1) % hull.length];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (!len) continue;

    const ux = dx / len;
    const uy = dy / len;
    const vx = -uy;
    const vy = ux;

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = p.x * vx + p.y * vy;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const w = maxU - minU + 1;
    const h = maxV - minV + 1;
    const area = w * h;
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        area,
        cx: (cu * ux) + (cv * vx),
        cy: (cu * uy) + (cv * vy),
        w,
        h,
        angle: normalizeAngleDeg(Math.atan2(uy, ux) * 180 / Math.PI),
      };
    }
  }
  return best;
}

function expandRotatedRect(rect, padding) {
  return { ...rect, w: rect.w + padding, h: rect.h + padding };
}

function cropBoxHitsUpRay(pts, rcx, rcy) {
  const rayTop = 0;

  const pointOnRay = (p) => Math.round(p.x) === Math.round(rcx) && p.y >= rayTop && p.y <= rcy;
  if (pts.some(pointOnRay)) return true;

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    if (rcx < minX || rcx > maxX) continue;

    const dx = b.x - a.x;
    if (Math.abs(dx) < 1e-6) {
      if (Math.abs(a.x - rcx) > 1e-6) continue;
      const segMinY = Math.min(a.y, b.y);
      const segMaxY = Math.max(a.y, b.y);
      if (segMinY <= rcy && segMaxY >= rayTop) return true;
      continue;
    }

    const t = (rcx - a.x) / dx;
    if (t < 0 || t > 1) continue;
    const y = a.y + (b.y - a.y) * t;
    if (y >= rayTop && y <= rcy) return true;
  }
  return false;
}

function fillMaskHoles(mask, w, h) {
  const n = w * h;
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;

  const pushIfOpen = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = y * w + x;
    if (mask[i] || outside[i]) return;
    outside[i] = 1;
    stack[sp++] = i;
  };

  for (let x = 0; x < w; x++) {
    pushIfOpen(x, 0);
    pushIfOpen(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    pushIfOpen(0, y);
    pushIfOpen(w - 1, y);
  }

  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i / w) | 0;
    pushIfOpen(x - 1, y);
    pushIfOpen(x + 1, y);
    pushIfOpen(x, y - 1);
    pushIfOpen(x, y + 1);
  }

  for (let i = 0; i < n; i++) {
    if (!mask[i] && !outside[i]) mask[i] = 1;
  }
}

function findBlobs(mask, w, h, minSz, maxSz, rcx, rcy, filterUp) {
  const n   = w * h;
  const lbl = new Int32Array(n);
  const par = new Int32Array(n + 1);  // 1-indexed
  let next  = 1;
  const rayX = Math.round(rcx);
  const rayY = Math.floor(rcy);

  const find = (x) => {
    while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; }
    return x;
  };

  // First pass — label + link
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const ab = y > 0 ? lbl[i - w] : 0;
      const le = x > 0 ? lbl[i - 1] : 0;
      if (!ab && !le) {
        par[next] = next; lbl[i] = next++;
      } else if (ab && !le) {
        lbl[i] = ab;
      } else if (!ab && le) {
        lbl[i] = le;
      } else {
        lbl[i] = ab;
        const ra = find(ab), rl = find(le);
        if (ra !== rl) par[ra] = rl;
      }
    }
  }

  // Second pass — aggregate per root
  const map = new Map();
  for (let i = 0; i < n; i++) {
    if (!lbl[i]) continue;
    const root = find(lbl[i]);
    let b = map.get(root);
    if (!b) {
      b = { a:0, x0:w, x1:0, y0:h, y1:0, sx:0, sy:0, hitUp:false };
      map.set(root, b);
    }
    const x = i % w, y = (i / w) | 0;
    b.a++;
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
    b.sx += x; b.sy += y;
    if (filterUp && x === rayX && y <= rayY) b.hitUp = true;
  }

  const out = [];
  const validRoots = new Set();
  for (const [root, b] of map) {
    if (b.a < minSz || b.a > maxSz) continue;
    if (filterUp && b.hitUp) continue;

    validRoots.add(root);
    out.push({
      root,
      area: b.a,
      x: b.x0,
      y: b.y0,
      w: b.x1 - b.x0 + 1,
      h: b.y1 - b.y0 + 1,
      cx: b.sx / b.a,
      cy: b.sy / b.a,
      points: [],
    });
  }

  if (!out.length) return out;

  const byRoot = new Map(out.map(blob => [blob.root, blob]));
  for (let i = 0; i < n; i++) {
    if (!lbl[i]) continue;
    const root = find(lbl[i]);
    if (!validRoots.has(root)) continue;
    const blob = byRoot.get(root);
    const x = i % w;
    const y = (i / w) | 0;
    blob.points.push({ x, y });
  }

  for (const blob of out) {
    blob.labelRect = minAreaRect(blob.points);
    blob.cropRect = expandRotatedRect(blob.labelRect, LABEL_CROP_PADDING);
    blob.labelBox = boxPoints(blob.labelRect);
    blob.cropBox = boxPoints(blob.cropRect);
    blob.bottomIdx = bottomEdgeIndex(blob.cropBox, rcx, rcy);
    blob.hitUpRay = filterUp && cropBoxHitsUpRay(blob.cropBox, rcx, rcy);
    delete blob.points;
    delete blob.root;
  }
  return out.filter(blob => !blob.hitUpRay);
}

// ── Main processor ────────────────────────────────────────────────────────────

export class RingProcessor {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.blockListEl = opts.blockListEl || null;
    this.blockListMetaEl = opts.blockListMetaEl || null;
    this._lastListPaint = 0;
    const [, , cw, ch] = cfg.cropRegion;
    this.cw = cw; this.ch = ch;

    // Ring centre in crop-local coords (matches Python's out_cx / out_cy)
    const [ox, oy] = cfg.cropRegion;
    const oe = cfg.outerEllipse;
    const ie = cfg.innerEllipse;
    // Average of outer + inner centres — same as draw_ring_center in Python
    if (oe && ie) {
      this.rcx = ((oe[0] + ie[0]) / 2) - ox;
      this.rcy = ((oe[1] + ie[1]) / 2) - oy;
    } else if (oe) {
      this.rcx = oe[0] - ox;
      this.rcy = oe[1] - oy;
    } else {
      this.rcx = cw / 2;
      this.rcy = ch / 2;
    }

    const npx = cw * ch;

    // Pre-allocated buffers — no GC per frame
    this._outR    = new Uint8ClampedArray(npx * 4);
    this._outG    = new Uint8ClampedArray(npx * 4);
    this._outB    = new Uint8ClampedArray(npx * 4);
    this._binR    = new Uint8Array(npx);
    this._binG    = new Uint8Array(npx);
    this._binB    = new Uint8Array(npx);

    this._imgR    = new ImageData(cw, ch);
    this._imgG    = new ImageData(cw, ch);
    this._imgB    = new ImageData(cw, ch);

    // Offscreen canvas for frame capture
    this._vc   = document.createElement('canvas');
    this._vctx = this._vc.getContext('2d', { willReadFrequently: true });
    this._cropCanvas = document.createElement('canvas');
    this._cropCtx = this._cropCanvas.getContext('2d', { willReadFrequently: true });

    this.ringMask = this._buildRingMask();
  }

  // Compute a boolean mask: 1 = inside ring (between inner and outer ellipses)
  _buildRingMask() {
    const { cropRegion, outerEllipse: oe, innerEllipse: ie } = this.cfg;
    if (!oe || !ie) return null;

    const [ox, oy, cw, ch] = cropRegion;

    // Ellipse params in crop-local coords
    const ocx = oe[0]-ox, ocy = oe[1]-oy, oa = oe[2]/2, ob = oe[3]/2;
    const icx = ie[0]-ox, icy = ie[1]-oy, ia = ie[2]/2, ib = ie[3]/2;
    const ophiR = oe[4] * Math.PI / 180;
    const iphiR = ie[4] * Math.PI / 180;
    const ocos = Math.cos(ophiR), osin = Math.sin(ophiR);
    const icos = Math.cos(iphiR), isin = Math.sin(iphiR);

    const mask = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        // Must be inside outer ellipse
        const dxo = x-ocx, dyo = y-ocy;
        const uo  =  dxo*ocos + dyo*osin;
        const vo  = -dxo*osin + dyo*ocos;
        if (uo*uo/(oa*oa) + vo*vo/(ob*ob) > 1) continue;

        // Must be outside inner ellipse
        const dxi = x-icx, dyi = y-icy;
        const ui  =  dxi*icos + dyi*isin;
        const vi  = -dxi*isin + dyi*icos;
        if (ui*ui/(ia*ia) + vi*vi/(ib*ib) < 1) continue;

        mask[y*cw + x] = 1;
      }
    }
    return mask;
  }

  // ctxs = [origCtx, redCtx, greenCtx, blackCtx]
  captureCrop(video) {
    const { cropRegion: [cx, cy, cw, ch],
    } = this.cfg;

    // Sync offscreen canvas to video native resolution
    if (this._vc.width !== video.videoWidth || this._vc.height !== video.videoHeight) {
      this._vc.width  = video.videoWidth  || 1920;
      this._vc.height = video.videoHeight || 1080;
    }
    this._vctx.drawImage(video, 0, 0);
    if (this._cropCanvas.width !== cw || this._cropCanvas.height !== ch) {
      this._cropCanvas.width = cw;
      this._cropCanvas.height = ch;
    }
    this._cropCtx.drawImage(this._vc, cx, cy, cw, ch, 0, 0, cw, ch);
    return this._cropCanvas;
  }

  // ctxs = [origCtx, redCtx, greenCtx, blackCtx]
  process(video, ctxs) {
    const { cropRegion: [cx, cy, cw, ch],
            colorRed: cr, colorGreen: cg, colorBlack: cb,
            minBlockSize, maxBlockSize,
            filterUpMode = false } = this.cfg;

    this.captureCrop(video);

    // Extract crop — same as Python's apply_crop: frame[y:y+h, x:x+w]
    const src = this._vctx.getImageData(cx, cy, cw, ch).data;

    const rm = this.ringMask;
    const { _outR: outR, _outG: outG, _outB: outB,
            _binR: binR, _binG: binG, _binB: binB } = this;

    // ── Single-pass pixel processing (cropped region, 3 colour channels) ─────
    const npx = cw * ch;
    for (let i = 0; i < npx; i++) {
      const p = i << 2;
      const r = src[p], g = src[p+1], b = src[p+2];
      const inRing = !rm || rm[i];

      // ── Color membership (only meaningful inside ring) ─────────────────────
      const mR = inRing && r>=cr[0] && r<=cr[1] && g>=cr[2] && g<=cr[3] && b>=cr[4] && b<=cr[5];
      const mG = inRing && r>=cg[0] && r<=cg[1] && g>=cg[2] && g<=cg[3] && b>=cg[4] && b<=cg[5];
      const mB = inRing && r>=cb[0] && r<=cb[1] && g>=cb[2] && g<=cb[3] && b>=cb[4] && b<=cb[5];

      binR[i] = mR ? 1 : 0;
      binG[i] = mG ? 1 : 0;
      binB[i] = mB ? 1 : 0;

      // ── Filtered outputs: match → original colour, else → gray 70 ──────────
      // Matches: res = np.where(mask == 255, img, bg)  where bg = 70
      outR[p]   = mR ? r : BG;  outR[p+1] = mR ? g : BG;  outR[p+2] = mR ? b : BG;  outR[p+3] = 255;
      outG[p]   = mG ? r : BG;  outG[p+1] = mG ? g : BG;  outG[p+2] = mG ? b : BG;  outG[p+3] = 255;
      outB[p]   = mB ? r : BG;  outB[p+1] = mB ? g : BG;  outB[p+2] = mB ? b : BG;  outB[p+3] = 255;
    }

    // Fill hollow regions before pixel-count filtering, matching the desired block semantics.
    fillMaskHoles(binR, cw, ch);
    fillMaskHoles(binG, cw, ch);
    fillMaskHoles(binB, cw, ch);

    for (let i = 0; i < npx; i++) {
      const p = i << 2;
      const r = src[p], g = src[p+1], b = src[p+2];
      const fR = binR[i] === 1;
      const fG = binG[i] === 1;
      const fB = binB[i] === 1;
      outR[p]   = fR ? r : BG;  outR[p+1] = fR ? g : BG;  outR[p+2] = fR ? b : BG;
      outG[p]   = fG ? r : BG;  outG[p+1] = fG ? g : BG;  outG[p+2] = fG ? b : BG;
      outB[p]   = fB ? r : BG;  outB[p+1] = fB ? g : BG;  outB[p+2] = fB ? b : BG;
    }

    // ── Blob detection ───────────────────────────────────────────────────────
    const rcx = this.rcx, rcy = this.rcy;
    const blobsR = findBlobs(binR, cw, ch, minBlockSize, maxBlockSize, rcx, rcy, filterUpMode);
    const blobsG = findBlobs(binG, cw, ch, minBlockSize, maxBlockSize, rcx, rcy, filterUpMode);
    const blobsB = findBlobs(binB, cw, ch, minBlockSize, maxBlockSize, rcx, rcy, filterUpMode);

    // ── Top-left quadrant: full frame + crop / label overlays ───────────────
    this._processOrig(ctxs[0], [blobsR, blobsG, blobsB]);

    // ── Write pixel data to canvases ─────────────────────────────────────────
    this._imgR.data.set(outR);
    this._imgG.data.set(outG);
    this._imgB.data.set(outB);

    ctxs[1].putImageData(this._imgR, 0, 0);
    ctxs[2].putImageData(this._imgG, 0, 0);
    ctxs[3].putImageData(this._imgB, 0, 0);

    // ── Overlays on filtered quadrants ────────────────────────────────────────
    const filteredCtxs   = [ctxs[1], ctxs[2], ctxs[3]];
    const filteredBlobs  = [blobsR, blobsG, blobsB];
    const filteredColors = ['#ff5050', '#50ff50', '#dcdcdc'];

    for (let ci = 0; ci < 3; ci++) {
      const ctx   = filteredCtxs[ci];
      const blobs = filteredBlobs[ci];
      const color = filteredColors[ci];
      this._drawEllipses(ctx);
      this._drawFilterRay(ctx);
      this._drawStats(ctx, blobs, filterUpMode);
      for (const blob of blobs) this._drawBlobBox(ctx, blob, color, true);
    }

    return { blobsR, blobsG, blobsB };
  }

  // Public — call from outside after prediction is computed
  renderBlockList(blobsR, blobsG, blobsB, predMap = null) {
    this._renderBlockList([
      { key: 'Red',   color: '#ff5050', blobs: blobsR },
      { key: 'Green', color: '#50ff50', blobs: blobsG },
      { key: 'Black', color: '#dcdcdc', blobs: blobsB },
    ], predMap);
  }

  getCropCanvas() {
    return this._cropCanvas;
  }

  getRingMask() {
    return this.ringMask;
  }

  getCropSize() {
    return { width: this.cw, height: this.ch };
  }

  exportDetectionCrop(blob, classId) {
    const { cropRect, labelBox, bottomIdx } = blob;
    if (!cropRect || !labelBox || !labelBox.length) return null;

    const { cx, cy, w, h, angle } = cropRect;
    const isVerticalEdge = (bottomIdx === 1 || bottomIdx === 3);
    const tw = Math.max(1, Math.round(isVerticalEdge ? h : w));
    const th = Math.max(1, Math.round(isVerticalEdge ? w : h));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    const offsets = [180, 90, 0, -90];
    const rotationDeg = offsets[bottomIdx] - angle;
    ctx.rotate(rotationDeg * Math.PI / 180);
    ctx.drawImage(this._cropCanvas, -cx, -cy);
    ctx.restore();

    const transformed = labelBox.map(pt =>
      transformPointToCropCanvas(pt.x, pt.y, cropRect, bottomIdx, canvas.width, canvas.height)
    );
    const xs = transformed.map(pt => pt.x);
    const ys = transformed.map(pt => pt.y);
    const minX = Math.max(0, Math.min(...xs));
    const maxX = Math.min(canvas.width, Math.max(...xs));
    const minY = Math.max(0, Math.min(...ys));
    const maxY = Math.min(canvas.height, Math.max(...ys));
    if (maxX <= minX || maxY <= minY) return null;

    const cxNorm = ((minX + maxX) / 2) / canvas.width;
    const cyNorm = ((minY + maxY) / 2) / canvas.height;
    const wNorm = (maxX - minX) / canvas.width;
    const hNorm = (maxY - minY) / canvas.height;

    return {
      jpegB64: canvas.toDataURL('image/jpeg', 0.92).split(',')[1],
      labelLine: `${classId} ${cxNorm.toFixed(6)} ${cyNorm.toFixed(6)} ${wNorm.toFixed(6)} ${hNorm.toFixed(6)}`,
    };
  }

  // Top-left quadrant: full stream + translated crop / label overlays
  _processOrig(ctx, blobGroups) {
    const { cropRegion: [ox, oy] } = this.cfg;
    const vw = this._vc.width, vh = this._vc.height;
    if (!vw || !vh) return;

    const c = ctx.canvas;
    if (c.width !== vw || c.height !== vh) { c.width = vw; c.height = vh; }

    ctx.drawImage(this._vc, 0, 0);
    this._drawFilterRayFull(ctx);

    for (const [blobs, color] of zipBlobGroups(blobGroups, ['#ff5050', '#50ff50', '#dcdcdc'])) {
      for (const blob of blobs) {
        this._drawBlobBox(ctx, blob, color, true, ox, oy);
      }
    }
  }

  _drawFilterRayFull(ctx) {
    const { cropRegion: [ox, oy] } = this.cfg;
    const rx = Math.round(this.rcx + ox);
    const ry = Math.floor(this.rcy + oy);
    ctx.save();
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth   = 3;
    ctx.setLineDash([]);
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx, 0);
    ctx.stroke();
    ctx.restore();
  }

  // Draw outer + inner ellipses and ring-centre crosshair (crop-local coords)
  _drawEllipses(ctx) {
    const { cropRegion: [ox, oy], outerEllipse: oe, innerEllipse: ie } = this.cfg;
    ctx.save();
    ctx.strokeStyle = '#00dc00';
    ctx.lineWidth   = 2;
    for (const e of [oe, ie]) {
      if (!e) continue;
      ctx.save();
      ctx.translate(e[0]-ox, e[1]-oy);
      ctx.rotate(e[4] * Math.PI / 180);
      ctx.beginPath();
      ctx.ellipse(0, 0, e[2]/2, e[3]/2, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // Cyan crosshair at ring centre — matches draw_ring_center in Python
    const rx = this.rcx, ry = this.rcy;
    ctx.strokeStyle = '#00dcff';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(rx-14, ry); ctx.lineTo(rx+14, ry);
    ctx.moveTo(rx, ry-14); ctx.lineTo(rx, ry+14);
    ctx.stroke();
    ctx.fillStyle = '#00dcff';
    ctx.beginPath(); ctx.arc(rx, ry, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  _drawFilterRay(ctx) {
    const rx = Math.round(this.rcx);
    const ry = Math.floor(this.rcy);
    ctx.save();
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth   = 3;
    ctx.setLineDash([]);
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx, 0);
    ctx.stroke();
    ctx.restore();
  }

  // Rotated crop box + optional bottom-edge highlight (cyan)
  // "Bottom edge" = side whose midpoint is closest to ring centre
  // Matches Python's minAreaRect + expand_rotated_rect + get_rectified_patch logic
  _drawBlobBox(ctx, blob, color, withBottomEdge, offsetX = 0, offsetY = 0) {
    const { cropBox, labelBox, bottomIdx, area } = blob;
    if (!cropBox || !cropBox.length) return;
    ctx.save();

    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(cropBox[0].x + offsetX, cropBox[0].y + offsetY);
    for (let i = 1; i < cropBox.length; i++) ctx.lineTo(cropBox[i].x + offsetX, cropBox[i].y + offsetY);
    ctx.closePath();
    ctx.stroke();

    if (labelBox && labelBox.length) {
      ctx.strokeStyle = '#ffb400';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(labelBox[0].x + offsetX, labelBox[0].y + offsetY);
      for (let i = 1; i < labelBox.length; i++) ctx.lineTo(labelBox[i].x + offsetX, labelBox[i].y + offsetY);
      ctx.closePath();
      ctx.stroke();
    }

    if (withBottomEdge) {
      const p1 = cropBox[bottomIdx];
      const p2 = cropBox[(bottomIdx + 1) % cropBox.length];
      ctx.strokeStyle = '#00ffff';
      ctx.lineWidth   = 2.5;
      ctx.beginPath();
      ctx.moveTo(p1.x + offsetX, p1.y + offsetY);
      ctx.lineTo(p2.x + offsetX, p2.y + offsetY);
      ctx.stroke();
    }

    ctx.fillStyle = color;
    ctx.font      = '11px monospace';
    const labelAnchor = labelBox && labelBox.length ? labelBox[0] : cropBox[0];
    ctx.fillText(area, labelAnchor.x + offsetX + 2, labelAnchor.y + offsetY - 3);

    ctx.restore();
  }

  // Stats bar at top-left — matches Python's stat_text
  _drawStats(ctx, blobs, filterUpMode) {
    if (!blobs.length) return;
    const areas = blobs.map(b => b.area);
    const mn = Math.min(...areas), mx = Math.max(...areas);
    const avg = (areas.reduce((a, b) => a + b, 0) / areas.length) | 0;
    ctx.save();
    ctx.font      = '13px monospace';
    ctx.fillStyle = '#00ff00';
    const flags = filterUpMode ? '[SZ UP ON]' : '[SZ ON]';
    ctx.fillText(`MIN:${mn} MAX:${mx} AVG:${avg} CNT:${blobs.length} ${flags}`, 6, 18);
    ctx.restore();
  }

  _renderBlockList(groups, predMap = null) {
    if (!this.blockListEl) return;
    const now = performance.now();
    if (now - this._lastListPaint < 180) return;
    this._lastListPaint = now;

    const items = [];
    for (const group of groups) {
      for (const blob of group.blobs) items.push({ ...group, blob });
    }
    items.sort((a, b) => {
      const angA = this._clockwiseAngleFromTop(a.blob);
      const angB = this._clockwiseAngleFromTop(b.blob);
      if (angA !== angB) return angA - angB;
      const distA = Math.hypot(a.blob.cx - this.rcx, a.blob.cy - this.rcy);
      const distB = Math.hypot(b.blob.cx - this.rcx, b.blob.cy - this.rcy);
      return distA - distB;
    });

    if (this.blockListMetaEl) {
      this.blockListMetaEl.textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
    }

    this.blockListEl.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'block-empty';
      empty.textContent = 'No blocks detected';
      this.blockListEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of items) frag.appendChild(this._buildBlockCard(item, predMap));
    this.blockListEl.appendChild(frag);
  }

  _clockwiseAngleFromTop(blob) {
    const dx = blob.cx - this.rcx;
    const dy = blob.cy - this.rcy;
    return (Math.atan2(dx, -dy) + (Math.PI * 2)) % (Math.PI * 2);
  }

  _buildBlockCard(item, predMap = null) {
    const { color, blob } = item;
    const card = document.createElement('article');
    card.className = 'block-card';
    card._blob = blob;  // store reference for prediction overlay

    const canvas = document.createElement('canvas');
    canvas.className = 'block-crop-canvas';
    this._drawCropWithLabel(canvas, blob, color);

    const meta = document.createElement('div');
    meta.className = 'block-meta';

    const dot = document.createElement('span');
    dot.className = 'block-color-dot';
    dot.style.background = color;

    const info = document.createElement('span');
    info.textContent = `${blob.area}`;

    // Prediction badge (confirmed number, inferred orphan number, or orphan marker)
    const seg = predMap && predMap.get(blob);
    if (seg) {
      const badge = document.createElement('span');
      if (seg.orphan) {
        if (seg.resolved && seg.number != null) {
          badge.className = `block-pred-num block-pred-num--${seg.color} block-pred-num--inferred`;
          badge.textContent = seg.number;
          badge.title = 'Orphan (inferred)';
        } else {
          badge.className = 'block-pred-num block-pred-num--orphan';
          badge.textContent = seg.resolved ? '~' : '?';
          badge.title = seg.resolved ? 'Orphan — resolved' : 'Orphan — unresolved';
        }
      } else {
        badge.className = `block-pred-num block-pred-num--${seg.color}`;
        badge.textContent = seg.number;
      }
      meta.appendChild(badge);
    }

    meta.appendChild(dot);
    meta.appendChild(info);
    card.appendChild(canvas);
    card.appendChild(meta);
    return card;
  }

  // Rectifies the image and draws all overlays (cropBox, labelBox, bottom edge)
  // in a way that is 100% consistent with the Original view.
  _drawCropWithLabel(canvas, blob, color) {
    const { cropRect, labelRect, bottomIdx, cropBox, labelBox } = blob;
    const { cx, cy, w, h, angle } = cropRect;

    // 1. Determine target canvas dimensions based on rotation
    // If the bottom edge is a "height" side (index 1 or 3), swap width/height.
    const isVerticalEdge = (bottomIdx === 1 || bottomIdx === 3);
    const tw = isVerticalEdge ? h : w;
    const th = isVerticalEdge ? w : h;

    canvas.width  = Math.max(1, Math.round(tw));
    canvas.height = Math.max(1, Math.round(th));

    const ctx = canvas.getContext('2d');
    ctx.save();

    // 2. Rectify the coordinate system
    // First, move to the center of the thumbnail canvas
    ctx.translate(canvas.width / 2, canvas.height / 2);

    // Calculate rotation:
    // - Subtract 'angle' to level the box (make it axis-aligned).
    // - Add offset to bring the specific bottomIdx edge to the bottom of the canvas.
    const offsets = [180, 90, 0, -90];
    const rotationDeg = offsets[bottomIdx] - angle;
    ctx.rotate(rotationDeg * Math.PI / 180);

    // 3. Draw the image
    // Instead of taking an axis-aligned slice (which fails for rotated content),
    // we draw the source _cropCanvas such that its (cx, cy) point maps to our current (0,0).
    ctx.drawImage(this._cropCanvas, -cx, -cy);

    // 4. Draw Overlays using original coordinates
    // Shift origin back so that (px, py) in crop-local space maps correctly.
    ctx.translate(-cx, -cy);

    // --- Draw Crop Box (Colored) ---
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(cropBox[0].x, cropBox[0].y);
    for (let i = 1; i < cropBox.length; i++) ctx.lineTo(cropBox[i].x, cropBox[i].y);
    ctx.closePath();
    ctx.stroke();

    // --- Draw Label Box (Orange) ---
    if (labelBox) {
      ctx.strokeStyle = '#ffb400';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(labelBox[0].x, labelBox[0].y);
      for (let i = 1; i < labelBox.length; i++) ctx.lineTo(labelBox[i].x, labelBox[i].y);
      ctx.closePath();
      ctx.stroke();
    }

    // --- Draw Cyan Bottom Edge ---
    const p1 = cropBox[bottomIdx];
    const p2 = cropBox[(bottomIdx + 1) % cropBox.length];
    ctx.strokeStyle = '#00ffff';
    ctx.lineWidth   = 3;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    ctx.restore();
  }
}

function zipBlobGroups(groups, colors) {
  return groups.map((blobs, idx) => [blobs, colors[idx]]);
}

function transformPointToCropCanvas(px, py, cropRect, bottomIdx, canvasWidth, canvasHeight) {
  const offsets = [180, 90, 0, -90];
  const rotationDeg = offsets[bottomIdx] - cropRect.angle;
  const th = rotationDeg * Math.PI / 180;
  const dx = px - cropRect.cx;
  const dy = py - cropRect.cy;
  return {
    x: (canvasWidth / 2) + (dx * Math.cos(th)) - (dy * Math.sin(th)),
    y: (canvasHeight / 2) + (dx * Math.sin(th)) + (dy * Math.cos(th)),
  };
}
