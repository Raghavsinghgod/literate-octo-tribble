

import type { BackdropId } from "./banner";

import type { Cutout } from "./segment";
import { DEFAULT_SHADOW, type ShadowOptions } from "./shadow";

export type StyleAnalysis = {
  palette: string[];
  tone: number;
  contrast: number;
  saturation: number;
  glossy: number;
  softGoods: boolean;
  category: string;

  temperature: number;

  solidity: number;

  elongation: number;

  intricacy: number;

  sheen: number;
};

export type OutputStyleId = "pure-white" | "white-shadow" | "premium-desk" | "studio" | "moody";

export type StyleDef = {
  id: OutputStyleId;
  label: string;
  blurb: string;
  backdrop: BackdropId;
  shadow: ShadowOptions;

  shadows: boolean;
};

export const OUTPUT_STYLES: StyleDef[] = [
  {
    id: "pure-white",
    label: "Pure white",
    blurb: "100% product on pure white — no shadow at all.",
    backdrop: "paper",
    shadow: DEFAULT_SHADOW,
    shadows: false,
  },
  {
    id: "white-shadow",
    label: "White + shadow",
    blurb: "Marketplace white with our signature soft contact + cast shadow.",
    backdrop: "paper",
    shadow: { direction: 55, length: 0.55, softness: 0.7, opacity: 0.34, contact: true },
    shadows: true,
  },
  {
    id: "premium-desk",
    label: "Premium desk",
    blurb: "Warm walnut desk, soft falloff, grounded cast — editorial look.",
    backdrop: "walnut",
    shadow: { direction: 50, length: 0.8, softness: 0.55, opacity: 0.46, contact: true },
    shadows: true,
  },
  {
    id: "studio",
    label: "Studio",
    blurb: "Cool grey gradient, big soft ring — catalog classic.",
    backdrop: "studio",
    shadow: { direction: 55, length: 0.65, softness: 0.75, opacity: 0.38, contact: true },
    shadows: true,
  },
  {
    id: "moody",
    label: "Moody",
    blurb: "Charcoal stage, hard directional light, deep cast.",
    backdrop: "charcoal",
    shadow: { direction: 115, length: 0.9, softness: 0.35, opacity: 0.55, contact: true },
    shadows: true,
  },
];

export function getStyle(id: OutputStyleId): StyleDef {
  return OUTPUT_STYLES.find((s) => s.id === id) ?? OUTPUT_STYLES[0];
}

function srgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function lum(r: number, g: number, b: number): number {

  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function chroma(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

function isSkinish(r: number, g: number, b: number): boolean {

  const l = lum(r, g, b);
  const c = chroma(r, g, b);
  return r > g && g > b && c > 0.08 && c < 0.55 && l > 0.2 && l < 0.9;
}

function kmeansPalette(
  samples: Array<[number, number, number]>,
  k: number,
): Array<[number, number, number]> {
  if (samples.length === 0) return [[255, 255, 255]];
  if (samples.length <= k) return samples.slice();

  const centers: Array<[number, number, number]> = [samples[Math.floor(samples.length / 2)]];
  while (centers.length < k) {
    let best: [number, number, number] = samples[0];
    let bestD = -1;
    for (let i = 0; i < samples.length; i += Math.max(1, samples.length >> 6)) {
      const s = samples[i];
      let d = Infinity;
      for (const c of centers) {
        const dr = s[0] - c[0];
        const dg = s[1] - c[1];
        const db = s[2] - c[2];
        d = Math.min(d, dr * dr + dg * dg + db * db);
      }
      if (d > bestD) {
        bestD = d;
        best = s;
      }
    }
    centers.push(best);
  }

  const assign = new Uint8Array(samples.length);
  for (let iter = 0; iter < 8; iter++) {
    let moved = false;
    for (let i = 0; i < samples.length; i++) {
      const [r, g, b] = samples[i];
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
    for (let i = 0; i < samples.length; i++) {
      const a = sums[assign[i]];
      a[0] += samples[i][0];
      a[1] += samples[i][1];
      a[2] += samples[i][2];
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

export function analyzeCutout(cutout: Cutout): StyleAnalysis {
  const { alpha, width: w, height: h } = cutout;

  const samples: Array<[number, number, number]> = [];
  let sumL = 0;
  let sumL2 = 0;
  let sumC = 0;
  let count = 0;
  let skinCount = 0;
  let glossyHits = 0;
  let edgeHits = 0;
  let edgeTotal = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = alpha[i * 4 + 3];
      if (a < 128) continue;
      const r = alpha[i * 4];
      const g = alpha[i * 4 + 1];
      const b = alpha[i * 4 + 2];
      const l = lum(r, g, b);
      sumL += l;
      sumL2 += l * l;
      sumC += chroma(r, g, b);
      count++;
      if (isSkinish(r, g, b)) skinCount++;
      if (l > 0.93) glossyHits++;
      if ((x & 3) === 0 && (y & 3) === 0) {
        samples.push([r, g, b]);
        edgeHits += l > 0.92 ? 1 : 0;
        edgeTotal++;
      }
    }
  }

  count = Math.max(1, count);
  const tone = sumL / count;
  const contrast = Math.sqrt(Math.max(0, sumL2 / count - tone * tone));
  const saturation = sumC / count;
  const glossy = Math.min(1, (glossyHits / count) * 6);
  const softGoods = skinCount / count > 0.25;

  const palette = kmeansPalette(samples, 4).map(([r, g, b]) => srgbToHex(r, g, b));

  const category = softGoods
    ? "Soft goods / apparel"
    : glossy > 0.35
      ? "Hard goods / glossy"
      : tone < 0.35
        ? "Dark product"
        : "General product";

  let tempSum = 0;
  let tempCount = 0;
  let sheenHits = 0;
  for (const [r, g, b] of samples) {
    const l = lum(r, g, b);
    const c = chroma(r, g, b);
    if (c > 0.08) {
      tempSum += (r - b) / (l + 0.05);
      tempCount++;
    }
    if (l > 0.93) sheenHits++;
  }
  const temperature = tempCount > 0 ? Math.max(-1, Math.min(1, (tempSum / tempCount) * 1.2)) : 0;
  const sheen = sheenHits / Math.max(1, samples.length);

  const { box } = cutout;
  const boxArea = Math.max(1, box.w * box.h);
  let alphaArea = 0;
  for (let y = box.y; y < Math.min(h, box.y + box.h); y++) {
    for (let x = box.x; x < Math.min(w, box.x + box.w); x++) {
      if (alpha[(y * w + x) * 4 + 3] > 128) alphaArea++;
    }
  }
  const solidity = Math.min(1, alphaArea / boxArea);

  const aspect = Math.max(box.w, box.h) / Math.max(1, Math.min(box.w, box.h));
  const elongation = Math.min(1, (aspect - 1) / 2);

  let transitions = 0;
  for (let y = box.y; y < Math.min(h, box.y + box.h); y++) {
    let prev = false;
    for (let x = box.x; x < Math.min(w, box.x + box.w); x++) {
      const cur = alpha[(y * w + x) * 4 + 3] > 128;
      if (cur !== prev) transitions++;
      prev = cur;
    }
  }
  const intricacy = Math.min(1, transitions / Math.max(1, alphaArea * 0.12));

  return {
    palette, tone, contrast, saturation, glossy, softGoods, category,
    temperature, solidity, elongation, intricacy, sheen,
  };
}

export function recommendStyles(a: StyleAnalysis): OutputStyleId[] {
  const score = new Map<OutputStyleId, number>([
    ["pure-white", 2.2],
    ["white-shadow", 2.6],
    ["premium-desk", 1.6],
    ["studio", 1.8],
    ["moody", 0.8],
  ]);

  if (a.tone > 0.55) {
    score.set("pure-white", score.get("pure-white")! + 0.8);
    score.set("white-shadow", score.get("white-shadow")! + 0.6);
    score.set("moody", score.get("moody")! - 0.4);
  } else if (a.tone < 0.35) {
    score.set("moody", score.get("moody")! + 1.1);
    score.set("premium-desk", score.get("premium-desk")! + 0.5);
    score.set("pure-white", score.get("pure-white")! - 0.6);
  }

  if (a.glossy > 0.3) {
    score.set("white-shadow", score.get("white-shadow")! + 0.35);
    score.set("studio", score.get("studio")! + 0.35);
  }

  if (a.softGoods) {
    score.set("premium-desk", score.get("premium-desk")! + 0.7);
    score.set("pure-white", score.get("pure-white")! + 0.2);
  }

  if (a.saturation > 0.45) {
    score.set("pure-white", score.get("pure-white")! + 0.3);
    score.set("moody", score.get("moody")! - 0.3);
  }

  return [...score.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
}
