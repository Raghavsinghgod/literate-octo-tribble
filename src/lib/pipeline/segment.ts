

export type DetectedObject = {
  box: { x: number; y: number; w: number; h: number };
  area: number;

  score: number;
};

export type Cutout = {

  alpha: Uint8ClampedArray;
  width: number;
  height: number;

  softPixels: number;

  touchedEdges: Set<number>;

  box: { x: number; y: number; w: number; h: number };

  candidates: DetectedObject[];

  confidence: number;
};

export type SegmentOptions = {
  tolerance?: number;
  noRetry?: boolean;
};

import { clamp255, distanceInside, distanceOutside } from "./pixels";

function kmeans(
  count: number,
  samples: Uint32Array,
  k: number,
  iters = 10,
): Array<[number, number, number]> {
  if (count === 0) return [[255, 255, 255]];
  if (count <= k) {
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i < count; i++) out.push(unpackPacked(samples[i]));
    return out;
  }

  const keyed = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const s = samples[i];
    const lum = ((s >> 16) & 255) + ((s >> 8) & 255) + (s & 255);
    keyed[i] = (lum << 22) | i;
  }
  const sorted = keyed.slice().sort();
  const unpack = unpackPacked;
  const centers: Array<[number, number, number]> = [];
  for (let c = 0; c < k; c++) {
    const idx = Math.min(
      sorted.length - 1,
      Math.floor(((c + 0.5) / k) * sorted.length),
    );
    centers.push(unpack(sorted[idx]));
  }

  const assign = new Uint8Array(count);
  for (let iter = 0; iter < iters; iter++) {
    let moved = false;
    for (let i = 0; i < count; i++) {
      const [r, g, b] = unpack(samples[i]);
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const [cr, cg, cb] = centers[c];
        const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
        if (d < bd) {
          bd = d;
          bi = c;
        }
      }
      if (assign[i] !== bi) {
        assign[i] = bi;
        moved = true;
      }
    }
    if (!moved && iter > 0) break;
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < count; i++) {
      const a = sums[assign[i]];
      const [r, g, b] = unpack(samples[i]);
      a[0] += r;
      a[1] += g;
      a[2] += b;
      a[3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c][3] > 0) {
        centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
  }
  return centers;
}

function unpackPacked(s: number): [number, number, number] {
  return [(s >> 16) & 255, (s >> 8) & 255, s & 255];
}

function bgDistance(
  r: number,
  g: number,
  b: number,
  centers: Array<[number, number, number]>,
  scale: [number, number, number],
): number {
  let best = Infinity;
  for (const [cr, cg, cb] of centers) {
    const dr = (r - cr) / scale[0];
    const dg = (g - cg) / scale[1];
    const db = (b - cb) / scale[2];
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    if (d < best) best = d;
  }
  return best;
}

function sobel(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    lum[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  const edge = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = lum[i - w - 1];
      const t = lum[i - w];
      const tr = lum[i - w + 1];
      const l = lum[i - 1];
      const r = lum[i + 1];
      const bl = lum[i + w - 1];
      const b = lum[i + w];
      const br = lum[i + w + 1];
      const gx = tl + 2 * l + bl - (tr + 2 * r + br);
      const gy = tl + 2 * t + tr - (bl + 2 * b + br);
      edge[i] = Math.min(255, Math.hypot(gx, gy));
    }
  }
  return edge;
}

function signedDistance(fg: Uint8Array, w: number, h: number): Float32Array {
  const inside = distanceInside(fg, w, h);
  const outside = distanceOutside(fg, w, h);
  const out = new Float32Array(fg.length);
  for (let i = 0; i < fg.length; i++) out[i] = fg[i] ? -inside[i] : outside[i];
  return out;
}

