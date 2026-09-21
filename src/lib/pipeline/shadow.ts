import type { Cutout } from "./segment";
import { boxBlur3, distanceInside, distanceOutside, mulberry32 } from "./pixels";

export type ShadowOptions = {
  direction: number;
  length: number;
  softness: number;
  opacity: number;
  contact: boolean;
};

export const DEFAULT_SHADOW: ShadowOptions = {
  direction: 55,
  length: 0.7,
  softness: 0.6,
  opacity: 0.42,
  contact: true,
};

export const SHADOW_RGB: readonly [number, number, number] = [24, 26, 30];

export function toneMapShadow(
  intensity: Float32Array,
  canvasW: number,
  canvasH: number,
  opts: ShadowOptions,
): Uint8ClampedArray {
  const n = canvasW * canvasH;
  const mask = new Uint8ClampedArray(n);
  const op = Math.max(0, Math.min(1, opts.opacity));
  for (let i = 0; i < n; i++) {
    let v = intensity[i] * op;
    if (v > 0) {
      v = Math.pow(Math.min(1, v), 1.15);
      mask[i] = Math.round(v * 255);
    }
  }
  return mask;
}

export function renderShadowIntensity(
  cutout: Cutout,
  place: { x: number; y: number; scale: number },
  canvasW: number,
  canvasH: number,
  opts: ShadowOptions,
): Float32Array {
  const n = canvasW * canvasH;
  const intensity = new Float32Array(n);

  const sil = new Uint8Array(n);
  const { alpha, width: cw, height: ch, box } = cutout;
  const drawW = Math.max(1, Math.round(box.w * place.scale));
  const drawH = Math.max(1, Math.round(box.h * place.scale));
  const baseX = Math.round(place.x - (box.x + box.w / 2) * place.scale);
  const baseY = Math.round(place.y - (box.y + box.h / 2) * place.scale);
  const silList: number[] = [];
  for (let dy = 0; dy < drawH; dy++) {
    const sy = box.y + Math.min(ch - 1, Math.floor(dy / place.scale));
    for (let dx = 0; dx < drawW; dx++) {
      const sx = box.x + Math.min(cw - 1, Math.floor(dx / place.scale));
      if (alpha[(sy * cw + sx) * 4 + 3] > 60) {
        const px = baseX + dx;
        const py = baseY + dy;
        if (px >= 0 && py >= 0 && px < canvasW && py < canvasH) {
          const j = py * canvasW + px;
          if (!sil[j]) {
            sil[j] = 1;
            silList.push(j);
          }
        }
      }
    }
  }
  if (silList.length === 0) return intensity;

  const longest = Math.max(box.w, box.h) * place.scale;

  const travel = longest * opts.length;
  const cast = new Float32Array(n);
  if (travel > 0.5) {
    const rad = (opts.direction * Math.PI) / 180;

    const dirX = -Math.cos(rad);
    const dirY = Math.sin(rad) * 0.85;

    const steps = Math.max(10, Math.round(40 * (0.45 + opts.length)));

    const rng = mulberry32(0x9e3779b9);
    const phase1 = rng() * Math.PI * 2;
    const phase2 = rng() * Math.PI * 2;

    let wSum = 0;
    const weights = new Float32Array(steps);
    for (let s = 0; s < steps; s++) {
      const t = (s + 1) / steps;
      weights[s] = Math.pow(1 - t, 1.6);
      wSum += weights[s];
    }

    const dilLists: number[][] = [silList];
    let prev: Uint8Array = sil;
    for (let r = 1; r <= 3; r++) {
      const next = boxDilate8(prev, canvasW, canvasH);
      const list: number[] = [];
      for (let i = 0; i < n; i++) if (next[i]) list.push(i);
      dilLists.push(list);
      prev = next;
    }

    for (let s = 0; s < steps; s++) {
      const t = (s + 1) / steps;
      const dist = travel * t;
      const w = weights[s];

      const jx = 0.5 * Math.sin(phase1 + t * 6.1) + 0.3 * Math.sin(phase2 + t * 13.7);
      const ox = dirX * dist + jx * longest * 0.02;
      const oy = dirY * dist;
      const level = Math.min(3, Math.floor(t * 4));
      stampWeighted(dilLists[level], canvasW, canvasH, ox, oy, w, cast);
    }
    if (wSum > 0) for (let i = 0; i < n; i++) cast[i] /= wSum;
  }

  let sharedOutside: Float32Array | null = null;
  const getOutside = () => (sharedOutside ??= distanceOutside(sil, canvasW, canvasH));

  let castSoft = cast;
  if (travel > 0.5) {
    const rNear = Math.max(1, Math.round(longest * 0.012));
    const rFar = Math.max(rNear + 1, Math.round(longest * (0.02 + 0.1 * opts.softness)));
    const tight = boxBlur3(cast, canvasW, canvasH, rNear);
    const soft = boxBlur3(cast, canvasW, canvasH, Math.min(rFar, 40));

    const dOut = getOutside();
    const reach = Math.max(1, longest * (0.12 + 0.5 * opts.softness));
    castSoft = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = dOut[i] / reach;
      if (m > 1) m = 1;
      const sm = m * m * (3 - 2 * m);
      castSoft[i] = tight[i] * (1 - sm) + soft[i] * sm;
    }
  }

  const ao = new Float32Array(n);
  if (opts.contact) {
    const inner = distanceInside(sil, canvasW, canvasH);
    const outside = getOutside();
    const band = 3 + 5 * opts.softness;
    const ampOut = 0.32 * (0.75 + 0.25 * opts.softness);
    const ampIn = 0.4;
    for (let i = 0; i < n; i++) {
      if (sil[i]) {
        const crevice = Math.max(0, 5 - inner[i]) / 5;
        ao[i] = ampIn * crevice;
      } else {
        const d = outside[i];
        if (d < band) {
          const t = 1 - d / band;
          ao[i] = ampOut * t * t;
        }
      }
    }
  }

  for (let i = 0; i < n; i++) {
    intensity[i] = Math.max(castSoft[i], ao[i]);
  }

  return intensity;
}

