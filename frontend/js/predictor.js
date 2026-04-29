'use strict';

// European roulette wheel — clockwise order starting from 0
const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const N = WHEEL.length; // 37

const RED_SET = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

function numberColor(n) {
  if (n === 0) return 'green';
  return RED_SET.has(n) ? 'red' : 'black';
}

function aabbOverlap(a, b, pad = 10) {
  return (a.x - pad) <= (b.x + b.w) &&
         (b.x - pad) <= (a.x + a.w) &&
         (a.y - pad) <= (b.y + b.h) &&
         (b.y - pad) <= (a.y + a.h);
}

function centroidDist(a, b) {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

// ── Main chain builder ────────────────────────────────────────────────────────

function buildMainChain(pool, blobsG) {
  if (!blobsG.length) return null;

  // Largest green blob anchors to number 0
  const anchor = blobsG.reduce((best, b) => b.area > best.area ? b : best);
  const assigned = new Set([anchor]);

  function walk(dir) {
    const segments = [];
    let prev = anchor;
    for (let step = 1; step < N; step++) {
      const idx = ((dir * step) % N + N) % N;
      const num = WHEEL[idx];
      const expectedColor = numberColor(num);
      const candidates = pool.filter(p =>
        p.color === expectedColor && !assigned.has(p.blob) && aabbOverlap(prev, p.blob)
      );
      if (!candidates.length) break;
      const best = candidates.reduce((a, b) =>
        centroidDist(a.blob, prev) <= centroidDist(b.blob, prev) ? a : b
      );
      assigned.add(best.blob);
      segments.push({ number: num, color: expectedColor, blob: best.blob });
      prev = best.blob;
    }
    return segments;
  }

  const cw  = walk(+1);
  const ccw = walk(-1);

  const chain = [
    ...ccw.reverse(),
    { number: 0, color: 'green', blob: anchor },
    ...cw,
  ];

  return { chain, assigned };
}

// ── Orphan group detection ────────────────────────────────────────────────────

function findOrphanGroups(pool, assigned) {
  const orphans = pool.filter(p => !assigned.has(p.blob));
  if (!orphans.length) return [];

  // Adjacency graph among orphan blobs
  const adj = new Map(orphans.map(p => [p.blob, []]));
  for (let i = 0; i < orphans.length; i++) {
    for (let j = i + 1; j < orphans.length; j++) {
      if (aabbOverlap(orphans[i].blob, orphans[j].blob)) {
        adj.get(orphans[i].blob).push(orphans[j]);
        adj.get(orphans[j].blob).push(orphans[i]);
      }
    }
  }

  // Connected components — each component is one orphan group
  const visited = new Set();
  const groups = [];
  for (const p of orphans) {
    if (visited.has(p.blob)) continue;
    const members = [];
    const queue = [p];
    visited.add(p.blob);
    while (queue.length) {
      const curr = queue.shift();
      members.push(curr);
      for (const nb of adj.get(curr.blob)) {
        if (!visited.has(nb.blob)) {
          visited.add(nb.blob);
          queue.push(nb);
        }
      }
    }
    groups.push({ members, adj });
  }
  return groups;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// BFS from startEp through orphan adjacency — returns blobs in chain order
function sortOrphanFromEndpoint(members, adj, startEp) {
  const visited = new Set([startEp.blob]);
  const sorted  = [startEp];
  const queue   = [startEp];
  while (queue.length) {
    const curr = queue.shift();
    for (const nb of adj.get(curr.blob)) {
      if (!visited.has(nb.blob)) {
        visited.add(nb.blob);
        sorted.push(nb);
        queue.push(nb);
      }
    }
  }
  return sorted;
}

// ── Orphan group resolution ───────────────────────────────────────────────────
//
// Strategy (handles exactly one hidden block between orphan endpoint and main chain):
//   1. Find orphan group endpoints (degree 0 or 1 in orphan adjacency graph).
//   2. For each endpoint find nearest main-chain blob and distance.
//   3. Process only the endpoint with the shorter gap.
//   4. Color check:
//      - Same color     → exactly 1 hidden block between them → attempt resolution.
//      - Different color → gap is 0 (should have been connected) or 2+ → unresolvable → '?'.
//   5. Validation (same-color case):
//      d1 = dist(endpoint A, second-nearest same-color in main chain)
//           This represents the typical 2-hop same-color spacing
//      d2 = dist(H midpoint, nearest opposite-color in main chain)
//           This represents roughly 1-hop spacing near H
//      Valid if dist(H, A) is between min(d1,d2) and max(d1,d2) ± tolerance.
//      Geometrically: with one hidden block, dist(H,A) ≈ 1 seg, d2 ≈ 1 seg, d1 ≈ 2+ segs.

function resolveOrphanGroup(group, chain) {
  const { members, adj } = group;

  // Endpoints: degree 0 (isolated) or 1 in the orphan adjacency graph
  const endpoints = members.filter(p => adj.get(p.blob).length <= 1);
  if (!endpoints.length) return { resolved: false };

  // For each endpoint find nearest main-chain blob
  function nearestInChain(ep) {
    let bestSeg = null, bestDist = Infinity;
    for (const s of chain) {
      const d = centroidDist(ep.blob, s.blob);
      if (d < bestDist) { bestDist = d; bestSeg = s; }
    }
    return { seg: bestSeg, dist: bestDist };
  }

  // Pick the endpoint with the shorter gap to the main chain
  let chosenEp = endpoints[0];
  let chosenNm = nearestInChain(endpoints[0]);
  for (let i = 1; i < endpoints.length; i++) {
    const nm = nearestInChain(endpoints[i]);
    if (nm.dist < chosenNm.dist) { chosenEp = endpoints[i]; chosenNm = nm; }
  }

  const nearestSeg = chosenNm.seg;

  // ── Different color → gap is ambiguous (0 or 2+ missing) → cannot resolve ────
  if (chosenEp.color !== nearestSeg.color) {
    console.debug('[orphan] different color → unresolvable',
      `ep=${chosenEp.color}(${chosenEp.blob.cx.toFixed(0)},${chosenEp.blob.cy.toFixed(0)})`,
      `nearest=${nearestSeg.color}#${nearestSeg.number}`);
    return { resolved: false };
  }

  // ── Same color → exactly 1 hidden block between them → validate ──────────────
  //
  // Geometric property:
  //   dist(A, nearestSeg) ≈ dist(nearestSeg, its next same-color in chain)
  //   Both represent the local "2-hop same-color spacing" (one hidden block between).
  //   Using a ratio makes this scale-invariant and robust to oblique perspective.

  const distAN = chosenNm.dist; // dist(orphan endpoint A → nearestSeg)

  const sameColorFromNearest = chain.filter(s => s.color === nearestSeg.color && s.blob !== nearestSeg.blob);
  if (!sameColorFromNearest.length) return { resolved: false };
  const nextSameFromNearest = sameColorFromNearest.reduce((a, b) =>
    centroidDist(a.blob, nearestSeg.blob) < centroidDist(b.blob, nearestSeg.blob) ? a : b
  );
  const distNX = centroidDist(nearestSeg.blob, nextSameFromNearest.blob);

  const ratio = distAN / distNX;
  console.debug('[orphan] same-color validation',
    `ep=${chosenEp.color} nearest=#${nearestSeg.number}`,
    `distAN=${distAN.toFixed(1)} distNX=${distNX.toFixed(1)}(#${nextSameFromNearest.number})`,
    `ratio=${ratio.toFixed(2)}`,
    ratio >= 0.5 && ratio <= 2.0 ? '✓ PASS' : '✗ FAIL');
  if (ratio < 0.5 || ratio > 2.0) return { resolved: false };

  const hiddenColor = chosenEp.color === 'red' ? 'black' : 'red';
  const hiddenPos   = {
    cx: (chosenEp.blob.cx + nearestSeg.blob.cx) / 2,
    cy: (chosenEp.blob.cy + nearestSeg.blob.cy) / 2,
  };

  // ── Determine walk direction and assign numbers ───────────────────────────────
  //
  // The main chain runs from chain[0] (CCW end) to chain[last] (CW end).
  // The orphan group sits in the gap; its chosen endpoint abuts one of these ends.
  //   nearestSeg === chain[last] → orphan is CW from chain end  → walk CW (+1)
  //   nearestSeg === chain[0]   → orphan is CCW from chain start → walk CCW (−1)
  //
  // `skip`: 1 for direct connection, 2 for one hidden block in between.

  const nearestWheelIdx = WHEEL.indexOf(nearestSeg.number);
  const skip = 2; // always 1 hidden block (same-color case)

  let dir, firstWheelIdx;
  const isChainEnd   = nearestSeg.number === chain[chain.length - 1].number;
  const isChainStart = nearestSeg.number === chain[0].number;

  if (isChainEnd) {
    dir           = +1;
    firstWheelIdx = (nearestWheelIdx + skip) % N;
  } else if (isChainStart) {
    dir           = -1;
    firstWheelIdx = (nearestWheelIdx - skip + N) % N;
  } else {
    // nearestSeg is mid-chain (unusual); connection validated but can't assign numbers
    return { resolved: true, endpoint: chosenEp, nearestMain: nearestSeg, hiddenColor, hiddenPos, numberedMembers: null };
  }

  // Sort orphan blobs from the chosen endpoint outward, then assign wheel numbers
  const sorted = sortOrphanFromEndpoint(members, adj, chosenEp);
  const numberedMembers = sorted.map((p, i) => ({
    blob:   p.blob,
    color:  p.color,
    number: WHEEL[((firstWheelIdx + dir * i) % N + N) % N],
  }));

  return { resolved: true, endpoint: chosenEp, nearestMain: nearestSeg, hiddenColor, hiddenPos, numberedMembers };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * predict(blobsR, blobsG, blobsB)
 *
 * Returns null if no green (0) blob detected.
 * Otherwise returns:
 * {
 *   chain:        [{ number, color, blob }]   — confirmed sequence anchored at 0
 *   orphanGroups: [OrphanGroup]               — unconnected blob clusters
 * }
 *
 * OrphanGroup: {
 *   members:     [{ blob, color }]
 *   resolved:    boolean
 *   endpoint:    { blob, color }   — the processed endpoint (shorter-gap side)
 *   nearestMain: { number, color, blob }
 *   hiddenColor: string | null     — null means direct link (different color)
 *   hiddenPos:   { cx, cy } | null — midpoint position of hypothetical hidden block
 * }
 */
export function predict(blobsR, blobsG, blobsB) {
  if (!blobsG.length) return null;

  const pool = [
    ...blobsR.map(b => ({ blob: b, color: 'red' })),
    ...blobsG.map(b => ({ blob: b, color: 'green' })),
    ...blobsB.map(b => ({ blob: b, color: 'black' })),
  ];

  const built = buildMainChain(pool, blobsG);
  if (!built) return null;

  const { chain, assigned } = built;

  const rawGroups   = findOrphanGroups(pool, assigned);
  const orphanGroups = rawGroups.map(g => ({
    members: g.members,
    ...resolveOrphanGroup(g, chain),
  }));

  return { chain, orphanGroups };
}