function boxErode(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w || !src[y * w + xx]) {
          v = 0;
          break;
        }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h || !tmp[yy * w + x]) {
          v = 0;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function boxDilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w && src[y * w + xx]) {
          v = 1;
          break;
        }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) {
          v = 1;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function fillHoles(fg: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(fg.length);
  const stack = new Int32Array(fg.length);
  let sp = 0;
  const visit = (x: number, y: number) => {
    const i = y * w + x;
    if (!outside[i] && !fg[i]) {
      outside[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    visit(x, 0);
    visit(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    visit(0, y);
    visit(w - 1, y);
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) visit(x - 1, y);
    if (x < w - 1) visit(x + 1, y);
    if (y > 0) visit(x, y - 1);
    if (y < h - 1) visit(x, y + 1);
  }
  const out = new Uint8Array(fg.length);
  for (let i = 0; i < fg.length; i++) out[i] = fg[i] || !outside[i] ? 1 : 0;
  return out;
}

function components(
  bin: Uint8Array,
  w: number,
  h: number,
): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(bin.length).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(bin.length);
  let next = 0;
  for (let s = 0; s < bin.length; s++) {
    if (!bin[s] || labels[s] !== -1) continue;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = next;
    let size = 0;
    while (sp > 0) {
      const i = stack[--sp];
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && bin[i - 1] && labels[i - 1] === -1) {
        labels[i - 1] = next;
        stack[sp++] = i - 1;
      }
      if (x < w - 1 && bin[i + 1] && labels[i + 1] === -1) {
        labels[i + 1] = next;
        stack[sp++] = i + 1;
      }
      if (y > 0 && bin[i - w] && labels[i - w] === -1) {
        labels[i - w] = next;
        stack[sp++] = i - w;
      }
      if (y < h - 1 && bin[i + w] && labels[i + w] === -1) {
        labels[i + w] = next;
        stack[sp++] = i + w;
      }
    }
    sizes.push(size);
    next++;
  }
  return { labels, sizes };
}

function segmentPass(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number,
): Cutout {
  const n = width * height;

  const edge = sobel(rgba, width, height);
  const EDGE_STRONG = 60;

  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.06));
  const maxSamples = Math.ceil(width / 2) * Math.ceil(ring / 2) * 2 * 2 + Math.ceil((height - 2 * ring) / 2) * Math.ceil(ring / 2) * 2 * 2;
  const samples = new Uint32Array(maxSamples);
  let sc = 0;
  const addSample = (x: number, y: number) => {
    if (sc >= maxSamples) return;
    const p = (y * width + x) * 4;
    samples[sc++] = ((rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]) >>> 0;
  };
  for (let x = 0; x < width; x += 2) {
    for (let t = 0; t < ring; t += 2) {
      addSample(x, t);
      addSample(x, height - 1 - t);
    }
  }
  for (let y = ring; y < height - ring; y += 2) {
    for (let t = 0; t < ring; t += 2) {
      addSample(t, y);
      addSample(width - 1 - t, y);
    }
  }
  const bgCenters = kmeans(sc, samples, 4);

  const scale: [number, number, number] = [12, 12, 12];
  {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (const [r, g, b] of bgCenters) {

      sr += r;
      sg += g;
      sb += b;
    }
    const mr = sr / bgCenters.length;
    const mg = sg / bgCenters.length;
    const mb = sb / bgCenters.length;
    let vr = 0;
    let vg = 0;
    let vb = 0;
    for (const [r, g, b] of bgCenters) {
      vr += (r - mr) ** 2;
      vg += (g - mg) ** 2;
      vb += (b - mb) ** 2;
    }

    scale[0] = Math.max(8, Math.sqrt(vr / bgCenters.length) * 0.75 + 6);
    scale[1] = Math.max(8, Math.sqrt(vg / bgCenters.length) * 0.75 + 6);
    scale[2] = Math.max(8, Math.sqrt(vb / bgCenters.length) * 0.75 + 6);
  }

  const flood = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const seeds = new Set<number>();
  const step = Math.max(2, Math.round(Math.min(width, height) / 24));
  for (let x = 0; x < width; x += step) {
    seeds.add(x);
    seeds.add((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += step) {
    seeds.add(y * width);
    seeds.add(y * width + width - 1);
  }
  for (const s of seeds) {
    if (!flood[s]) {
      flood[s] = 1;
      stack[sp++] = s;
    }
  }

  const touchedEdges = new Set<number>();

  const cutoff = tolerance / 12;
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % width;
    const y = (i / width) | 0;
    if (x === 0) touchedEdges.add(1);
    if (y === 0) touchedEdges.add(2);
    if (x === width - 1) touchedEdges.add(3);
    if (y === height - 1) touchedEdges.add(4);
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (flood[j]) continue;
      if (edge[j] > EDGE_STRONG) continue;
      const q = j * 4;
      const dist = bgDistance(rgba[q], rgba[q + 1], rgba[q + 2], bgCenters, scale);

      const edgeDamp = 1 - Math.min(1, edge[j] / EDGE_STRONG) * 0.65;
      if (dist <= cutoff * edgeDamp) {
        flood[j] = 1;
        stack[sp++] = j;
      }
    }
  }

  const fg0 = new Uint8Array(n);
  for (let i = 0; i < n; i++) fg0[i] = flood[i] ? 0 : 1;

  const shaveCutoff = cutoff * 0.5;
  const shaved = new Uint8Array(fg0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!fg0[i]) continue;
      const touchesBg =
        (x > 0 && !fg0[i - 1]) ||
        (x < width - 1 && !fg0[i + 1]) ||
        (y > 0 && !fg0[i - width]) ||
        (y < height - 1 && !fg0[i + width]);
      if (!touchesBg) continue;
      const p = i * 4;
      if (bgDistance(rgba[p], rgba[p + 1], rgba[p + 2], bgCenters, scale) < shaveCutoff) {
        shaved[i] = 0;
      }
    }
  }

  const opened = boxDilate(boxErode(shaved, width, height, 1), width, height, 1);
  const { labels, sizes } = components(opened, width, height);
  const minSize = Math.max(24, n * 0.004);
  const compCount = sizes.length;

  const compArea = new Float64Array(compCount);
  const compSumX = new Float64Array(compCount);
  const compSumY = new Float64Array(compCount);
  const compMinX = new Int32Array(compCount).fill(width);
  const compMinY = new Int32Array(compCount).fill(height);
  const compMaxX = new Int32Array(compCount).fill(-1);
  const compMaxY = new Int32Array(compCount).fill(-1);
  const compBorder = new Float64Array(compCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const l = labels[i];
      if (l < 0) continue;
      compArea[l]++;
      compSumX[l] += x;
      compSumY[l] += y;
      if (x < compMinX[l]) compMinX[l] = x;
      if (y < compMinY[l]) compMinY[l] = y;
      if (x > compMaxX[l]) compMaxX[l] = x;
      if (y > compMaxY[l]) compMaxY[l] = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) compBorder[l]++;
    }
  }

  const maxDist = Math.hypot(width, height) / 2;
  const scoreOf = (c: number): number => {
    const af = compArea[c] / n;

    const sizeScore = af >= 0.85 ? 0.15 : Math.min(1, af / 0.18);
    const ccx = compSumX[c] / compArea[c];
    const ccy = compSumY[c] / compArea[c];
    const centrality = 1 - Math.hypot(ccx - width / 2, ccy - height / 2) / maxDist;
    const borderFrac = compArea[c] > 0 ? compBorder[c] / compArea[c] : 1;
    return 0.55 * sizeScore + 0.3 * Math.max(0, centrality) + 0.15 * (1 - borderFrac);
  };

  const keep = new Uint8Array(compCount);
  for (let c = 0; c < compCount; c++) {
    keep[c] = sizes[c] >= minSize ? 1 : 0;
  }

  if (keep.every((v) => v === 0) && compCount > 0) {
    let big = 0;
    for (let c = 1; c < compCount; c++) if (sizes[c] > sizes[big]) big = c;
    keep[big] = 1;
  }

  const ranked: number[] = [];
  for (let c = 0; c < compCount; c++) if (keep[c]) ranked.push(c);
  ranked.sort((a, b) => scoreOf(b) - scoreOf(a));
  const candidates: DetectedObject[] = ranked.slice(0, 4).map((c) => ({
    box: { x: compMinX[c], y: compMinY[c], w: compMaxX[c] - compMinX[c] + 1, h: compMaxY[c] - compMinY[c] + 1 },
    area: compArea[c],
    score: scoreOf(c),
  }));
  const primary = ranked.length > 0 ? ranked[0] : -1;

  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    fg[i] = l >= 0 && keep[l] ? 1 : 0;
  }

  const closedPair = boxErode(boxDilate(fg, width, height, 1), width, height, 1);
  const filled = fillHoles(closedPair, width, height);

  const alpha = new Uint8ClampedArray(n * 4);
  let softPixels = 0;
  const sd = signedDistance(filled, width, height);

  let br = 0;
  let bg2 = 0;
  let bb = 0;
  let bcount = 0;
  for (let i = 0; i < n; i++) {
    if (!filled[i]) {
      const p = i * 4;
      br += rgba[p];
      bg2 += rgba[p + 1];
      bb += rgba[p + 2];
      bcount++;
    }
  }
  bcount = Math.max(1, bcount);
  const bgMean = [br / bcount, bg2 / bcount, bb / bcount];

  const sdGradX = new Float32Array(n);
  const sdGradY = new Float32Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      sdGradX[i] = sd[i + 1] - sd[i - 1];
      sdGradY[i] = sd[i + width] - sd[i - width];
    }
  }

  for (let i = 0; i < n; i++) {
    const d = sd[i];

    const ec = Math.min(1, edge[i] / 255);
    const band = 1 + (1 - ec) * 1.5;
    let a: number;
    if (d <= -band) {
      a = 255;
    } else if (d >= band) {
      a = 0;
    } else {
      const t = (d + band) / (2 * band);
      a = Math.round(255 * (1 - t));
      a = clamp255(a + (filled[i] ? ec * 20 : 0));
      softPixels++;
    }
    const p = i * 4;

    let or_ = rgba[p];
    let og = rgba[p + 1];
    let ob = rgba[p + 2];
    if (a > 0 && a < 255) {
      const x = i % width;
      const y = (i / width) | 0;
      const gl = Math.hypot(sdGradX[i], sdGradY[i]) || 1;

      const stepIn = 2;
      const ix = Math.round(Math.max(0, Math.min(width - 1, x + (sdGradX[i] / gl) * -stepIn)));
      const iy = Math.round(Math.max(0, Math.min(height - 1, y + (sdGradY[i] / gl) * -stepIn)));
      const ip = (iy * width + ix) * 4;
      const pr = rgba[ip];
      const pg = rgba[ip + 1];
      const pb = rgba[ip + 2];
      const mix = a / 255;

      const inv = 1 / Math.max(0.25, mix);
      const estR = bgMean[0] + (or_ - bgMean[0]) * inv;
      const estG = bgMean[1] + (og - bgMean[1]) * inv;
      const estB = bgMean[2] + (ob - bgMean[2]) * inv;

      const wIn = 0.45;
      or_ = clamp255((estR * (1 - wIn) + pr * wIn) * 0.35 + or_ * 0.65);
      og = clamp255((estG * (1 - wIn) + pg * wIn) * 0.35 + og * 0.65);
      ob = clamp255((estB * (1 - wIn) + pb * wIn) * 0.35 + ob * 0.65);
    }

    alpha[p] = or_;
    alpha[p + 1] = og;
    alpha[p + 2] = ob;
    alpha[p + 3] = a;
  }

  let sepSum = 0;
  let sepCount = 0;
  for (let i = 0; i < n; i += 7) {
    if (!filled[i]) continue;
    const p = i * 4;
    let best = Infinity;
    for (const [cr, cg, cb] of bgCenters) {
      const dr = rgba[p] - cr;
      const dg = rgba[p + 1] - cg;
      const db = rgba[p + 2] - cb;
      const d = Math.sqrt(dr * dr + dg * dg + db * db);
      if (d < best) best = d;
    }
    sepSum += best;
    sepCount++;
  }
  const rawSep = sepCount > 0 ? Math.min(1, sepSum / sepCount / 120) : 0;

  let sepSum2 = 0;
  for (let i = 0; i < n; i += 7) {
    if (!filled[i]) continue;
    const p = i * 4;
    sepSum2 += bgDistance(rgba[p], rgba[p + 1], rgba[p + 2], bgCenters, scale);
  }
  const separation = sepCount > 0 ? Math.min(1, (sepSum2 / sepCount) / 4) : 0;

  let contourHits = 0;
  let contourTotal = 0;
  for (let i = 0; i < n; i++) {
    if (filled[i]) continue;
    const x = i % width;
    const y = (i / width) | 0;
    let adjacent = false;
    if (x > 0 && filled[i - 1]) adjacent = true;
    else if (x < width - 1 && filled[i + 1]) adjacent = true;
    else if (y > 0 && filled[i - width]) adjacent = true;
    else if (y < height - 1 && filled[i + width]) adjacent = true;
    if (!adjacent) continue;
    contourTotal++;
    if (edge[i] > 24) contourHits++;
  }
  const edgeSupport = contourTotal > 0 ? contourHits / contourTotal : 0;

  let area = 0;
  for (let i = 0; i < n; i++) if (filled[i]) area++;
  const compactness = area > 0 ? Math.min(1, (4 * Math.PI * area) / (contourTotal * contourTotal + 1)) : 0;

  const confidence = Math.max(
    0,
    Math.min(
      1,
      0.35 * rawSep +
        0.3 * edgeSupport +
        0.2 * separation +
        0.15 * Math.min(1, compactness),
    ),
  );

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  if (primary >= 0) {
    minX = compMinX[primary];
    minY = compMinY[primary];
    maxX = compMaxX[primary];
    maxY = compMaxY[primary];
  } else {
    for (let i = 0; i < n; i++) {
      if (alpha[i * 4 + 3] > 8) {
        const x = i % width;
        const y = (i / width) | 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    minX = 0;
    minY = 0;
    maxX = width - 1;
    maxY = height - 1;
  }

  return {
    alpha,
    width,
    height,
    softPixels,
    touchedEdges,
    box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    candidates,
    confidence,
  };
}

export function segment(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts: SegmentOptions = {},
): Cutout {
  const tolerance = opts.tolerance ?? 26;

  const first = segmentPass(rgba, width, height, tolerance);
  if (opts.noRetry) return first;

  const areaFrac =
    (first.box.w * first.box.h) / (width * height);

  if (first.box.w > width * 0.97 && first.box.h > height * 0.97) {

    const tighter = segmentPass(
      rgba,
      width,
      height,
      Math.max(10, tolerance * 0.55),
    );
    const tighterFrac = (tighter.box.w * tighter.box.h) / (width * height);
    if (tighterFrac < 0.9 && tighter.confidence >= first.confidence * 0.8) return tighter;
    return first;
  }

  if (areaFrac < 0.005) {
    const looser = segmentPass(
      rgba,
      width,
      height,
      Math.min(60, tolerance * 1.8),
    );
    const looserFrac = (looser.box.w * looser.box.h) / (width * height);
    if (looserFrac > areaFrac * 2 && looserFrac < 0.92) return looser;
    return first;
  }

  if (first.confidence < 0.35) {
    const tighter = segmentPass(
      rgba,
      width,
      height,
      Math.max(10, tolerance * 0.7),
    );
    const looser = segmentPass(
      rgba,
      width,
      height,
      Math.min(60, tolerance * 1.4),
    );
    const best = [first, tighter, looser].reduce((a, b) =>
      b.confidence > a.confidence ? b : a,
    );
    return best;
  }

  return first;
}