export function renderShadow(
  cutout: Cutout,
  place: { x: number; y: number; scale: number },
  canvasW: number,
  canvasH: number,
  opts: ShadowOptions,
): Uint8ClampedArray {
  return toneMapShadow(
    renderShadowIntensity(cutout, place, canvasW, canvasH, opts),
    canvasW,
    canvasH,
    opts,
  );
}

export function shadowRgba(
  mask: Uint8ClampedArray,
  w: number,
  h: number,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const rgba = out ?? new Uint8ClampedArray(w * h * 4);
  const [sr, sg, sb] = SHADOW_RGB;
  for (let i = 0; i < w * h; i++) {
    const a = mask[i];
    const p = i * 4;
    if (a === 0) {
      rgba[p] = 0;
      rgba[p + 1] = 0;
      rgba[p + 2] = 0;
      rgba[p + 3] = 0;
      continue;
    }
    rgba[p] = sr;
    rgba[p + 1] = sg;
    rgba[p + 2] = sb;
    rgba[p + 3] = a;
  }
  return rgba;
}

let maskCanvas: HTMLCanvasElement | null = null;

export function paintShadow(
  ctx: CanvasRenderingContext2D,
  mask: Uint8ClampedArray,
  w: number,
  h: number,
) {
  if (!maskCanvas) maskCanvas = document.createElement("canvas");
  if (maskCanvas.width !== w || maskCanvas.height !== h) {
    maskCanvas.width = w;
    maskCanvas.height = h;
  }
  const mctx = maskCanvas.getContext("2d")!;
  const img = mctx.createImageData(w, h);
  shadowRgba(mask, w, h, img.data);
  mctx.putImageData(img, 0, 0);
  ctx.drawImage(maskCanvas, 0, 0);
}

function stampWeighted(
  list: number[],
  w: number,
  h: number,
  ox: number,
  oy: number,
  weight: number,
  dst: Float32Array,
) {
  const ioX = Math.round(ox);
  const ioY = Math.round(oy);
  if (ioX === 0 && ioY === 0) {
    for (let k = 0; k < list.length; k++) dst[list[k]] += weight;
    return;
  }
  for (let k = 0; k < list.length; k++) {
    const i = list[k];
    const x = (i % w) + ioX;
    if (x < 0 || x >= w) continue;
    const y = ((i / w) | 0) + ioY;
    if (y < 0 || y >= h) continue;
    dst[y * w + x] += weight;
  }
}

function boxDilate8(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i]) {
        out[i] = 1;
        continue;
      }
      if (
        (x > 0 && src[i - 1]) ||
        (x < w - 1 && src[i + 1]) ||
        (y > 0 && src[i - w]) ||
        (y < h - 1 && src[i + w]) ||
        (x > 0 && y > 0 && src[i - w - 1]) ||
        (x < w - 1 && y > 0 && src[i - w + 1]) ||
        (x > 0 && y < h - 1 && src[i + w - 1]) ||
        (x < w - 1 && y < h - 1 && src[i + w + 1])
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}
